// Чанковый рендерер модульного строительства на базе THREE.InstancedMesh
// и генератор статических физических коллайдеров Rapier 3D.
// На каждый тип модуля (PieceType) внутри строительного чанка (8×8 клеток)
// создается один InstancedMesh (тысячи стен/фундаментов за минимум draw calls).
// При изменении мира пересобирается только затронутый чанк.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
    BUILDING_CHUNK_SIZE,
    CEILING_THICK,
    FOUND_HEIGHT,
    MODULE_DEPTH,
    MODULE_WIDTH,
    PIECE_CATALOG,
    PIECE_ORDER,
    WALL_HEIGHT,
    WALL_THICK,
    chunkKeyForCell,
    getPieceWorldTransform,
    parseCellKey,
    rotateVec2D
} from './catalog.ts';
import {
    getBakedDoorFrameAsset,
    getBakedDoorLeafAsset,
    getBakedPrefabAsset
} from './prefabs.ts';
import type { World } from './buildingWorld.ts';
import type { GridCell, Piece, PieceType } from './types.ts';

export interface InstanceRecord {
    cell: GridCell;
    piece: Piece;
}

interface DoorLeafInstance {
    record: InstanceRecord;
    leafIndex: number;
    basePos: { x: number; y: number; z: number };
    rotationY: number;
    quat: { x: number; y: number; z: number; w: number };
    collider: RAPIER.Collider | null;
}

interface ChunkRenderData {
    key: string;
    group: THREE.Group;
    meshesByType: Map<PieceType, THREE.InstancedMesh>;
    recordsByType: Map<PieceType, InstanceRecord[]>;
    doorLeavesMesh: THREE.InstancedMesh | null;
    doorLeaves: DoorLeafInstance[];
    rigidBody: RAPIER.RigidBody | null;
}

// Цветовая тонировка уровней укрепления (tier 0..2):
// tier 0: Ржавый утиль (Scrap), tier 1: Пустынная броня (Standard), tier 2: Бункерная сталь (Reinforced)
const TIER_TINTS: Record<number, THREE.Color> = {
    0: new THREE.Color(0xd99b72),
    1: new THREE.Color(0xffffff),
    2: new THREE.Color(0xc2d6e8)
};

// Смещение открытой створки гермодвери вбок в паз стены (м)
const DOOR_SLIDE_DISTANCE = 1.18;
// Скорость хода гидропривода гермодвери (ед./с)
const DOOR_OPEN_SPEED = 2.6;

export class BuildingChunkRenderer {
    public readonly rootGroup = new THREE.Group();
    private readonly world: World;
    private readonly physicsWorld: RAPIER.World | null;
    private readonly isSoftwareGl: boolean;
    private readonly chunks = new Map<string, ChunkRenderData>();
    private readonly meshToChunk = new Map<THREE.InstancedMesh, { chunkKey: string; type: PieceType }>();
    private rebuildCounter = 0;

    constructor(world: World, physicsWorld: RAPIER.World | null = null, isSoftwareGl = false) {
        this.world = world;
        this.physicsWorld = physicsWorld;
        this.isSoftwareGl = isSoftwareGl;
        this.rootGroup.name = 'BuildingChunkRoot';
    }

    public getChunkCount(): number {
        return this.chunks.size;
    }

    public getRebuildCount(): number {
        return this.rebuildCounter;
    }

    public getInstancedMeshCount(): number {
        let total = 0;
        for (const chunk of this.chunks.values()) {
            total += chunk.meshesByType.size;
        }
        return total;
    }

    // Возвращает все активные InstancedMesh для Raycaster (включая подвижные створки дверей)
    public getPickableMeshes(): THREE.InstancedMesh[] {
        const list: THREE.InstancedMesh[] = [];
        for (const chunk of this.chunks.values()) {
            for (const mesh of chunk.meshesByType.values()) {
                if (mesh.count > 0) {
                    list.push(mesh);
                }
            }
            if (chunk.doorLeavesMesh && chunk.doorLeavesMesh.count > 0) {
                list.push(chunk.doorLeavesMesh);
            }
        }
        return list;
    }

    // По попаданию Raycaster в (mesh, instanceId) возвращает точную клетку и элемент Piece
    public resolveInstanceHit(
        object: THREE.Object3D,
        instanceId: number | undefined
    ): InstanceRecord | null {
        if (instanceId === undefined || instanceId < 0) return null;
        const meta = this.meshToChunk.get(object as THREE.InstancedMesh);
        if (!meta) return null;
        const chunk = this.chunks.get(meta.chunkKey);
        if (!chunk) return null;
        const records = chunk.recordsByType.get(meta.type);
        if (!records || instanceId >= records.length) return null;
        return records[instanceId];
    }

    // Пересобирает только измененные (dirty) чанки
    public syncDirtyChunks(): number {
        const dirty = this.world.getDirtyChunks();
        if (dirty.length === 0) return 0;

        for (const chunkKey of dirty) {
            this.rebuildChunk(chunkKey);
            this.world.clearDirtyChunk(chunkKey);
        }
        return dirty.length;
    }

    // Плавно анимирует открытие/закрытие створок гермодверей и обновляет их физические коллайдеры
    public updateDoors(dt: number): void {
        if (dt <= 0) return;
        const dummyMatrix = new THREE.Matrix4();
        const dummyPos = new THREE.Vector3();
        const dummyQuat = new THREE.Quaternion();
        const dummyScale = new THREE.Vector3(1, 1, 1);
        const yAxis = new THREE.Vector3(0, 1, 0);

        for (const chunk of this.chunks.values()) {
            if (!chunk.doorLeavesMesh || chunk.doorLeaves.length === 0) continue;
            let matrixDirty = false;

            for (const leaf of chunk.doorLeaves) {
                const { piece } = leaf.record;
                const target = piece.isOpen ? 1.0 : 0.0;
                const current = typeof piece.openProgress === 'number' ? piece.openProgress : (piece.isOpen ? 1.0 : 0.0);

                if (Math.abs(target - current) > 1e-4) {
                    const step = DOOR_OPEN_SPEED * dt;
                    const next = current < target
                        ? Math.min(target, current + step)
                        : Math.max(target, current - step);
                    piece.openProgress = next;
                    this.applyDoorLeafTransform(chunk.doorLeavesMesh, leaf, next, dummyMatrix, dummyPos, dummyQuat, dummyScale, yAxis);
                    matrixDirty = true;
                } else if (piece.openProgress !== target) {
                    piece.openProgress = target;
                    this.applyDoorLeafTransform(chunk.doorLeavesMesh, leaf, target, dummyMatrix, dummyPos, dummyQuat, dummyScale, yAxis);
                    matrixDirty = true;
                }
            }

            if (matrixDirty) {
                chunk.doorLeavesMesh.instanceMatrix.needsUpdate = true;
            }
        }
    }

    private applyDoorLeafTransform(
        mesh: THREE.InstancedMesh,
        leaf: DoorLeafInstance,
        progress: number,
        dummyMatrix: THREE.Matrix4,
        dummyPos: THREE.Vector3,
        dummyQuat: THREE.Quaternion,
        dummyScale: THREE.Vector3,
        yAxis: THREE.Vector3
    ): void {
        // Плавная кривая хода гидропривода (smoothstep)
        const t = THREE.MathUtils.clamp(progress, 0, 1);
        const smooth = t * t * (3 - 2 * t);
        // При открытии створка уходит влево внутрь бронестены (-X в локальных координатах двери)
        const slideOffset = rotateVec2D(-DOOR_SLIDE_DISTANCE * smooth, 0, leaf.record.piece.rot);

        const wx = leaf.basePos.x + slideOffset.x;
        const wy = leaf.basePos.y;
        const wz = leaf.basePos.z + slideOffset.z;

        dummyPos.set(wx, wy, wz);
        dummyQuat.setFromAxisAngle(yAxis, leaf.rotationY);
        dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
        mesh.setMatrixAt(leaf.leafIndex, dummyMatrix);

        if (leaf.collider) {
            const isOpenNow = Boolean(leaf.record.piece.isOpen) ? t >= 0.20 : t >= 0.65;
            leaf.collider.setSensor(isOpenNow);
            const targetPos = isOpenNow
                ? { x: wx, y: leaf.basePos.y - 20.0, z: wz }
                : { x: wx, y: leaf.basePos.y + 1.18, z: wz };
            if (typeof (leaf.collider as any).setTranslationWrtParent === 'function') {
                (leaf.collider as any).setTranslationWrtParent(targetPos);
            }
            leaf.collider.setTranslation(targetPos);
        }
    }

    // Пересобирает один конкретный чанк по его ключу "cx,cz"
    public rebuildChunk(chunkKey: string): void {
        this.rebuildCounter++;

        // 1. Удаляем старые меши и физические тела чанка
        const existing = this.chunks.get(chunkKey);
        if (existing) {
            this.disposeChunkData(existing);
            this.chunks.delete(chunkKey);
        }

        const [cxStr, czStr] = chunkKey.split(',');
        const cx = Number.parseInt(cxStr, 10) || 0;
        const cz = Number.parseInt(czStr, 10) || 0;

        // 2. Собираем все элементы мира, принадлежащие этому чанку, группируя по PieceType
        const grouped = new Map<PieceType, InstanceRecord[]>();
        for (const type of PIECE_ORDER) {
            grouped.set(type, []);
        }

        let totalInChunk = 0;
        for (const [key, pieces] of this.world.cells.entries()) {
            if (!pieces || pieces.length === 0) continue;
            const cell = parseCellKey(key);
            if (chunkKeyForCell(cell.x, cell.z) !== chunkKey) continue;

            for (const piece of pieces) {
                const list = grouped.get(piece.type);
                if (list) {
                    list.push({ cell, piece });
                    totalInChunk++;
                }
            }
        }

        if (totalInChunk === 0) {
            return;
        }

        const chunkGroup = new THREE.Group();
        chunkGroup.name = `BuildingChunk_${cx}_${cz}`;
        const meshesByType = new Map<PieceType, THREE.InstancedMesh>();
        const recordsByType = new Map<PieceType, InstanceRecord[]>();
        let doorLeavesMesh: THREE.InstancedMesh | null = null;
        const doorLeaves: DoorLeafInstance[] = [];

        const dummyMatrix = new THREE.Matrix4();
        const dummyPos = new THREE.Vector3();
        const dummyQuat = new THREE.Quaternion();
        const dummyScale = new THREE.Vector3(1, 1, 1);
        const yAxis = new THREE.Vector3(0, 1, 0);

        // 3. Создаем один InstancedMesh на каждый используемый в чанке тип модуля
        for (const type of PIECE_ORDER) {
            const records = grouped.get(type);
            if (!records || records.length === 0) continue;

            // Для door_wall основной меш содержит только портальную коробку, а подвижная створка рендерится отдельно
            const asset = type === 'door_wall'
                ? getBakedDoorFrameAsset(this.isSoftwareGl)
                : getBakedPrefabAsset(type, this.isSoftwareGl);
            const instanced = new THREE.InstancedMesh(
                asset.geometry,
                asset.materials,
                records.length
            );
            instanced.name = `Instanced_${type}_${chunkKey}`;
            instanced.castShadow = !this.isSoftwareGl;
            instanced.receiveShadow = !this.isSoftwareGl;
            instanced.frustumCulled = false;

            for (let i = 0; i < records.length; i++) {
                const { cell, piece } = records[i];
                const baseY = this.world.resolveBaseY(cell, piece.baseY);
                const tf = getPieceWorldTransform(piece, cell, baseY);

                dummyPos.set(tf.position.x, tf.position.y, tf.position.z);
                dummyQuat.setFromAxisAngle(yAxis, tf.rotationY);
                dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
                instanced.setMatrixAt(i, dummyMatrix);

                const tint = TIER_TINTS[piece.tier] || TIER_TINTS[1];
                instanced.setColorAt(i, tint);
            }

            instanced.instanceMatrix.needsUpdate = true;
            if (instanced.instanceColor) {
                instanced.instanceColor.needsUpdate = true;
            }
            instanced.computeBoundingSphere();

            chunkGroup.add(instanced);
            meshesByType.set(type, instanced);
            recordsByType.set(type, records);
            this.meshToChunk.set(instanced, { chunkKey, type });

            // Отдельный InstancedMesh для подвижных створок гермодверей в этом чанке
            if (type === 'door_wall') {
                const leafAsset = getBakedDoorLeafAsset(this.isSoftwareGl);
                doorLeavesMesh = new THREE.InstancedMesh(
                    leafAsset.geometry,
                    leafAsset.materials,
                    records.length
                );
                doorLeavesMesh.name = `Instanced_door_leaf_${chunkKey}`;
                doorLeavesMesh.castShadow = !this.isSoftwareGl;
                doorLeavesMesh.receiveShadow = !this.isSoftwareGl;
                doorLeavesMesh.frustumCulled = false;

                for (let i = 0; i < records.length; i++) {
                    const rec = records[i];
                    const { cell, piece } = rec;
                    if (typeof piece.openProgress !== 'number') {
                        piece.openProgress = piece.isOpen ? 1.0 : 0.0;
                    }
                    const baseY = this.world.resolveBaseY(cell, piece.baseY);
                    const tf = getPieceWorldTransform(piece, cell, baseY);
                    const halfAngle = tf.rotationY * 0.5;
                    const quat = {
                        x: 0,
                        y: Math.sin(halfAngle),
                        z: 0,
                        w: Math.cos(halfAngle)
                    };

                    const leafEntry: DoorLeafInstance = {
                        record: rec,
                        leafIndex: i,
                        basePos: { ...tf.position },
                        rotationY: tf.rotationY,
                        quat,
                        collider: null
                    };
                    doorLeaves.push(leafEntry);

                    this.applyDoorLeafTransform(
                        doorLeavesMesh,
                        leafEntry,
                        piece.openProgress,
                        dummyMatrix,
                        dummyPos,
                        dummyQuat,
                        dummyScale,
                        yAxis
                    );

                    const tint = TIER_TINTS[piece.tier] || TIER_TINTS[1];
                    doorLeavesMesh.setColorAt(i, tint);
                }

                doorLeavesMesh.instanceMatrix.needsUpdate = true;
                if (doorLeavesMesh.instanceColor) {
                    doorLeavesMesh.instanceColor.needsUpdate = true;
                }
                doorLeavesMesh.computeBoundingSphere();

                chunkGroup.add(doorLeavesMesh);
                this.meshToChunk.set(doorLeavesMesh, { chunkKey, type: 'door_wall' });
            }
        }

        // 4. Создаем статические коллайдеры Rapier для чанка, чтобы игрок и мех могли ходить по постройкам
        let rigidBody: RAPIER.RigidBody | null = null;
        if (this.physicsWorld) {
            const bodyDesc = RAPIER.RigidBodyDesc.fixed();
            rigidBody = this.physicsWorld.createRigidBody(bodyDesc);

            for (const records of recordsByType.values()) {
                for (const { cell, piece } of records) {
                    this.attachPieceColliders(rigidBody, cell, piece, doorLeaves);
                }
            }
        }

        this.rootGroup.add(chunkGroup);
        this.chunks.set(chunkKey, {
            key: chunkKey,
            group: chunkGroup,
            meshesByType,
            recordsByType,
            doorLeavesMesh,
            doorLeaves,
            rigidBody
        });
    }

    private registerWallCollider(col: RAPIER.Collider): void {
        if (!this.physicsWorld) return;
        let wallHandles: Set<number> | undefined = (this.physicsWorld as any).__wallColliderHandles;
        if (!wallHandles) {
            wallHandles = new Set<number>();
            (this.physicsWorld as any).__wallColliderHandles = wallHandles;
        }
        wallHandles.add(col.handle);
    }

    // Создает точные составные коллайдеры для каждого типа строительного блока
    private attachPieceColliders(
        rigidBody: RAPIER.RigidBody,
        cell: GridCell,
        piece: Piece,
        doorLeaves: DoorLeafInstance[]
    ): void {
        if (!this.physicsWorld) return;

        const def = PIECE_CATALOG[piece.type];
        const baseY = this.world.resolveBaseY(cell, piece.baseY);
        const tf = getPieceWorldTransform(piece, cell, baseY);
        const pos = tf.position;
        const halfAngle = tf.rotationY * 0.5;
        const quat = {
            x: 0,
            y: Math.sin(halfAngle),
            z: 0,
            w: Math.cos(halfAngle)
        };

        if (def.category === 'foundation') {
            // Плита фундамента 3.2 × 0.64 × 3.2 м (углубляем вниз на 0.4 м на неровном грунте)
            const slabH = FOUND_HEIGHT + 0.4;
            const colDesc = RAPIER.ColliderDesc.cuboid(
                MODULE_WIDTH * 0.5,
                slabH * 0.5,
                MODULE_DEPTH * 0.5
            )
                .setTranslation(pos.x, pos.y + FOUND_HEIGHT - slabH * 0.5, pos.z)
                .setRotation(quat)
                .setFriction(0.95);
            this.physicsWorld.createCollider(colDesc, rigidBody);
            return;
        }

        if (def.category === 'ceiling') {
            // Плита перекрытия 3.2 × 0.22 × 3.2 м на высоте pos.y
            const colDesc = RAPIER.ColliderDesc.cuboid(
                MODULE_WIDTH * 0.5,
                CEILING_THICK * 0.5,
                MODULE_DEPTH * 0.5
            )
                .setTranslation(pos.x, pos.y - CEILING_THICK * 0.5 + 0.04, pos.z)
                .setRotation(quat)
                .setFriction(0.95);
            this.physicsWorld.createCollider(colDesc, rigidBody);
            return;
        }

        if (def.category === 'wall') {
            if (piece.type === 'door_wall') {
                // Для гермодвери создаем левый/правый откосы, верхнюю перемычку и подвижный коллайдер створки
                const sideW = 0.88;
                const offsetLeft = rotateVec2D(-MODULE_WIDTH * 0.5 + sideW * 0.5, 0, piece.rot);
                const offsetRight = rotateVec2D(MODULE_WIDTH * 0.5 - sideW * 0.5, 0, piece.rot);

                const leftCol = RAPIER.ColliderDesc.cuboid(sideW * 0.5, WALL_HEIGHT * 0.5, WALL_THICK * 0.5)
                    .setTranslation(pos.x + offsetLeft.x, pos.y + WALL_HEIGHT * 0.5, pos.z + offsetLeft.z)
                    .setRotation(quat);
                const rightCol = RAPIER.ColliderDesc.cuboid(sideW * 0.5, WALL_HEIGHT * 0.5, WALL_THICK * 0.5)
                    .setTranslation(pos.x + offsetRight.x, pos.y + WALL_HEIGHT * 0.5, pos.z + offsetRight.z)
                    .setRotation(quat);
                const topLintelH = 0.56;
                const topCol = RAPIER.ColliderDesc.cuboid(MODULE_WIDTH * 0.5, topLintelH * 0.5, WALL_THICK * 0.5)
                    .setTranslation(pos.x, pos.y + WALL_HEIGHT - topLintelH * 0.5, pos.z)
                    .setRotation(quat);

                this.registerWallCollider(this.physicsWorld.createCollider(leftCol, rigidBody));
                this.registerWallCollider(this.physicsWorld.createCollider(rightCol, rigidBody));
                this.registerWallCollider(this.physicsWorld.createCollider(topCol, rigidBody));

                // Коллайдер самой створки гермодвери: когда закрыта — блокирует проем (1.44 × 2.36 × 0.28 м),
                // когда открыта — становится сенсором и уходит вниз, освобождая проход
                const progress = typeof piece.openProgress === 'number' ? piece.openProgress : (piece.isOpen ? 1.0 : 0.0);
                const isOpenNow = Boolean(piece.isOpen) ? progress >= 0.20 : progress >= 0.65;
                const leafColDesc = RAPIER.ColliderDesc.cuboid(0.72, 1.18, 0.14)
                    .setTranslation(
                        pos.x,
                        isOpenNow ? pos.y - 20.0 : pos.y + 1.18,
                        pos.z
                    )
                    .setRotation(quat)
                    .setSensor(isOpenNow)
                    .setFriction(0.8);
                const leafCollider = this.physicsWorld.createCollider(leafColDesc, rigidBody);
                this.registerWallCollider(leafCollider);

                const matchingLeaf = doorLeaves.find(l => l.record.piece === piece);
                if (matchingLeaf) {
                    matchingLeaf.collider = leafCollider;
                }
            } else {
                // Глухая стена и стена с окном — сплошной коллайдер 3.2 × 3.0 × 0.38 м
                const wallCol = RAPIER.ColliderDesc.cuboid(
                    MODULE_WIDTH * 0.5,
                    WALL_HEIGHT * 0.5,
                    WALL_THICK * 0.5
                )
                    .setTranslation(pos.x, pos.y + WALL_HEIGHT * 0.5, pos.z)
                    .setRotation(quat)
                    .setFriction(0.8);
                this.registerWallCollider(this.physicsWorld.createCollider(wallCol, rigidBody));
            }
            return;
        }

        if (def.category === 'stairs') {
            // Гладкая наклонная рампа-марш + верхняя площадка для бесшовного подъема капсулы персонажа
            const landingDepth = 0.92;
            const startZ = MODULE_DEPTH * 0.5 - 0.04; // +1.56
            const endZ = -MODULE_DEPTH * 0.5 + landingDepth; // -0.68
            const startY = -0.04;
            const endY = WALL_HEIGHT; // 3.00

            const run = startZ - endZ; // 2.24 м
            const rise = endY - startY; // 3.04 м
            const rampLen = Math.hypot(run, rise);
            const pitchX = Math.atan2(rise, run);
            const rampHalfThick = 0.10;

            const localCenterY = (startY + endY) * 0.5 - rampHalfThick * Math.cos(pitchX);
            const localCenterZ = (startZ + endZ) * 0.5 - rampHalfThick * Math.sin(pitchX);
            const rampXZ = rotateVec2D(0, localCenterZ, piece.rot);

            const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tf.rotationY);
            const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchX);
            const qRamp = qYaw.multiply(qPitch);

            const rampCol = RAPIER.ColliderDesc.cuboid(0.90, rampHalfThick, rampLen * 0.5)
                .setTranslation(pos.x + rampXZ.x, pos.y + localCenterY, pos.z + rampXZ.z)
                .setRotation({ x: qRamp.x, y: qRamp.y, z: qRamp.z, w: qRamp.w })
                .setFriction(1.0);
            this.physicsWorld.createCollider(rampCol, rigidBody);

            // Верхняя площадка лестницы на уровне pos.y + WALL_HEIGHT
            const landLocalZ = -MODULE_DEPTH * 0.5 + landingDepth * 0.5;
            const landXZ = rotateVec2D(0, landLocalZ, piece.rot);
            const landCol = RAPIER.ColliderDesc.cuboid(0.90, 0.10, landingDepth * 0.5)
                .setTranslation(pos.x + landXZ.x, pos.y + WALL_HEIGHT - 0.10, pos.z + landXZ.z)
                .setRotation(quat)
                .setFriction(1.0);
            this.physicsWorld.createCollider(landCol, rigidBody);
        }
    }

    private disposeChunkData(chunk: ChunkRenderData): void {
        for (const mesh of chunk.meshesByType.values()) {
            this.meshToChunk.delete(mesh);
            chunk.group.remove(mesh);
            mesh.dispose();
        }
        if (chunk.doorLeavesMesh) {
            this.meshToChunk.delete(chunk.doorLeavesMesh);
            chunk.group.remove(chunk.doorLeavesMesh);
            chunk.doorLeavesMesh.dispose();
            chunk.doorLeavesMesh = null;
        }
        chunk.doorLeaves.length = 0;
        chunk.meshesByType.clear();
        chunk.recordsByType.clear();
        this.rootGroup.remove(chunk.group);

        if (chunk.rigidBody && this.physicsWorld) {
            try {
                const wallHandles: Set<number> | undefined = (this.physicsWorld as any).__wallColliderHandles;
                if (wallHandles && typeof chunk.rigidBody.numColliders === 'function') {
                    const n = chunk.rigidBody.numColliders();
                    for (let i = 0; i < n; i++) {
                        const col = chunk.rigidBody.collider(i);
                        if (col) wallHandles.delete(col.handle);
                    }
                }
                this.physicsWorld.removeRigidBody(chunk.rigidBody);
            } catch {
                // Игнорируем, если физический мир уже уничтожен
            }
            chunk.rigidBody = null;
        }
    }

    public dispose(): void {
        for (const chunk of this.chunks.values()) {
            this.disposeChunkData(chunk);
        }
        this.chunks.clear();
        this.meshToChunk.clear();
    }
}
