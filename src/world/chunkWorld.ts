// Потоковая генерация бесконечного мира: вокруг меха поддерживается квадрат
// загруженных чанков-диорам. Недостающие строятся по бюджету за кадр,
// далекие выгружаются вместе с физикой, мешами и реквизитом.
import * as THREE from 'three';
import { CHUNK, DIORAMA, PALETTE, PS1_SNAP } from '../config.ts';
import { chunkCoordAt, chunkKeyOf } from '../core/chunkCoords.ts';
import { createMechTexture } from '../core/textures.ts';
import { applyPS1VertexSnap } from '../render/ps1Material.ts';
import { createChunkProps, type ChunkProps } from './props.ts';
import { createSandDeformer, type SandDeformer } from './sandDeformation.ts';
import { createSandField, type SandField } from './sandField.ts';
import { createChunkTerrain, type ChunkTerrain } from './terrain.ts';
import type { WeatherState } from './weather.ts';

export interface ChunkRecord {
    cx: number;
    cz: number;
    terrain: ChunkTerrain;
    props: ChunkProps;
}

export interface ChunkEnvironment {
    dt?: number;
    frameDt?: number;
    weather?: WeatherState | null;
}

export interface ChunkWorldOptions {
    scene: THREE.Scene;
    world: any;
}

export interface ChunkWorld {
    update(nextFocus: THREE.Vector3 | { x: number; y?: number; z: number }, budget?: number, environment?: ChunkEnvironment | null): void;
    deformer: SandDeformer;
    sandField: SandField;
    syncSandAt: (x: number, z: number, radius?: number) => void;
    blastAt(origin: THREE.Vector3 | { x: number; y: number; z: number }, radius: number, strength: number): void;
    getSandMeshes(): THREE.Mesh[];
    getLoadedCount(): number;
    dispose(): void;
}

export function createChunkWorld({ scene, world }: ChunkWorldOptions): ChunkWorld {
    const sandMaterial = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        vertexColors: true,
        // Цвет и детализация рельефа вычисляются в world-space на вершинах,
        // поэтому на крутых склонах больше нет вытянутой XZ-текстуры.
        flatShading: false
    }), PS1_SNAP.terrain);

    const skirtMaterial = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        color: PALETTE.rock,
        vertexColors: true,
        flatShading: true
    }), PS1_SNAP.terrain);

    const frameMaterial = applyPS1VertexSnap(new THREE.MeshLambertMaterial({
        color: PALETTE.frame,
        flatShading: true
    }), PS1_SNAP.terrain);

    const propMaterials = {
        rock: applyPS1VertexSnap(new THREE.MeshLambertMaterial({
            map: createMechTexture(165, 118, 78),
            flatShading: true
        }), PS1_SNAP.terrain),
        debris: applyPS1VertexSnap(new THREE.MeshLambertMaterial({
            map: createMechTexture(135, 95, 65),
            flatShading: true
        }), PS1_SNAP.debris)
    };

    const frameGeometry = new THREE.BoxGeometry(
        CHUNK.size + 0.8,
        DIORAMA.frameHeight,
        CHUNK.size + 0.8
    );
    const rockGeometry = new THREE.DodecahedronGeometry(1.0, 1);
    const debrisGeometry = new THREE.IcosahedronGeometry(1.0, 0);
    const slabGeometry = new THREE.BoxGeometry(1.6, 0.45, 1.6);
    const poleGeometry = new THREE.CylinderGeometry(0.06, 0.08, 2.4, 5);

    // --- Состояние стриминга ---
    const sandField = createSandField();
    const deformer = createSandDeformer({ field: sandField });
    const chunks = new Map<string, ChunkRecord>();     // key -> { cx, cz, terrain, props }
    const sandMeshes: THREE.Mesh[] = [];               // кэш мешей песка для лучей мыши
    const focus = new THREE.Vector3();

    function buildChunk(cx: number, cz: number): void {
        const key = chunkKeyOf(cx, cz);
        const originX = cx * CHUNK.size;
        const originZ = cz * CHUNK.size;

        const terrain = createChunkTerrain({
            scene, world, cx, cz,
            sandMaterial, skirtMaterial, frameMaterial, frameGeometry
        });

        const props = createChunkProps({
            scene, world, cx, cz,
            materials: propMaterials,
            rockGeometry, debrisGeometry,
            slabGeometry, poleGeometry,
            clearZone: { x: focus.x, z: focus.z, radius: CHUNK.propClearRadius },
            enabled: CHUNK.propsEnabled
        });

        deformer.attachChunk(key, terrain.sandGeometry, originX, originZ, terrain);

        chunks.set(key, { cx, cz, terrain, props });
        sandMeshes.push(terrain.sandMesh);
        refreshEdges(cx, cz);
    }

    function unloadChunk(rec: ChunkRecord): void {
        const key = chunkKeyOf(rec.cx, rec.cz);

        deformer.detachChunk(key);
        rec.props.dispose();
        rec.terrain.dispose();
        chunks.delete(key);

        const meshIndex = sandMeshes.indexOf(rec.terrain.sandMesh);
        if (meshIndex !== -1) sandMeshes.splice(meshIndex, 1);

        refreshEdges(rec.cx, rec.cz);
    }

    // Стенки среза показываются только на границе загруженного мира,
    // поэтому стыки чанков выглядят сплошной пустыней без швов.
    function refreshEdges(cx: number, cz: number): void {
        applyEdges(cx, cz);
        applyEdges(cx + 1, cz);
        applyEdges(cx - 1, cz);
        applyEdges(cx, cz + 1);
        applyEdges(cx, cz - 1);
    }

    function applyEdges(cx: number, cz: number): void {
        const rec = chunks.get(chunkKeyOf(cx, cz));
        if (!rec) return;

        rec.terrain.setOpenEdges({
            px: !chunks.has(chunkKeyOf(cx + 1, cz)),
            nx: !chunks.has(chunkKeyOf(cx - 1, cz)),
            pz: !chunks.has(chunkKeyOf(cx, cz + 1)),
            nz: !chunks.has(chunkKeyOf(cx, cz - 1))
        });
    }

    function updateProps(wind: WeatherState | null = null, dt = 0.0): void {
        for (const rec of chunks.values()) rec.props.update(wind, dt);
    }

    // Удар боеприпаса по песку: достает до обломков всех загруженных чанков.
    // Выгруженные диоры не трогаем — они вернутся с детерминированным реквизитом.
    function blastAt(origin: THREE.Vector3 | { x: number; y: number; z: number }, radius: number, strength: number): void {
        for (const rec of chunks.values()) rec.props.blastAt(origin, radius, strength);
    }

    // Песок живет во времени: ветер переносит массу между ячейками поля
    // и толкает обломки. Вызывается в фазе стриминга.
    function updateSandWeather(dt: number, frameDt: number, weather?: WeatherState | null): void {
        if (!weather) return;
        deformer.update(dt, weather);
    }

    // focus — позиция меха; budget — сколько чанков достроить в этом кадре;
    // environment — { dt, weather } из главного цикла (может отсутствовать
    // при стартовой синхронной подгрузке).
    function update(
        nextFocus: THREE.Vector3 | { x: number; y?: number; z: number },
        budget = CHUNK.buildBudget,
        environment: ChunkEnvironment | null = null
    ): void {
        focus.copy(nextFocus as THREE.Vector3);

        const ccx = chunkCoordAt(focus.x);
        const ccz = chunkCoordAt(focus.z);

        // Выгрузка далеких чанков (радиус с гистерезисом, чтобы не мигало на границе)
        for (const rec of chunks.values()) {
            const distance = Math.max(Math.abs(rec.cx - ccx), Math.abs(rec.cz - ccz));
            if (distance > CHUNK.unloadRadius) unloadChunk(rec);
        }

        // Подгрузка ближайших недостающих чанков в пределах бюджета кадра
        const missing: { cx: number; cz: number; d2: number }[] = [];
        for (let dz = -CHUNK.loadRadius; dz <= CHUNK.loadRadius; dz++) {
            for (let dx = -CHUNK.loadRadius; dx <= CHUNK.loadRadius; dx++) {
                const cx = ccx + dx;
                const cz = ccz + dz;
                if (chunks.has(chunkKeyOf(cx, cz))) continue;
                missing.push({ cx, cz, d2: dx * dx + dz * dz });
            }
        }

        if (missing.length > 0) {
            missing.sort((a, b) => a.d2 - b.d2);
            const count = Math.min(budget, missing.length);
            for (let i = 0; i < count; i++) {
                buildChunk(missing[i].cx, missing[i].cz);
            }
        }

        updateProps(
            environment ? (environment.weather ?? null) : null,
            environment ? (environment.dt || 0.0) : 0.0
        );

        if (environment) {
            updateSandWeather(
                environment.dt || 0.0,
                environment.frameDt !== undefined ? environment.frameDt : (environment.dt || 0.0),
                environment.weather
            );
        }
    }

    return {
        update,
        deformer,
        sandField,
        syncSandAt: deformer.syncPhysicsAt,
        blastAt,
        getSandMeshes: () => sandMeshes,
        getLoadedCount: () => chunks.size,
        dispose: () => {
            for (const rec of Array.from(chunks.values())) {
                unloadChunk(rec);
            }
            chunks.clear();
            sandMeshes.length = 0;
            deformer.dispose();
            frameGeometry.dispose();
            rockGeometry.dispose();
            debrisGeometry.dispose();
            slabGeometry.dispose();
            poleGeometry.dispose();
            sandMaterial.dispose();
            skirtMaterial.dispose();
            frameMaterial.dispose();
            if ((propMaterials.rock as any).map) (propMaterials.rock as any).map.dispose();
            propMaterials.rock.dispose();
            if ((propMaterials.debris as any).map) (propMaterials.debris as any).map.dispose();
            propMaterials.debris.dispose();
        }
    };
}

