// Главный контроллер модульного строительства с сокетами, радиальным меню [B]
// и ограничением максимальной дистанции постройки:
// связывает модель данных World, чанковый рендерер InstancedMesh, полупрозрачный
// призрак (BuildingGhost), Raycaster из камеры и обработку ввода игрока.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import {
    CELL_SIZE,
    FOUND_HEIGHT,
    MAX_BUILD_DISTANCE,
    PIECE_CATALOG,
    PIECE_ORDER,
    WALL_HEIGHT,
    isSocketCompatible,
    normalizeRot
} from './catalog.ts';
import { World, canPlace } from './buildingWorld.ts';
import { BuildingChunkRenderer, type InstanceRecord } from './chunkRenderer.ts';
import { BuildingGhost } from './ghost.ts';
import type {
    GridCell,
    Piece,
    PieceDef,
    PieceType,
    PlacementValidation,
    Rotation,
    WorldSocket
} from './types.ts';

export type RadialSectorId = PieceType | 'exit';

export interface BuildingSystemOptions {
    scene: THREE.Scene;
    camera: THREE.Camera;
    domElement: HTMLElement;
    physicsWorld?: RAPIER.World | null;
    getGroundHeight: (wx: number, wz: number) => number;
    getTerrainMeshes?: () => THREE.Object3D[];
    isSoftwareGl?: boolean;
    maxBuildDistance?: number;
    onStateChange?: (state: BuildingHudSnapshot) => void;
}

export interface BuildingHudSnapshot {
    active: boolean;
    radialOpen: boolean;
    hoveredSector: RadialSectorId | null;
    selectedType: PieceType;
    selectedDef: PieceDef;
    rotation: Rotation;
    tier: number;
    tierLabel: string;
    targetCell: GridCell;
    distance: number;
    maxDistance: number;
    snappedToSocket: boolean;
    socketLabel: string | null;
    validation: PlacementValidation;
    totalPieces: number;
    activeChunks: number;
    instancedMeshes: number;
    aimedPiece: InstanceRecord | null;
    nearbyDoor: {
        cell: GridCell;
        piece: Piece;
        distance: number;
        isOpen: boolean;
    } | null;
}

const TIER_NAMES: Record<number, string> = {
    0: 'ТИР 0 · УТИЛЬ',
    1: 'ТИР 1 · БРОНЯ',
    2: 'ТИР 2 · БУНКЕР'
};

export class BuildingSystem {
    public readonly world: World;
    public readonly renderer: BuildingChunkRenderer;
    public readonly ghost: BuildingGhost;

    private readonly scene: THREE.Scene;
    private readonly camera: THREE.Camera;
    private readonly domElement: HTMLElement;
    private readonly getTerrainMeshes: () => THREE.Object3D[];
    private readonly onStateChange?: (state: BuildingHudSnapshot) => void;

    private readonly raycaster = new THREE.Raycaster();
    private readonly pointerNDC = new THREE.Vector2(0, -0.32);
    private hasMovedPointer = false;

    private active = false;
    private radialOpen = false;
    private hoveredSector: RadialSectorId | null = null;
    private keyBDownTime = 0;

    private selectedType: PieceType = 'foundation';
    private currentRot: Rotation = 0;
    private currentTier = 1;
    private maxBuildDistance: number;
    private elapsedSec = 0;

    private currentSnap: {
        cell: GridCell;
        rot: Rotation;
        baseY: number;
        snappedToSocket: boolean;
        socket: WorldSocket | null;
        validation: PlacementValidation;
        worldPos: { x: number; y: number; z: number };
        rotationY: number;
        distance: number;
        maxDistance: number;
    };
    private aimedRecord: InstanceRecord | null = null;
    private lastActorPos = new THREE.Vector3(0, 0, 0);

    private pointerDownPos = { x: 0, y: 0, button: -1 };
    private readonly boundKeyDown: (e: KeyboardEvent) => void;
    private readonly boundKeyUp: (e: KeyboardEvent) => void;
    private readonly boundPointerMove: (e: PointerEvent) => void;
    private readonly boundPointerDown: (e: PointerEvent) => void;
    private readonly boundPointerUp: (e: PointerEvent) => void;
    private readonly boundContextMenu: (e: MouseEvent) => void;
    private readonly boundWheel: (e: WheelEvent) => void;

    constructor(options: BuildingSystemOptions) {
        this.scene = options.scene;
        this.camera = options.camera;
        this.domElement = options.domElement;
        this.getTerrainMeshes = options.getTerrainMeshes || (() => []);
        this.onStateChange = options.onStateChange;
        this.maxBuildDistance = options.maxBuildDistance ?? MAX_BUILD_DISTANCE;

        this.world = new World(options.getGroundHeight);
        this.world.setBuilderPosition(this.lastActorPos, this.maxBuildDistance);

        this.renderer = new BuildingChunkRenderer(
            this.world,
            options.physicsWorld ?? null,
            Boolean(options.isSoftwareGl)
        );
        this.ghost = new BuildingGhost(Boolean(options.isSoftwareGl));

        this.scene.add(this.renderer.rootGroup);
        this.scene.add(this.ghost.root);

        this.currentSnap = this.world.findBestSnap(
            this.selectedType,
            { x: 0, y: 0, z: 3.2 },
            this.currentRot
        );

        this.boundKeyDown = this.handleKeyDown.bind(this);
        this.boundKeyUp = this.handleKeyUp.bind(this);
        this.boundPointerMove = this.handlePointerMove.bind(this);
        this.boundPointerDown = this.handlePointerDown.bind(this);
        this.boundPointerUp = this.handlePointerUp.bind(this);
        this.boundContextMenu = this.handleContextMenu.bind(this);
        this.boundWheel = this.handleWheel.bind(this);

        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', this.boundKeyDown, { capture: true });
            window.addEventListener('keyup', this.boundKeyUp, { capture: true });
        }
        if (this.domElement && typeof this.domElement.addEventListener === 'function') {
            this.domElement.addEventListener('pointermove', this.boundPointerMove);
            this.domElement.addEventListener('pointerdown', this.boundPointerDown);
            this.domElement.addEventListener('pointerup', this.boundPointerUp);
            this.domElement.addEventListener('contextmenu', this.boundContextMenu);
            this.domElement.addEventListener('wheel', this.boundWheel, { passive: false, capture: true });
        }
    }

    public isActive(): boolean {
        return this.active;
    }

    public isRadialOpen(): boolean {
        return this.radialOpen;
    }

    public setRadialOpen(open: boolean): void {
        this.radialOpen = Boolean(open);
        if (this.radialOpen) {
            this.hoveredSector = this.active ? this.selectedType : null;
            if (typeof document !== 'undefined' && document.pointerLockElement && typeof document.exitPointerLock === 'function') {
                try {
                    document.exitPointerLock();
                } catch {
                    // Игнорируем ошибку выхода из pointer lock
                }
            }
        } else {
            this.hoveredSector = null;
        }
        this.syncBodyDataset();
        this.emitState();
    }

    public toggleRadial(): boolean {
        this.setRadialOpen(!this.radialOpen);
        return this.radialOpen;
    }

    public setHoveredSector(sector: RadialSectorId | null): void {
        if (this.hoveredSector === sector) return;
        this.hoveredSector = sector;
        this.emitState();
    }

    // Выбор сектора из радиального круга: включает строительство с выбранным префабом или выключает режим
    public selectRadialSector(sector: RadialSectorId): void {
        if (sector === 'exit') {
            this.radialOpen = false;
            this.hoveredSector = null;
            this.setActive(false);
            return;
        }
        if (PIECE_CATALOG[sector]) {
            this.selectedType = sector;
            this.ghost.setPieceType(sector);
            this.radialOpen = false;
            this.hoveredSector = null;
            this.setActive(true);
        }
    }

    public setActive(nextActive: boolean): void {
        this.active = Boolean(nextActive);
        if (!this.active) {
            this.radialOpen = false;
            this.hoveredSector = null;
        }
        this.ghost.setVisible(this.active);
        this.syncBodyDataset();
        if (this.active && typeof document !== 'undefined' && document.pointerLockElement && typeof document.exitPointerLock === 'function') {
            try {
                document.exitPointerLock();
            } catch {
                // Игнорируем ошибку выхода из pointer lock
            }
        }
        this.refreshSnap();
        this.emitState();
    }

    private syncBodyDataset(): void {
        if (typeof document !== 'undefined' && document.body) {
            document.body.dataset.buildMode = (this.active || this.radialOpen) ? 'true' : 'false';
            document.body.dataset.radialMenu = this.radialOpen ? 'true' : 'false';
        }
    }

    public toggleActive(): boolean {
        this.setActive(!this.active);
        return this.active;
    }

    public getMaxBuildDistance(): number {
        return this.maxBuildDistance;
    }

    public setMaxBuildDistance(dist: number): void {
        if (!Number.isFinite(dist) || dist <= 0) return;
        this.maxBuildDistance = dist;
        this.world.setBuilderPosition(this.lastActorPos, this.maxBuildDistance);
        this.refreshSnap();
        this.emitState();
    }

    public getActorPosition(): THREE.Vector3 {
        return this.lastActorPos.clone();
    }

    public setActorPosition(pos: { x: number; y: number; z: number }): void {
        this.lastActorPos.set(pos.x, pos.y, pos.z);
        this.world.setBuilderPosition(this.lastActorPos, this.maxBuildDistance);
    }

    public getSelectedType(): PieceType {
        return this.selectedType;
    }

    public getSelectedDef(): PieceDef {
        return PIECE_CATALOG[this.selectedType];
    }

    public setSelectedType(type: PieceType): void {
        if (!PIECE_CATALOG[type]) return;
        this.selectedType = type;
        this.ghost.setPieceType(type);
        this.refreshSnap();
        this.emitState();
    }

    public getRotation(): Rotation {
        return this.currentRot;
    }

    public setRotation(rot: number): void {
        this.currentRot = normalizeRot(rot);
        this.refreshSnap();
        this.emitState();
    }

    public rotate(delta = 1): Rotation {
        this.currentRot = normalizeRot(this.currentRot + delta);
        this.refreshSnap();
        this.emitState();
        return this.currentRot;
    }

    public getTier(): number {
        return this.currentTier;
    }

    public setTier(tier: number): void {
        this.currentTier = ((Math.round(tier) % 3) + 3) % 3;
        this.emitState();
    }

    public cycleTier(): number {
        this.setTier(this.currentTier + 1);
        return this.currentTier;
    }

    // Размещает текущий призрак в мире, если canPlace(def, cell, rot) === true (включая проверку дистанции)
    public placeCurrent(): Piece | null {
        this.refreshSnap();
        const { cell, rot, baseY, validation } = this.currentSnap;
        if (!validation.valid) {
            this.emitState();
            return null;
        }

        const placed = this.world.placePiece(
            this.selectedType,
            cell,
            rot,
            this.currentTier,
            baseY
        );
        if (placed) {
            this.renderer.syncDirtyChunks();
            this.refreshSnap();
            this.emitState();
        }
        return placed;
    }

    // Размещает элемент напрямую по координатам клетки (с проверкой дистанции и сокетов) и пересобирает чанк
    public placeAt(
        type: PieceType,
        cell: GridCell,
        rot: number = 0,
        tier: number = this.currentTier
    ): Piece | null {
        const placed = this.world.placePiece(type, cell, rot, tier);
        if (placed) {
            this.renderer.syncDirtyChunks();
            this.refreshSnap();
            this.emitState();
        }
        return placed;
    }

    // Демонтирует элемент под прицелом Raycaster или последний элемент в текущей клетке (если в пределах дистанции)
    public removeAimed(): Piece | null {
        this.refreshSnap();
        let removed: Piece | null = null;
        if (this.aimedRecord) {
            const target = this.aimedRecord;
            const dist = this.world.getPlacementDistance(target.piece.type, target.cell, target.piece.rot);
            if (dist > this.maxBuildDistance) {
                return null;
            }
            removed = this.world.removePiece(
                target.cell,
                p => p.type === target.piece.type && p.rot === target.piece.rot
            );
        } else {
            const dist = this.world.getPlacementDistance(this.selectedType, this.currentSnap.cell, this.currentSnap.rot);
            if (dist > this.maxBuildDistance) {
                return null;
            }
            removed = this.world.removePiece(this.currentSnap.cell);
        }

        if (removed) {
            this.renderer.syncDirtyChunks();
            this.refreshSnap();
            this.emitState();
        }
        return removed;
    }

    public clearAll(): void {
        this.world.clear();
        this.renderer.syncDirtyChunks();
        this.refreshSnap();
        this.emitState();
    }

    // Переключает конкретную гермодверь по координатам клетки (и опциональному повороту)
    public toggleDoorAt(cell: GridCell, rot?: Rotation): Piece | null {
        const piece = this.world.toggleDoorAt(cell, rot);
        if (piece) {
            this.emitState();
        }
        return piece;
    }

    // Взаимодействие с ближайшей или наведенной гермодверью (открыть / закрыть на [E] или [F])
    public tryInteractDoor(actorPos?: { x: number; y: number; z: number }): Piece | null {
        const origin = actorPos || this.lastActorPos;
        // 1. Сначала проверяем, смотрит ли игрок/курсор прямо на гермодверь в пределах 4.2 м
        const hitInfo = this.computeRaycastTarget();
        if (hitInfo.aimedRecord && hitInfo.aimedRecord.piece.type === 'door_wall') {
            const { cell, piece } = hitInfo.aimedRecord;
            const dist = this.world.getPlacementDistance('door_wall', cell, piece.rot, piece.baseY);
            if (dist <= 4.2) {
                piece.isOpen = !piece.isOpen;
                this.emitState();
                return piece;
            }
        }
        // 2. Иначе ищем ближайшую гермодверь в радиусе 3.4 м вокруг персонажа
        const nearest = this.world.findNearestDoor(origin, 3.4);
        if (nearest) {
            nearest.piece.isOpen = !nearest.piece.isOpen;
            this.emitState();
            return nearest.piece;
        }
        return null;
    }

    public getNearbyDoor(maxRadius = 3.4): {
        cell: GridCell;
        piece: Piece;
        distance: number;
        isOpen: boolean;
    } | null {
        const nearest = this.world.findNearestDoor(this.lastActorPos, maxRadius);
        if (!nearest) return null;
        return {
            cell: nearest.cell,
            piece: nearest.piece,
            distance: nearest.distance,
            isOpen: Boolean(nearest.piece.isOpen)
        };
    }

    public update(dt: number, actorPosition?: THREE.Vector3): void {
        this.elapsedSec += dt;
        if (actorPosition) {
            this.lastActorPos.copy(actorPosition);
            this.world.setBuilderPosition(this.lastActorPos, this.maxBuildDistance);
        }

        if (this.world.getDirtyChunks().length > 0) {
            this.renderer.syncDirtyChunks();
        }

        this.renderer.updateDoors(dt);

        if (!this.active) return;

        this.refreshSnap();
    }

    // Raycaster из камеры -> точка на построенном модуле или поверхности -> снап к ближайшему сокету или клетке
    private refreshSnap(): void {
        this.world.setBuilderPosition(this.lastActorPos, this.maxBuildDistance);
        const hitInfo = this.computeRaycastTarget();
        this.aimedRecord = hitInfo.aimedRecord;

        const snap = this.world.findBestSnap(
            this.selectedType,
            hitInfo.point,
            this.currentRot
        );
        this.currentSnap = snap;

        const def = PIECE_CATALOG[this.selectedType];
        const nearbyAll = this.world.getNearbySockets(snap.cell, 2);
        const compatibleSockets = nearbyAll.filter(s => isSocketCompatible(s, def));

        const cellCenterWorld = {
            x: snap.cell.x * CELL_SIZE,
            y: snap.baseY + (snap.cell.y > 0 ? FOUND_HEIGHT + snap.cell.y * WALL_HEIGHT : 0),
            z: snap.cell.z * CELL_SIZE
        };

        this.ghost.setPieceType(this.selectedType);
        this.ghost.updateTransform(
            snap.worldPos,
            snap.rotationY,
            cellCenterWorld,
            snap.validation.valid,
            compatibleSockets,
            snap.socket,
            this.elapsedSec,
            this.lastActorPos,
            this.maxBuildDistance,
            snap.validation.reason === 'too_far',
            (wx, wz) => this.world.sampleGroundY(wx, wz)
        );
    }

    private computeRaycastTarget(): {
        point: { x: number; y: number; z: number };
        aimedRecord: InstanceRecord | null;
    } {
        const ndc = (typeof document !== 'undefined' && document.pointerLockElement)
            ? new THREE.Vector2(0, -0.25)
            : (this.hasMovedPointer ? this.pointerNDC : new THREE.Vector2(0, -0.32));

        this.raycaster.setFromCamera(ndc, this.camera);
        this.raycaster.far = 60.0;

        // 1. Проверяем пересечение с уже построенными InstancedMesh и мешами рельефа
        const buildingMeshes = this.renderer.getPickableMeshes();
        const terrainMeshes = this.getTerrainMeshes();
        const candidates: THREE.Object3D[] = [...buildingMeshes, ...terrainMeshes];

        if (candidates.length > 0) {
            const hits = this.raycaster.intersectObjects(candidates, false);
            if (hits.length > 0) {
                const hit = hits[0];
                const record = this.renderer.resolveInstanceHit(hit.object, hit.instanceId);
                const pt = hit.point.clone();

                // Если луч попал в существующий модуль — смещаем точку на 0.14 м вдоль нормали грани,
                // чтобы при наведении на торец фундамента или верх стены призрак выбирал внешний сокет
                if (record && hit.face) {
                    const normalWorld = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
                    pt.addScaledVector(normalWorld, 0.14);
                }

                return {
                    point: { x: pt.x, y: pt.y, z: pt.z },
                    aimedRecord: record
                };
            }
        }

        // 2. Fallback: пересечение луча с горизонтальной плоскостью на уровне земли у персонажа
        const refY = this.world.sampleGroundY(this.lastActorPos.x, this.lastActorPos.z);
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -refY);
        const planeHit = new THREE.Vector3();
        const intersected = this.raycaster.ray.intersectPlane(groundPlane, planeHit);

        if (intersected) {
            const maxPreviewDist = 32.0;
            const dx = planeHit.x - this.lastActorPos.x;
            const dz = planeHit.z - this.lastActorPos.z;
            const d = Math.hypot(dx, dz);
            if (d > maxPreviewDist && d > 1e-4) {
                planeHit.x = this.lastActorPos.x + (dx / d) * maxPreviewDist;
                planeHit.z = this.lastActorPos.z + (dz / d) * maxPreviewDist;
            }
            const gy = this.world.sampleGroundY(planeHit.x, planeHit.z);
            return {
                point: { x: planeHit.x, y: gy, z: planeHit.z },
                aimedRecord: null
            };
        }

        // 3. Крайний случай (взгляд в небо): точка перед персонажем
        const forwardPt = new THREE.Vector3();
        this.raycaster.ray.at(8.0, forwardPt);
        const gy = this.world.sampleGroundY(forwardPt.x, forwardPt.z);
        return {
            point: { x: forwardPt.x, y: gy, z: forwardPt.z },
            aimedRecord: null
        };
    }

    private handleKeyDown(e: KeyboardEvent): void {
        if (e.repeat) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }

        // [B] — вызов/закрытие радиального круга строительства
        if (e.code === 'KeyB') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.keyBDownTime = performance.now();
            if (!this.radialOpen) {
                this.setRadialOpen(true);
            } else {
                // Повторное нажатие B закрывает радиальное меню (или подтверждает выбранный сектор)
                if (this.hoveredSector) {
                    this.selectRadialSector(this.hoveredSector);
                } else {
                    this.setRadialOpen(false);
                }
            }
            return;
        }

        if (!this.active && !this.radialOpen) {
            // Вне режима строительства клавиша [E] открывает/закрывает ближайшую гермодверь
            if (e.code === 'KeyE') {
                const toggled = this.tryInteractDoor();
                if (toggled) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }
            return;
        }

        // Выбор модуля клавишами 1..7 (в радиальном меню или в активном режиме стройки)
        const digitMap: Record<string, PieceType> = {
            Digit1: 'foundation',
            Digit2: 'solid_wall',
            Digit3: 'window_wall',
            Digit4: 'door_wall',
            Digit5: 'ceiling',
            Digit6: 'staircase_railed',
            Digit7: 'staircase_open'
        };
        if (digitMap[e.code]) {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.selectRadialSector(digitMap[e.code]);
            return;
        }

        if (e.code === 'Digit0') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.selectRadialSector('exit');
            return;
        }

        // [Escape] — закрывает радиальное меню или выходит из режима строительства
        if (e.code === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (this.radialOpen) {
                this.setRadialOpen(false);
            } else {
                this.setActive(false);
            }
            return;
        }

        if (!this.active) return;

        // Поворот модуля [Q] / [E] / [R]
        if (e.code === 'KeyQ') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.rotate(-1);
            return;
        }
        if (e.code === 'KeyE' || e.code === 'KeyR') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.rotate(1);
            return;
        }

        // Смена тира материала [G]
        if (e.code === 'KeyG') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.cycleTier();
            return;
        }

        // Размещение клавишей [C] или [Enter]
        if (e.code === 'KeyC' || e.code === 'Enter') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (this.radialOpen && this.hoveredSector) {
                this.selectRadialSector(this.hoveredSector);
            } else {
                this.placeCurrent();
            }
            return;
        }

        // Демонтаж клавишей [X], [Backspace] или [Delete]
        if (e.code === 'KeyX' || e.code === 'Backspace' || e.code === 'Delete') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.removeAimed();
            return;
        }
    }

    private handleKeyUp(e: KeyboardEvent): void {
        if (e.code === 'KeyB' && this.radialOpen) {
            const heldMs = performance.now() - this.keyBDownTime;
            // Если игрок удерживал [B] дольше 220 мс, навел мышь на сектор и отпустил [B] — выбираем сектор
            if (heldMs > 220 && this.hoveredSector) {
                this.selectRadialSector(this.hoveredSector);
            }
        }
    }

    private handlePointerMove(e: PointerEvent): void {
        const rect = this.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.hasMovedPointer = true;
    }

    private handlePointerDown(e: PointerEvent): void {
        if (!this.active || this.radialOpen) return;
        this.pointerDownPos = { x: e.clientX, y: e.clientY, button: e.button };
    }

    private handlePointerUp(e: PointerEvent): void {
        if (!this.active || this.radialOpen) return;
        const dist = Math.hypot(
            e.clientX - this.pointerDownPos.x,
            e.clientY - this.pointerDownPos.y
        );
        // Короткий клик без перетаскивания камеры (< 6px):
        // ЛКМ (button 0) — построить модуль, ПКМ (button 2) — разобрать модуль
        if (dist <= 6 && e.button === this.pointerDownPos.button) {
            if (e.button === 0) {
                this.placeCurrent();
            } else if (e.button === 2) {
                this.removeAimed();
            }
        }
        this.pointerDownPos.button = -1;
    }

    private handleContextMenu(e: MouseEvent): void {
        if (this.active || this.radialOpen) {
            e.preventDefault();
        }
    }

    private handleWheel(e: WheelEvent): void {
        // Shift + колесо мыши вращает призрак в режиме строительства
        if (this.active && !this.radialOpen && e.shiftKey) {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.rotate(e.deltaY > 0 ? 1 : -1);
        }
    }

    public getSnapshot(): BuildingHudSnapshot {
        return {
            active: this.active,
            radialOpen: this.radialOpen,
            hoveredSector: this.hoveredSector,
            selectedType: this.selectedType,
            selectedDef: PIECE_CATALOG[this.selectedType],
            rotation: this.currentSnap.rot,
            tier: this.currentTier,
            tierLabel: TIER_NAMES[this.currentTier] || TIER_NAMES[1],
            targetCell: { ...this.currentSnap.cell },
            distance: this.currentSnap.distance,
            maxDistance: this.maxBuildDistance,
            snappedToSocket: this.currentSnap.snappedToSocket,
            socketLabel: this.currentSnap.socket ? this.currentSnap.socket.label : null,
            validation: this.currentSnap.validation,
            totalPieces: this.world.getTotalPieceCount(),
            activeChunks: this.renderer.getChunkCount(),
            instancedMeshes: this.renderer.getInstancedMeshCount(),
            aimedPiece: this.aimedRecord,
            nearbyDoor: this.getNearbyDoor()
        };
    }

    public emitState(): void {
        if (this.onStateChange) {
            this.onStateChange(this.getSnapshot());
        }
    }

    public dispose(): void {
        if (typeof window !== 'undefined') {
            window.removeEventListener('keydown', this.boundKeyDown, { capture: true } as EventListenerOptions);
            window.removeEventListener('keyup', this.boundKeyUp, { capture: true } as EventListenerOptions);
        }
        if (this.domElement && typeof this.domElement.removeEventListener === 'function') {
            this.domElement.removeEventListener('pointermove', this.boundPointerMove);
            this.domElement.removeEventListener('pointerdown', this.boundPointerDown);
            this.domElement.removeEventListener('pointerup', this.boundPointerUp);
            this.domElement.removeEventListener('contextmenu', this.boundContextMenu);
            this.domElement.removeEventListener('wheel', this.boundWheel, { capture: true } as EventListenerOptions);
        }
        this.scene.remove(this.renderer.rootGroup);
        this.scene.remove(this.ghost.root);
        this.renderer.dispose();
        this.ghost.dispose();
    }
}

export function createBuildingSystem(options: BuildingSystemOptions): BuildingSystem {
    return new BuildingSystem(options);
}

export { PIECE_ORDER, PIECE_CATALOG, MAX_BUILD_DISTANCE, canPlace };
