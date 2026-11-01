// Визуальная система ветра и песчаной бури: три согласованных слоя —
// 1) тонкие заостренные воздушные струи ветра (streamlines), огибающие рельеф дюн,
// 2) низовая поземка (saltation ribbons), стелющаяся по склонам барханов,
// 3) мелкие быстрые песчинки в потоке ветра (windborne specks), прыгающие над гребнями.
// Слои живут в кубе вокруг фокуса/камеры и плавно гаснут у границ.
import * as THREE from 'three';
import { CHUNK, PS1_SNAP } from '../config.ts';
import { getDuneHeight } from '../core/duneField.ts';
import { applyPS1VertexSnap } from '../render/ps1Material.ts';
import type { Rng } from '../core/rng.ts';
import type { WeatherState } from './weather.ts';

const STREAK_COUNT = 420;
const SHEET_COUNT = 160;
const GRAIN_COUNT = 320;

// Радиус куба переноса: частицы живут вокруг меха/актера и камеры
const STREAK_RADIUS = CHUNK.size * 0.9;
const SHEET_RADIUS = CHUNK.size * 0.72;
const GRAIN_RADIUS = CHUNK.size * 0.68;

export interface SandStormOptions {
    scene: THREE.Scene;
    rng?: Rng | null;
    windAt?: ((out: THREE.Vector3, x: number, z: number) => THREE.Vector3 | null) | null;
}

export interface StreakParticle {
    x: number;
    y: number;
    z: number;
    len: number;
    thick: number;
    width: number;
    speed: number;
    phase: number;
    groundY: number;
    slopePitch: number;
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
    slopePitch: number;
}

export interface WindGrainParticle {
    x: number;
    y: number;
    z: number;
    size: number;
    lift: number;
    hopAmp: number;
    hopFreq: number;
    speed: number;
    phase: number;
    groundY: number;
    groundTimer: number;
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

// Заостренная веретенообразная лента вдоль оси X (-0.5 .. +0.5):
// нос и хвост сведены в острие, а середина имеет ромбовидное сечение с вершинным
// градиентом яркости. Благодаря этому струи ветра выглядят как тонкие воздушные
// росчерки, а не прямоугольные доски.
function createTaperedRibbonGeometry(): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    // 10 вершин: хвост (0), заднее кольцо (1..4), переднее кольцо (5..8), нос (9)
    const positions = new Float32Array([
        -0.50,  0.00,  0.00, // 0: tail tip
        -0.16,  0.50,  0.00, // 1: rear top
        -0.16,  0.00,  0.50, // 2: rear right
        -0.16, -0.50,  0.00, // 3: rear bottom
        -0.16,  0.00, -0.50, // 4: rear left
         0.20,  0.38,  0.00, // 5: front top
         0.20,  0.00,  0.38, // 6: front right
         0.20, -0.38,  0.00, // 7: front bottom
         0.20,  0.00, -0.38, // 8: front left
         0.50,  0.00,  0.00  // 9: head tip
    ]);

    const colors = new Float32Array([
        0.72, 0.56, 0.42, // 0: мягкий хвост
        0.92, 0.78, 0.62, // 1
        0.95, 0.82, 0.66, // 2
        0.88, 0.74, 0.58, // 3
        0.95, 0.82, 0.66, // 4
        1.00, 0.92, 0.78, // 5: яркое ядро потока
        1.00, 0.95, 0.82, // 6
        0.96, 0.86, 0.72, // 7
        1.00, 0.95, 0.82, // 8
        0.82, 0.68, 0.52  // 9: острие по ветру
    ]);

    const indices = [
        // Хвостовой конус
        0, 2, 1,
        0, 3, 2,
        0, 4, 3,
        0, 1, 4,
        // Средний пролет
        1, 2, 6,  1, 6, 5,
        2, 3, 7,  2, 7, 6,
        3, 4, 8,  3, 8, 7,
        4, 1, 5,  4, 5, 8,
        // Носовой конус
        5, 6, 9,
        6, 7, 9,
        7, 8, 9,
        8, 5, 9
    ];

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
}

export function createSandStorm({ scene, rng = null, windAt = null }: SandStormOptions): SandStorm {
    const rnd = rng ? () => rng.next() : () => Math.random();
    const dummy = new THREE.Object3D();
    const basis = new THREE.Matrix4();
    const axisX = new THREE.Vector3();
    const axisY = new THREE.Vector3();
    const axisZ = new THREE.Vector3();
    const localWind = new THREE.Vector3();
    const tintColor = new THREE.Color();

    const streakGeometry = createTaperedRibbonGeometry();
    const grainGeometry = new THREE.OctahedronGeometry(0.032, 0);

    // В applyPS1VertexSnap параметр snapResolution — это число делений экрана в clip-space
    // (например, terrain = 320.0). Повышенное разрешение 480.0 сохраняет легкую PS1-пикселизацию,
    // но не схлопывает тонкие струи ветра и не дает артефактов привязки к центру экрана.
    const FINE_WIND_SNAP = 480.0;

    const streakMaterial = applyPS1VertexSnap(new THREE.MeshBasicMaterial({
        color: 0xecc692,
        vertexColors: true,
        transparent: true,
        opacity: 0.0,
        depthWrite: false
    }), FINE_WIND_SNAP);

    const sheetMaterial = applyPS1VertexSnap(new THREE.MeshBasicMaterial({
        color: 0xe0b47c,
        vertexColors: true,
        transparent: true,
        opacity: 0.0,
        depthWrite: false
    }), FINE_WIND_SNAP);

    const grainMaterial = applyPS1VertexSnap(new THREE.MeshBasicMaterial({
        color: 0xeabf88,
        transparent: true,
        opacity: 0.0,
        depthWrite: false
    }), FINE_WIND_SNAP);

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

    const grainMesh = new THREE.InstancedMesh(grainGeometry, grainMaterial, GRAIN_COUNT);
    grainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    grainMesh.frustumCulled = false;
    grainMesh.castShadow = false;
    grainMesh.receiveShadow = false;
    scene.add(grainMesh);

    const streakPalette = [0xf5d4a2, 0xe6bc86, 0xdba970, 0xfae0b8];
    const sheetPalette = [0xe4b880, 0xd4a26a, 0xedc48e, 0xc8945c];
    const grainPalette = [0xecbf88, 0xdca870, 0xf5d29e, 0xce9860];

    const streaks: StreakParticle[] = [];
    for (let i = 0; i < STREAK_COUNT; i++) {
        streaks.push({
            x: 0.0, y: -100.0, z: 0.0,
            len: 0.22, thick: 0.014, width: 0.018, speed: 1.0,
            phase: (i * 1.618) % (Math.PI * 2),
            groundY: -100.0, slopePitch: 0.0, groundTimer: 0.0
        });
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(0.001);
        dummy.updateMatrix();
        streakMesh.setMatrixAt(i, dummy.matrix);
        tintColor.setHex(streakPalette[i % streakPalette.length]);
        streakMesh.setColorAt(i, tintColor);
    }
    if (streakMesh.instanceColor) streakMesh.instanceColor.needsUpdate = true;

    const sheets: SheetParticle[] = [];
    for (let i = 0; i < SHEET_COUNT; i++) {
        sheets.push({
            x: 0.0, y: -100.0, z: 0.0,
            len: 0.26, width: 0.022, lift: 0.06, speed: 0.85,
            phase: (i * 2.399) % (Math.PI * 2),
            slopePitch: 0.0
        });
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(0.001);
        dummy.updateMatrix();
        sheetMesh.setMatrixAt(i, dummy.matrix);
        tintColor.setHex(sheetPalette[i % sheetPalette.length]);
        sheetMesh.setColorAt(i, tintColor);
    }
    if (sheetMesh.instanceColor) sheetMesh.instanceColor.needsUpdate = true;

    const grains: WindGrainParticle[] = [];
    for (let i = 0; i < GRAIN_COUNT; i++) {
        grains.push({
            x: 0.0, y: -100.0, z: 0.0,
            size: 0.68, lift: 0.10, hopAmp: 0.14, hopFreq: 6.0,
            speed: 1.1, phase: (i * 1.97) % (Math.PI * 2),
            groundY: -100.0, groundTimer: 0.0
        });
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(0.001);
        dummy.updateMatrix();
        grainMesh.setMatrixAt(i, dummy.matrix);
        tintColor.setHex(grainPalette[i % grainPalette.length]);
        grainMesh.setColorAt(i, tintColor);
    }
    if (grainMesh.instanceColor) grainMesh.instanceColor.needsUpdate = true;

    function sampleSlopePitch(x: number, z: number, groundY: number, dirX: number, dirZ: number): number {
        const step = 0.9;
        const aheadY = getDuneHeight(x + dirX * step, z + dirZ * step);
        return THREE.MathUtils.clamp((aheadY - groundY) / step, -0.55, 0.55);
    }

    // Воздушная микро-струя песка входит в куб с наветренной стороны в приземном слое.
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
        p.slopePitch = sampleSlopePitch(p.x, p.z, p.groundY, dirX, dirZ);
        p.y = p.groundY + 0.10 + Math.pow(rnd(), 1.7) * 3.0;
        p.len = 0.14 + rnd() * 0.20;
        p.thick = 0.012 + rnd() * 0.010;
        p.width = 0.014 + rnd() * 0.014;
        p.speed = 0.85 + rnd() * 0.55;
        p.phase = rnd() * Math.PI * 2;
        p.groundTimer = rnd() * 0.28;
    }

    // Низовая поземка: короткие росчерки песка, скользящие вдоль самой поверхности дюн.
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
        p.lift = 0.03 + rnd() * 0.11;
        p.len = 0.18 + rnd() * 0.22;
        p.width = 0.018 + rnd() * 0.018;
        p.speed = 0.72 + rnd() * 0.38;
        p.phase = rnd() * Math.PI * 2;
        const gY = getDuneHeight(p.x, p.z);
        p.slopePitch = sampleSlopePitch(p.x, p.z, gY, dirX, dirZ);
    }

    // Мелкие песчинки, несомые ветром и прыгающие (сальтация) над барханами.
    function respawnGrain(
        p: WindGrainParticle,
        focus: { x: number; z: number },
        dirX: number,
        dirZ: number,
        atEdge = true
    ): void {
        const lateral = (rnd() - 0.5) * GRAIN_RADIUS * 2.0;
        const along = atEdge
            ? GRAIN_RADIUS * (0.7 + rnd() * 0.3)
            : (rnd() * 2.0 - 1.0) * GRAIN_RADIUS;
        p.x = focus.x - dirX * along - dirZ * lateral;
        p.z = focus.z - dirZ * along + dirX * lateral;
        p.groundY = getDuneHeight(p.x, p.z);
        p.lift = 0.04 + Math.pow(rnd(), 1.7) * 2.2;
        p.hopAmp = 0.04 + rnd() * 0.14;
        p.hopFreq = 5.0 + rnd() * 4.5;
        p.size = 0.52 + rnd() * 0.58;
        p.speed = 0.90 + rnd() * 0.55;
        p.phase = rnd() * Math.PI * 2;
        p.groundTimer = rnd() * 0.22;
    }

    let wasActive = false;

    // Ориентация ленты вдоль 3D-вектора потока (с учетом уклона бархана и вихрей)
    // с разворотом широкой грани к камере.
    function orientRibbon(
        p: { x: number; y: number; z: number },
        flowX: number,
        flowY: number,
        flowZ: number,
        cameraPos: THREE.Vector3 | null
    ): void {
        axisX.set(flowX, flowY, flowZ);
        if (axisX.lengthSq() < 1e-8) axisX.set(1.0, 0.0, 0.0);
        else axisX.normalize();

        if (cameraPos) {
            const tx = cameraPos.x - p.x;
            const ty = cameraPos.y - p.y;
            const tz = cameraPos.z - p.z;
            axisZ.set(
                axisX.y * tz - axisX.z * ty,
                axisX.z * tx - axisX.x * tz,
                axisX.x * ty - axisX.y * tx
            );
            if (axisZ.lengthSq() < 1e-8) axisZ.set(0.0, 1.0, 0.0);
            axisZ.normalize();
            axisY.crossVectors(axisZ, axisX).normalize();
        } else {
            axisY.set(0.0, 1.0, 0.0);
            axisZ.crossVectors(axisX, axisY);
            if (axisZ.lengthSq() < 1e-8) axisZ.set(0.0, 0.0, 1.0);
            else axisZ.normalize();
            axisY.crossVectors(axisZ, axisX).normalize();
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
        const gust = weather ? weather.gust : 0.0;
        const windSpeed = weather ? Math.hypot(weather.windX, weather.windZ) : 0;

        // Даже при легком ветре (clear / breeze) в пустыне видны мелкие песчинки
        // поземки, а в бурю поток становится плотным.
        const active = weather && (intensity > 0.01 || windSpeed > 0.2)
            ? THREE.MathUtils.clamp(0.16 + intensity * 0.95 + gust * 0.22, 0.0, 1.0)
            : 0.0;

        if (active < 0.03) {
            if (wasActive) {
                streakMesh.visible = false;
                sheetMesh.visible = false;
                grainMesh.visible = false;
                streakMaterial.opacity = 0.0;
                sheetMaterial.opacity = 0.0;
                grainMaterial.opacity = 0.0;
                wasActive = false;
            }
            return;
        }

        streakMesh.visible = true;
        sheetMesh.visible = true;
        grainMesh.visible = true;

        streakMaterial.opacity = 0.10 + active * 0.20;
        sheetMaterial.opacity = 0.12 + active * 0.22;
        grainMaterial.opacity = 0.24 + active * 0.38;

        // Куб ветра смещен от актера к камере, чтобы передний план тоже читался в потоке
        const centerX = cameraPos ? focus.x + (cameraPos.x - focus.x) * 0.38 : focus.x;
        const centerZ = cameraPos ? focus.z + (cameraPos.z - focus.z) * 0.38 : focus.z;
        const center = { x: centerX, z: centerZ };

        const dirX = weather && windSpeed > 0.001 ? weather.windX / windSpeed : 1.0;
        const dirZ = weather && windSpeed > 0.001 ? weather.windZ / windSpeed : 0.0;

        if (!wasActive) {
            for (let i = 0; i < STREAK_COUNT; i++) respawnStreak(streaks[i], center, dirX, dirZ, false);
            for (let i = 0; i < SHEET_COUNT; i++) respawnSheet(sheets[i], center, dirX, dirZ, false);
            for (let i = 0; i < GRAIN_COUNT; i++) respawnGrain(grains[i], center, dirX, dirZ, false);
            wasActive = true;
        }

        const time = weather ? weather.time : 0;
        const baseWX = weather ? weather.windX : 0;
        const baseWZ = weather ? weather.windZ : 0;

        // --- 1. Короткие воздушные росчерки песка (Micro-Streamlines) ---
        const streakCount = Math.max(16, Math.round(STREAK_COUNT * Math.min(1.0, 0.30 + active * 0.70)));
        streakMesh.count = streakCount;

        for (let i = 0; i < streakCount; i++) {
            const p = streaks[i];

            let vx = baseWX;
            let vz = baseWZ;
            if (windAt) {
                const sampled = windAt(localWind, p.x, p.z);
                if (sampled) {
                    vx = sampled.x;
                    vz = sampled.z;
                }
            }

            // Легкая поперечная волна турбулентности делает траекторию живой
            const wave = Math.sin(time * 2.8 + p.phase + p.x * 0.08 + p.z * 0.08) * (0.35 + active * 0.65);
            const flowX = vx - dirZ * wave;
            const flowZ = vz + dirX * wave;

            p.x += flowX * p.speed * dt;
            p.z += flowZ * p.speed * dt;

            if (Math.abs(p.x - centerX) > STREAK_RADIUS || Math.abs(p.z - centerZ) > STREAK_RADIUS) {
                respawnStreak(p, center, dirX, dirZ);
            }

            p.groundTimer -= dt;
            if (p.groundTimer <= 0.0) {
                p.groundTimer = 0.16 + rnd() * 0.20;
                p.groundY = getDuneHeight(p.x, p.z);
                p.slopePitch = sampleSlopePitch(p.x, p.z, p.groundY, dirX, dirZ);
            }

            // Струя плавно следует за рельефом бархана
            const verticalWave = Math.cos(time * 2.4 + p.phase) * 0.18;
            p.y += (p.slopePitch * windSpeed * 0.35 + verticalWave) * dt;
            if (p.y < p.groundY + 0.10) {
                p.y = p.groundY + 0.16 + rnd() * 1.2;
            } else if (p.y > p.groundY + 4.0) {
                p.y = p.groundY + 0.4 + rnd() * 2.0;
            }

            dummy.position.set(p.x, p.y, p.z);
            const flowSpeed = Math.hypot(flowX, flowZ) || 1.0;
            orientRibbon(
                p,
                flowX / flowSpeed,
                p.slopePitch * 0.55 + verticalWave * 0.08,
                flowZ / flowSpeed,
                cameraPos
            );

            const edge = Math.max(
                Math.abs(p.x - centerX) / STREAK_RADIUS,
                Math.abs(p.z - centerZ) / STREAK_RADIUS
            );
            const fade = THREE.MathUtils.clamp((1.0 - edge) / 0.25, 0.0, 1.0);
            const stretch = (0.75 + active * 0.45 + Math.min(0.35, windSpeed * 0.04)) * fade;
            dummy.scale.set(p.len * stretch, p.thick, p.width * fade);
            dummy.updateMatrix();
            streakMesh.setMatrixAt(i, dummy.matrix);
        }
        streakMesh.instanceMatrix.needsUpdate = true;

        // --- 2. Низовая поземка (Dune Saltation Wisps) ---
        const sheetCount = Math.max(12, Math.round(SHEET_COUNT * Math.min(1.0, 0.32 + active * 0.68)));
        sheetMesh.count = sheetCount;

        for (let i = 0; i < sheetCount; i++) {
            const p = sheets[i];
            const snake = Math.sin(time * 4.2 + p.phase) * (0.45 + active * 0.55);
            const flowX = baseWX - dirZ * snake;
            const flowZ = baseWZ + dirX * snake;

            p.x += flowX * p.speed * dt;
            p.z += flowZ * p.speed * dt;

            if (Math.abs(p.x - centerX) > SHEET_RADIUS || Math.abs(p.z - centerZ) > SHEET_RADIUS) {
                respawnSheet(p, center, dirX, dirZ);
            }

            const groundY = getDuneHeight(p.x, p.z);
            p.slopePitch = sampleSlopePitch(p.x, p.z, groundY, dirX, dirZ);
            const bob = Math.sin(time * 3.6 + p.phase) * 0.020;

            dummy.position.set(p.x, groundY + p.lift + bob, p.z);
            const flowSpeed = Math.hypot(flowX, flowZ) || 1.0;
            orientRibbon(
                p,
                flowX / flowSpeed,
                p.slopePitch * 0.85,
                flowZ / flowSpeed,
                cameraPos
            );

            const edge = Math.max(
                Math.abs(p.x - centerX) / SHEET_RADIUS,
                Math.abs(p.z - centerZ) / SHEET_RADIUS
            );
            const fade = THREE.MathUtils.clamp((1.0 - edge) / 0.25, 0.0, 1.0);
            dummy.scale.set(p.len * (0.8 + active * 0.4) * fade, 0.014, p.width * fade);
            dummy.updateMatrix();
            sheetMesh.setMatrixAt(i, dummy.matrix);
        }
        sheetMesh.instanceMatrix.needsUpdate = true;

        // --- 3. Мелкие летящие песчинки в потоке (Windborne Sand Specks) ---
        const grainCount = Math.max(16, Math.round(GRAIN_COUNT * Math.min(1.0, 0.25 + active * 0.85)));
        grainMesh.count = grainCount;

        for (let i = 0; i < grainCount; i++) {
            const p = grains[i];
            const swirl = Math.cos(time * 3.5 + p.phase) * 0.4;
            p.x += (baseWX - dirZ * swirl) * p.speed * dt;
            p.z += (baseWZ + dirX * swirl) * p.speed * dt;

            if (Math.abs(p.x - centerX) > GRAIN_RADIUS || Math.abs(p.z - centerZ) > GRAIN_RADIUS) {
                respawnGrain(p, center, dirX, dirZ);
            }

            p.groundTimer -= dt;
            if (p.groundTimer <= 0.0) {
                p.groundTimer = 0.14 + rnd() * 0.18;
                p.groundY = getDuneHeight(p.x, p.z);
            }

            // Прыжки сальтации над поверхностью песка
            const hop = Math.abs(Math.sin(time * p.hopFreq + p.phase)) * p.hopAmp * (0.6 + active * 0.7);
            p.y = p.groundY + p.lift + hop;

            const edge = Math.max(
                Math.abs(p.x - centerX) / GRAIN_RADIUS,
                Math.abs(p.z - centerZ) / GRAIN_RADIUS
            );
            const fade = THREE.MathUtils.clamp((1.0 - edge) / 0.22, 0.0, 1.0);
            const s = p.size * fade;

            dummy.position.set(p.x, p.y, p.z);
            dummy.rotation.set(time * 5.0 + p.phase, time * 3.7 + i, 0);
            // Чуть вытягиваем песчинку вдоль скорости для эффекта смаза движения
            dummy.scale.set(s * (1.0 + Math.min(0.8, windSpeed * 0.08)), s, s);
            dummy.updateMatrix();
            grainMesh.setMatrixAt(i, dummy.matrix);
        }
        grainMesh.instanceMatrix.needsUpdate = true;
    }

    function dispose(): void {
        if (streakMesh.parent) streakMesh.parent.remove(streakMesh);
        if (sheetMesh.parent) sheetMesh.parent.remove(sheetMesh);
        if (grainMesh.parent) grainMesh.parent.remove(grainMesh);
        streakGeometry.dispose();
        grainGeometry.dispose();
        streakMaterial.dispose();
        sheetMaterial.dispose();
        grainMaterial.dispose();
        streakMesh.dispose();
        sheetMesh.dispose();
        grainMesh.dispose();
    }

    return { update, dispose };
}


