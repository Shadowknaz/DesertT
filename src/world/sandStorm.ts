// Песчаная буря: два слоя инстансированных песчинок — летящие по ветру
// штрихи в воздухе и низовая поземка, стелющаяся над барханами.
// Слои постоянно переносятся через границы куба вокруг меха, поэтому буря
// заполняет любую видимую область бесконечной пустыни, не храня мир целиком.
import * as THREE from 'three';
import { CHUNK, PS1_SNAP } from '../config.ts';
import { getDuneHeight } from '../core/duneField.ts';
import { applyPS1VertexSnap } from '../render/ps1Material.ts';
import type { Rng } from '../core/rng.ts';
import type { WeatherState } from './weather.ts';

const STREAK_COUNT = 300;
const SHEET_COUNT = 80;

// Радиус куба переноса: частицы живут вокруг меха, а не в мировых координатах.
const STREAK_RADIUS = CHUNK.size * 0.9;
const SHEET_RADIUS = CHUNK.size * 0.7;

export interface SandStormOptions {
    scene: THREE.Scene;
    rng?: Rng | null;
}

export interface StreakParticle {
    x: number;
    y: number;
    z: number;
    len: number;
    thick: number;
    width: number;
    speed: number;
    groundY: number;
    groundTimer: number;
}

export interface SheetParticle {
    x: number;
    y: number;
    z: number;
    len: number;
    width: number;
    lift: number;
    speed: number;
    phase: number;
}

export interface SandStorm {
    update(
        dt: number,
        focus: THREE.Vector3 | { x: number; y?: number; z: number },
        weather: WeatherState | null,
        cameraPos?: THREE.Vector3 | null
    ): void;
    dispose(): void;
}

export function createSandStorm({ scene, rng = null }: SandStormOptions): SandStorm {
    const rnd = rng ? () => rng.next() : () => Math.random();
    const dummy = new THREE.Object3D();
    const basis = new THREE.Matrix4();
    const axisX = new THREE.Vector3();
    const axisY = new THREE.Vector3();
    const axisZ = new THREE.Vector3();

    const streakGeometry = new THREE.BoxGeometry(1, 1, 1);
    const streakMaterial = applyPS1VertexSnap(new THREE.MeshBasicMaterial({
        color: 0xddb07a,
        transparent: true,
        opacity: 0.0,
        depthWrite: false
    }), PS1_SNAP.debris);

    const sheetMaterial = applyPS1VertexSnap(new THREE.MeshBasicMaterial({
        color: 0xc79563,
        transparent: true,
        opacity: 0.0,
        depthWrite: false
    }), PS1_SNAP.terrain);

    const streakMesh = new THREE.InstancedMesh(streakGeometry, streakMaterial, STREAK_COUNT);
    streakMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    streakMesh.frustumCulled = false;
    streakMesh.castShadow = false;
    streakMesh.receiveShadow = false;
    scene.add(streakMesh);

    const sheetMesh = new THREE.InstancedMesh(streakGeometry, sheetMaterial, SHEET_COUNT);
    sheetMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    sheetMesh.frustumCulled = false;
    sheetMesh.castShadow = false;
    sheetMesh.receiveShadow = false;
    scene.add(sheetMesh);

    const streaks: StreakParticle[] = [];
    for (let i = 0; i < STREAK_COUNT; i++) {
        streaks.push({
            x: 0.0, y: -100.0, z: 0.0,
            len: 1.0, thick: 0.04, width: 0.25, speed: 1.0,
            groundY: -100.0, groundTimer: 0.0
        });
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(0.001);
        dummy.updateMatrix();
        streakMesh.setMatrixAt(i, dummy.matrix);
    }

    const sheets: SheetParticle[] = [];
    for (let i = 0; i < SHEET_COUNT; i++) {
        sheets.push({
            x: 0.0, y: -100.0, z: 0.0,
            len: 2.0, width: 0.6, lift: 0.15, speed: 0.8, phase: 0.0
        });
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(0.001);
        dummy.updateMatrix();
        sheetMesh.setMatrixAt(i, dummy.matrix);
    }

    // Песчинка входит в куб с наветренной стороны на случайной высоте.
    // При первом включении слоя (atEdge = false) она сразу рождается в любой
    // точке куба, иначе вся буря начинается узкой стенкой с одной стороны.
    function respawnStreak(
        p: StreakParticle,
        focus: { x: number; z: number },
        dirX: number,
        dirZ: number,
        atEdge = true
    ): void {
        const lateral = (rnd() - 0.5) * STREAK_RADIUS * 2.0;
        const along = atEdge
            ? STREAK_RADIUS * (0.7 + rnd() * 0.3)
            : (rnd() * 2.0 - 1.0) * STREAK_RADIUS;
        p.x = focus.x - dirX * along - dirZ * lateral;
        p.z = focus.z - dirZ * along + dirX * lateral;
        p.groundY = getDuneHeight(p.x, p.z);
        p.y = p.groundY + 0.3 + Math.pow(rnd(), 1.2) * 6.5;
        p.len = 0.9 + rnd() * 1.7;
        p.thick = 0.02 + rnd() * 0.015;
        p.width = 0.18 + rnd() * 0.26;
        p.speed = 0.75 + rnd() * 0.5;
        p.groundTimer = rnd() * 0.35;
    }

    // Низовая поземка: плоские длинные песчинки, ползущие по самой поверхности.
    function respawnSheet(
        p: SheetParticle,
        focus: { x: number; z: number },
        dirX: number,
        dirZ: number,
        atEdge = true
    ): void {
        const lateral = (rnd() - 0.5) * SHEET_RADIUS * 2.0;
        const along = atEdge
            ? SHEET_RADIUS * (0.7 + rnd() * 0.3)
            : (rnd() * 2.0 - 1.0) * SHEET_RADIUS;
        p.x = focus.x - dirX * along - dirZ * lateral;
        p.z = focus.z - dirZ * along + dirX * lateral;
        p.lift = 0.07 + rnd() * 0.28;
        p.len = 1.5 + rnd() * 2.6;
        p.width = 0.3 + rnd() * 0.4;
        p.speed = 0.65 + rnd() * 0.35;
        p.phase = rnd() * Math.PI * 2;
    }

    let wasActive = false;

    // Песчинка — плоская лента: длинная ось вдоль ветра, ширина развернута
    // к камере. Иначе при взгляде по ветру штрихи схлопываются в точку.
    function orientRibbon(
        p: { x: number; y: number; z: number },
        dirX: number,
        dirZ: number,
        cameraPos: THREE.Vector3 | null
    ): void {
        axisX.set(dirX, 0.0, dirZ);

        if (cameraPos) {
            const tx = cameraPos.x - p.x;
            const ty = cameraPos.y - p.y;
            const tz = cameraPos.z - p.z;
            axisZ.set(-dirZ * ty, dirZ * tx - dirX * tz, dirX * ty);
            if (axisZ.lengthSq() < 1e-8) axisZ.set(0.0, 1.0, 0.0);
            axisZ.normalize();
            axisY.crossVectors(axisZ, axisX).normalize();
        } else {
            axisY.set(0.0, 1.0, 0.0);
            axisZ.crossVectors(axisX, axisY).normalize();
        }

        basis.makeBasis(axisX, axisY, axisZ);
        dummy.quaternion.setFromRotationMatrix(basis);
    }

    function update(
        dt: number,
        focus: THREE.Vector3 | { x: number; y?: number; z: number },
        weather: WeatherState | null,
        cameraPos: THREE.Vector3 | null = null
    ): void {
        const intensity = weather ? weather.intensity : 0.0;
        const active = THREE.MathUtils.clamp(intensity * 1.15 + (weather ? weather.gust * 0.15 : 0.0), 0.0, 1.0);

        // В штиль оба слоя выключены целиком: экономим матрицы и полосу.
        if (active < 0.03) {
            if (wasActive) {
                streakMesh.visible = false;
                sheetMesh.visible = false;
                streakMaterial.opacity = 0.0;
                sheetMaterial.opacity = 0.0;
                wasActive = false;
            }
            return;
        }

        streakMesh.visible = true;
        sheetMesh.visible = true;
        streakMaterial.opacity = 0.04 + active * 0.20;
        sheetMaterial.opacity = 0.02 + active * 0.08;

        // Куб бури смещен от меха к камере: иначе при взгляде издалека
        // передний план остается чистым, а все песчинки теснятся у меха.
        const centerX = cameraPos ? focus.x + (cameraPos.x - focus.x) * 0.4 : focus.x;
        const centerZ = cameraPos ? focus.z + (cameraPos.z - focus.z) * 0.4 : focus.z;
        const center = { x: centerX, z: centerZ };

        const windSpeed = weather ? Math.hypot(weather.windX, weather.windZ) : 0;
        const dirX = weather && windSpeed > 0.001 ? weather.windX / windSpeed : 1.0;
        const dirZ = weather && windSpeed > 0.001 ? weather.windZ / windSpeed : 0.0;

        if (!wasActive) {
            for (let i = 0; i < STREAK_COUNT; i++) respawnStreak(streaks[i], center, dirX, dirZ, false);
            for (let i = 0; i < SHEET_COUNT; i++) respawnSheet(sheets[i], center, dirX, dirZ, false);
            wasActive = true;
        }

        // --- Воздушные штрихи: летят вместе с потоком, гаснут в тумане ---
        const streakCount = Math.max(1, Math.round(STREAK_COUNT * Math.min(1.0, active * 1.3)));
        streakMesh.count = streakCount;

        const wX = weather ? weather.windX : 0;
        const wZ = weather ? weather.windZ : 0;

        for (let i = 0; i < streakCount; i++) {
            const p = streaks[i];
            p.x += wX * p.speed * dt;
            p.z += wZ * p.speed * dt;

            if (Math.abs(p.x - centerX) > STREAK_RADIUS || Math.abs(p.z - centerZ) > STREAK_RADIUS) {
                respawnStreak(p, center, dirX, dirZ);
            }

            // Высоту земли пересчитываем не каждый кадр: бархан под песчинкой
            // меняется медленно, а getDuneHeight стоит несколько октав шума.
            p.groundTimer -= dt;
            if (p.groundTimer <= 0.0) {
                p.groundTimer = 0.22 + rnd() * 0.25;
                p.groundY = getDuneHeight(p.x, p.z);
            }
            if (p.y < p.groundY + 0.2) {
                p.y = p.groundY + 0.4 + rnd() * 2.5;
            }

            dummy.position.set(p.x, p.y, p.z);
            orientRibbon(p, dirX, dirZ, cameraPos);
            // Мягко гасим песчинки у границы куба, чтобы не было видно шва
            const edge = Math.max(
                Math.abs(p.x - centerX) / STREAK_RADIUS,
                Math.abs(p.z - centerZ) / STREAK_RADIUS
            );
            const fade = THREE.MathUtils.clamp((1.0 - edge) / 0.25, 0.0, 1.0);
            dummy.scale.set(p.len * (0.7 + active * 0.6) * fade, p.thick, p.width * fade);
            dummy.updateMatrix();
            streakMesh.setMatrixAt(i, dummy.matrix);
        }
        streakMesh.instanceMatrix.needsUpdate = true;

        // --- Поземка: длинные плоские песчинки точно над поверхностью ---
        const sheetCount = Math.max(1, Math.round(SHEET_COUNT * Math.min(1.0, active * 1.2)));
        sheetMesh.count = sheetCount;

        for (let i = 0; i < sheetCount; i++) {
            const p = sheets[i];
            p.x += wX * p.speed * dt;
            p.z += wZ * p.speed * dt;

            if (Math.abs(p.x - centerX) > SHEET_RADIUS || Math.abs(p.z - centerZ) > SHEET_RADIUS) {
                respawnSheet(p, center, dirX, dirZ);
            }

            const groundY = getDuneHeight(p.x, p.z);
            const time = weather ? weather.time : 0;
            const bob = Math.sin(time * 3.1 + p.phase) * 0.03;

            dummy.position.set(p.x, groundY + p.lift + bob, p.z);
            orientRibbon(p, dirX, dirZ, cameraPos);
            const edge = Math.max(
                Math.abs(p.x - centerX) / SHEET_RADIUS,
                Math.abs(p.z - centerZ) / SHEET_RADIUS
            );
            const fade = THREE.MathUtils.clamp((1.0 - edge) / 0.25, 0.0, 1.0);
            dummy.scale.set(p.len * fade, 0.02, p.width * fade);
            dummy.updateMatrix();
            sheetMesh.setMatrixAt(i, dummy.matrix);
        }
        sheetMesh.instanceMatrix.needsUpdate = true;
    }

    function dispose(): void {
        if (streakMesh.parent) streakMesh.parent.remove(streakMesh);
        if (sheetMesh.parent) sheetMesh.parent.remove(sheetMesh);
        streakGeometry.dispose();
        streakMaterial.dispose();
        sheetMaterial.dispose();
        streakMesh.dispose();
        sheetMesh.dispose();
    }

    return { update, dispose };
}

