import * as THREE from 'three';
import { BUGGY } from '../config.ts';
import { applyPS1VertexSnap } from '../render/ps1Material.ts';
import type { IVehicleModel, VehicleAttachPoints } from './types.ts';

export interface CreateBuggyModelOptions {
    scene: THREE.Scene;
    scale?: number;
    id?: string;
}

export function createDefaultVehicleAttachPoints(): VehicleAttachPoints {
    return {
        seatPosition: new THREE.Vector3(),
        seatQuaternion: new THREE.Quaternion(),
        leftHandPosition: new THREE.Vector3(),
        rightHandPosition: new THREE.Vector3(),
        leftFootPosition: new THREE.Vector3(),
        rightFootPosition: new THREE.Vector3(),
        leftFootQuaternion: new THREE.Quaternion(),
        rightFootQuaternion: new THREE.Quaternion(),
        dismountPosition: new THREE.Vector3(),
        dismountYaw: 0
    };
}

/**
 * Процедурный 3D-риг пустынного мотоцикла-багги в эстетике PS1,
 * портированный из бывшего standalone buggy.html и интегрированный
 * с контрактом независимого транспортного модуля IVehicleModel.
 */
export function createBuggyModel({
    scene,
    scale = 1.0,
    id = BUGGY.id
}: CreateBuggyModelOptions): IVehicleModel {
    if (!scene) {
        throw new Error('Buggy model requires a Three.js scene');
    }

    // ============================================================================
    // 1. ПРОЦЕДУРНЫЕ LOW-RES ТЕКСТУРЫ В СТИЛЕ PS1 (БРОНЯ, ПРОТЕКТОР, МЕТАЛЛ, СЕДЛО)
    // ============================================================================
    function createPS1Texture(
        width: number,
        height: number,
        drawFn: (x: number, y: number, w: number, h: number) => number[] | [number, number, number],
        repeatX = 1,
        repeatY = 1
    ): THREE.Texture {
        if (typeof document === 'undefined') {
            return new THREE.DataTexture(new Uint8Array(width * height * 4), width, height);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(width, height);
        const data = img.data;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const rgb = drawFn(x, y, width, height);
                const r = Math.min(255, Math.max(0, Math.round(rgb[0])));
                const g = Math.min(255, Math.max(0, Math.round(rgb[1])));
                const b = Math.min(255, Math.max(0, Math.round(rgb[2])));
                const idx = (y * width + x) * 4;
                data[idx] = r;
                data[idx + 1] = g;
                data[idx + 2] = b;
                data[idx + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeatX, repeatY);
        tex.needsUpdate = true;
        return tex;
    }

    // Выгоревшая желто-охристая пустынная броня с заклепками и фаской
    const desertArmorTex = createPS1Texture(64, 64, (x, y, w, h) => {
        let r = 188, g = 144, b = 74;
        const border = (x < 2 || y < 2 || x >= w - 2 || y >= h - 2 || x === 31 || y === 31);
        if (border) {
            r = 70; g = 62; b = 54;
        } else {
            const rx = x % 32, ry = y % 32;
            const isRivet = (rx === 4 || rx === 27) && (ry === 4 || ry === 27);
            if (isRivet) {
                r = 52; g = 48; b = 44;
            } else {
                const grad = Math.sin((y / h) * Math.PI * 2) * 9;
                r += grad; g += grad * 0.8; b += grad * 0.5;
            }
        }
        return [r, g, b];
    });

    // Черно-желтая диагональная маркировка безопасности (Hazard Stripes)
    const hazardStripeTex = createPS1Texture(32, 32, (x, y) => {
        const stripe = ((x + y) >> 2) & 1;
        return stripe ? [206, 154, 44] : [36, 34, 32];
    });

    // Темный ребристый металл картера двигателя и воздушного охлаждения цилиндров
    const engineBlockTex = createPS1Texture(32, 32, (x, y, _w, h) => {
        let r = 62, g = 65, b = 70;
        if (y % 3 === 0) {
            r -= 20; g -= 20; b -= 20;
        }
        const bolt = (y === 5 || y === h - 6) && (x % 8 === 0);
        if (bolt) {
            r += 38; g += 36; b += 32;
        }
        return [r, g, b];
    });

    // Оксидированная сталь трубчатой рамы и маятников
    const rustyFrameTex = createPS1Texture(32, 32, (x, y, w, h) => {
        let r = 80, g = 73, b = 66;
        const border = (x < 2 || y < 2 || x >= w - 2 || y >= h - 2);
        if (border) {
            r -= 22; g -= 20; b -= 18;
        }
        return [r, g, b];
    });

    // Грубая вулканизированная резина пустынных шин с протектором-шашечками
    const knobbyTireTex = createPS1Texture(64, 64, (x, y) => {
        let r = 34, g = 33, b = 35;
        const row = (y >> 3) & 1;
        const col = ((x + row * 4) >> 3) & 1;
        if (col) {
            r += 14; g += 13; b += 12;
        }
        if (x < 6 || x > 57) {
            r = 46; g = 42; b = 38;
        }
        return [r, g, b];
    }, 2, 1);

    // Хромированная сталь штоков вилки и тормозных дисков
    const chromeRodTex = createPS1Texture(16, 32, (x) => {
        const sheen = Math.sin((x / 16) * Math.PI) * 48;
        return [165 + sheen, 172 + sheen, 178 + sheen];
    });

    // Армированные гидравлические шланги и гофры
    const rubberHoseTex = createPS1Texture(32, 32, (_x, y) => {
        const rib = Math.sin((y / 32) * Math.PI * 12);
        const shade = Math.floor(rib * 16);
        return [42 + shade, 40 + shade, 38 + shade];
    });

    // Прошитая коричневая кожа седла мотоцикла
    const saddleLeatherTex = createPS1Texture(32, 32, (x, y, w) => {
        let r = 92, g = 58, b = 38;
        const stitch = (y % 6 === 0) || (x === 3 || x === w - 4);
        if (stitch) {
            r -= 20; g -= 14; b -= 10;
        }
        return [r, g, b];
    });

    // Янтарно-оранжевая галогенная оптика прожектора
    const amberOpticTex = createPS1Texture(32, 32, (x, y, w, h) => {
        const cx = x - w * 0.5;
        const cy = y - h * 0.5;
        const dist = Math.sqrt(cx * cx + cy * cy) / (w * 0.5);
        const glow = Math.max(0, 1.0 - dist * 0.52);
        const scanline = (y & 1) ? 0.94 : 1.06;
        const glint = (x + y > 18 && x + y < 23) ? 45 : 0;
        return [
            Math.min(255, (240 * glow + glint) * scanline),
            Math.min(255, (135 * glow + glint * 0.6) * scanline),
            Math.min(255, (28 * glow + glint * 0.2))
        ];
    });

    // Рубиново-красный задний стоп-сигнал
    const rubyTailTex = createPS1Texture(16, 16, (_x, y) => {
        const stripe = (y & 1) ? 1.0 : 0.85;
        return [215 * stripe, 32 * stripe, 28 * stripe];
    });

    const matDesertArmor = new THREE.MeshLambertMaterial({ map: desertArmorTex, flatShading: true });
    const matHazardStripe = new THREE.MeshLambertMaterial({ map: hazardStripeTex, flatShading: true });
    const matEngineBlock = new THREE.MeshLambertMaterial({ map: engineBlockTex, flatShading: true });
    const matRustyFrame = new THREE.MeshLambertMaterial({ map: rustyFrameTex, flatShading: true });
    const matKnobbyTire = new THREE.MeshLambertMaterial({ map: knobbyTireTex, flatShading: true });
    const matChromeRod = new THREE.MeshLambertMaterial({ map: chromeRodTex, flatShading: true });
    const matRubberHose = new THREE.MeshLambertMaterial({ map: rubberHoseTex, flatShading: true });
    const matLeatherSeat = new THREE.MeshLambertMaterial({ map: saddleLeatherTex, flatShading: true });
    const matAmberOptic = new THREE.MeshLambertMaterial({ map: amberOpticTex, flatShading: true });
    const matRubyTail = new THREE.MeshLambertMaterial({ map: rubyTailTex, flatShading: true });
    const matCopperExhaust = new THREE.MeshLambertMaterial({ color: 0xa86434, flatShading: true });
    const matDarkSteel = new THREE.MeshLambertMaterial({ color: 0x282a2e, flatShading: true });

    const allMaterials = [
        matDesertArmor,
        matHazardStripe,
        matEngineBlock,
        matRustyFrame,
        matKnobbyTire,
        matChromeRod,
        matRubberHose,
        matLeatherSeat,
        matAmberOptic,
        matRubyTail,
        matCopperExhaust,
        matDarkSteel
    ];
    for (const mat of allMaterials) {
        applyPS1VertexSnap(mat);
    }

    const allTextures = [
        desertArmorTex,
        hazardStripeTex,
        engineBlockTex,
        rustyFrameTex,
        knobbyTireTex,
        chromeRodTex,
        rubberHoseTex,
        saddleLeatherTex,
        amberOpticTex,
        rubyTailTex
    ];

    // ============================================================================
    // 2. УТИЛИТЫ СБОРКИ УЗЛОВ И РАБОЧИХ ТЕЛЕСКОПИЧЕСКИХ АМОРТИЗАТОРОВ
    // ============================================================================
    const rigRootGroup = new THREE.Group();
    rigRootGroup.name = `transport_${id}_root`;
    scene.add(rigRootGroup);

    function addPart(
        parent: THREE.Object3D,
        geom: THREE.BufferGeometry,
        mat: THREE.Material,
        x = 0,
        y = 0,
        z = 0,
        rx = 0,
        ry = 0,
        rz = 0
    ): THREE.Mesh {
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx, ry, rz);
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        parent.add(mesh);
        return mesh;
    }

    function addMechanicalHub(
        parent: THREE.Object3D,
        radius: number,
        width: number,
        x: number,
        y: number,
        z: number,
        axis: 'x' | 'y' | 'z' = 'x'
    ): THREE.Group {
        const hub = new THREE.Group();
        hub.position.set(x, y, z);
        if (axis === 'x') hub.rotation.z = Math.PI / 2;
        else if (axis === 'z') hub.rotation.x = Math.PI / 2;
        parent.add(hub);

        addPart(hub, new THREE.CylinderGeometry(radius, radius, width, 8), matEngineBlock, 0, 0, 0);
        addPart(hub, new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, width + 0.018, 8), matRustyFrame, 0, 0, 0);
        addPart(hub, new THREE.CylinderGeometry(radius * 0.44, radius * 0.44, width + 0.032, 6), matCopperExhaust, 0, 0, 0);
        addPart(hub, new THREE.CylinderGeometry(radius * 0.24, radius * 0.24, width + 0.048, 6), matChromeRod, 0, 0, 0);
        return hub;
    }

    interface ActiveShock {
        parentA: THREE.Object3D;
        localA: THREE.Vector3;
        parentB: THREE.Object3D;
        localB: THREE.Vector3;
        barrelPivot: THREE.Group;
        rodPivot: THREE.Group;
    }
    const activeShocks: ActiveShock[] = [];
    const _shockPosA = new THREE.Vector3();
    const _shockPosB = new THREE.Vector3();
    const _vShockDir = new THREE.Vector3();
    const _vShockUp = new THREE.Vector3(0, 1, 0);
    const _vShockRight = new THREE.Vector3();
    const _vShockOrthoUp = new THREE.Vector3();
    const _vShockLateral = new THREE.Vector3(1, 0, 0);
    const _mShock = new THREE.Matrix4();

    function registerHydraulicShock(
        parentA: THREE.Object3D,
        localVecA: THREE.Vector3,
        parentB: THREE.Object3D,
        localVecB: THREE.Vector3,
        barrelRadius: number,
        barrelLen: number,
        rodLen: number,
        withCoilRings = true
    ): void {
        const barrelPivot = new THREE.Group();
        rigRootGroup.add(barrelPivot);

        addPart(barrelPivot, new THREE.CylinderGeometry(barrelRadius * 1.18, barrelRadius * 1.18, barrelRadius * 1.8, 6), matDarkSteel, 0, 0, 0, 0, 0, Math.PI / 2);
        addPart(barrelPivot, new THREE.CylinderGeometry(barrelRadius, barrelRadius, barrelLen, 7), matRustyFrame, 0, 0, barrelLen * 0.5, Math.PI / 2, 0, 0);
        addPart(barrelPivot, new THREE.CylinderGeometry(barrelRadius * 1.15, barrelRadius * 1.15, 0.03, 7), matCopperExhaust, 0, 0, barrelLen, Math.PI / 2, 0, 0);

        if (withCoilRings) {
            const rings = 5;
            for (let i = 0; i < rings; i++) {
                const zPos = barrelLen * 0.28 + (i / rings) * (barrelLen * 0.85);
                addPart(barrelPivot, new THREE.CylinderGeometry(barrelRadius * 1.38, barrelRadius * 1.38, 0.022, 7), matDesertArmor, 0, 0, zPos, Math.PI / 2, 0, 0);
            }
        }

        const rodPivot = new THREE.Group();
        rigRootGroup.add(rodPivot);

        const rodRadius = barrelRadius * 0.58;
        addPart(rodPivot, new THREE.CylinderGeometry(barrelRadius * 1.08, barrelRadius * 1.08, barrelRadius * 1.6, 6), matDarkSteel, 0, 0, 0, 0, 0, Math.PI / 2);
        addPart(rodPivot, new THREE.CylinderGeometry(rodRadius, rodRadius, rodLen, 7), matChromeRod, 0, 0, rodLen * 0.5, Math.PI / 2, 0, 0);

        activeShocks.push({
            parentA,
            localA: localVecA.clone(),
            parentB,
            localB: localVecB.clone(),
            barrelPivot,
            rodPivot
        });
    }

    function orientShock(pivot: THREE.Object3D, fromPos: THREE.Vector3, toPos: THREE.Vector3): void {
        pivot.position.copy(fromPos);
        _vShockDir.subVectors(toPos, fromPos);
        const dist = _vShockDir.length();
        if (dist < 0.0001) return;
        _vShockDir.divideScalar(dist);

        _vShockRight.crossVectors(_vShockLateral, _vShockDir);
        if (_vShockRight.lengthSq() < 0.0001) {
            _vShockRight.crossVectors(_vShockUp, _vShockDir);
        }
        _vShockRight.normalize();
        _vShockOrthoUp.crossVectors(_vShockDir, _vShockRight).normalize();
        _mShock.makeBasis(_vShockRight, _vShockOrthoUp, _vShockDir);
        pivot.quaternion.setFromRotationMatrix(_mShock);
    }

    function updateAllHydraulicShocks(): void {
        for (let i = 0; i < activeShocks.length; i++) {
            const s = activeShocks[i];
            _shockPosA.copy(s.localA);
            s.parentA.localToWorld(_shockPosA);

            _shockPosB.copy(s.localB);
            s.parentB.localToWorld(_shockPosB);

            orientShock(s.barrelPivot, _shockPosA, _shockPosB);
            orientShock(s.rodPivot, _shockPosB, _shockPosA);
        }
    }

    // ============================================================================
    // 3. КОНСТРУКТОР МАССИВНЫХ ПУСТЫННЫХ КОЛЕС С ГРУНТОЗАЦЕПАМИ И ДИСКОВЫМИ ТОРМОЗАМИ
    // ============================================================================
    function createDesertWheel(wheelRadius: number, tireWidth: number, lugCount = 12): THREE.Group {
        const wheelSpinGroup = new THREE.Group();

        const rimRadius = wheelRadius * 0.56;
        const tireInnerRadius = wheelRadius * 0.88;

        addPart(wheelSpinGroup, new THREE.CylinderGeometry(tireInnerRadius, tireInnerRadius, tireWidth, 12), matKnobbyTire, 0, 0, 0, 0, 0, Math.PI / 2);
        addPart(wheelSpinGroup, new THREE.CylinderGeometry(wheelRadius * 0.94, wheelRadius * 0.94, tireWidth * 0.78, 12), matKnobbyTire, 0, 0, 0, 0, 0, Math.PI / 2);

        const lugHeight = wheelRadius * 0.14;
        const lugDepth = wheelRadius * 0.20;
        for (let i = 0; i < lugCount; i++) {
            const angle = (i / lugCount) * Math.PI * 2;
            const sideShift = (i % 2 === 0 ? -1 : 1) * (tireWidth * 0.14);
            const lugGroup = new THREE.Group();
            lugGroup.rotation.x = angle;
            wheelSpinGroup.add(lugGroup);

            addPart(
                lugGroup,
                new THREE.BoxGeometry(tireWidth * 0.68, lugHeight, lugDepth),
                matKnobbyTire,
                sideShift,
                wheelRadius - lugHeight * 0.35,
                0,
                0,
                (i % 2 === 0 ? 0.18 : -0.18),
                0
            );
        }

        addPart(wheelSpinGroup, new THREE.CylinderGeometry(rimRadius, rimRadius, tireWidth * 1.04, 8), matRustyFrame, 0, 0, 0, 0, 0, Math.PI / 2);
        addPart(wheelSpinGroup, new THREE.CylinderGeometry(rimRadius * 0.82, rimRadius * 0.82, tireWidth * 1.08, 8), matDesertArmor, 0, 0, 0, 0, 0, Math.PI / 2);

        for (let k = 0; k < 4; k++) {
            addPart(
                wheelSpinGroup,
                new THREE.BoxGeometry(tireWidth * 1.10, rimRadius * 1.55, 0.055),
                matDarkSteel,
                0,
                0,
                0,
                (k * Math.PI) / 4,
                0,
                0
            );
        }

        addMechanicalHub(wheelSpinGroup, rimRadius * 0.42, tireWidth * 1.18, 0, 0, 0, 'x');
        addPart(
            wheelSpinGroup,
            new THREE.CylinderGeometry(rimRadius * 0.74, rimRadius * 0.74, 0.025, 10),
            matChromeRod,
            -tireWidth * 0.56,
            0,
            0,
            0,
            0,
            Math.PI / 2
        );

        return wheelSpinGroup;
    }

    // ============================================================================
    // 4. СБОРКА ТЯЖЕЛОГО ПУСТЫННОГО МОТОЦИКЛА (РАМА, V-TWIN, БАК, ПОДВЕСКА, РУЛЬ)
    // ============================================================================
    const BASE_CHASSIS_Y = BUGGY.baseChassisY;
    const FRONT_WHEEL_RADIUS = BUGGY.frontWheelRadius;
    const FRONT_WHEEL_WIDTH = BUGGY.frontWheelWidth;
    const REAR_WHEEL_RADIUS = BUGGY.rearWheelRadius;
    const REAR_WHEEL_WIDTH = BUGGY.rearWheelWidth;
    const SWINGARM_LEN = BUGGY.swingarmLength;
    const HEAD_ANGLE = BUGGY.headAngle;

    const bikeRoot = new THREE.Group();
    rigRootGroup.add(bikeRoot);

    const chassisGroup = new THREE.Group();
    chassisGroup.position.set(0, BASE_CHASSIS_Y, 0);
    bikeRoot.add(chassisGroup);

    // --- 4.1 НЕСУЩАЯ ПРОСТРАНСТВЕННАЯ РАМА (TRELLIS FRAME) И ЗАЩИТНЫЙ ПОДрамник ---
    addPart(chassisGroup, new THREE.BoxGeometry(0.32, 0.08, 0.78), matDarkSteel, 0, -0.34, 0.08);
    addPart(chassisGroup, new THREE.BoxGeometry(0.30, 0.07, 0.34), matHazardStripe, 0, -0.25, 0.54, -0.52, 0, 0);

    for (const s of [-1, 1]) {
        addPart(chassisGroup, new THREE.CylinderGeometry(0.028, 0.028, 0.72, 6), matRustyFrame, s * 0.14, 0.02, 0.44, 0.68, 0, 0);
        addPart(chassisGroup, new THREE.CylinderGeometry(0.032, 0.032, 0.86, 6), matRustyFrame, s * 0.13, 0.24, 0.18, 1.48, 0, 0);
        addPart(chassisGroup, new THREE.CylinderGeometry(0.026, 0.026, 0.66, 6), matRustyFrame, s * 0.13, 0.04, -0.42, -0.98, 0, 0);
        addPart(chassisGroup, new THREE.CylinderGeometry(0.026, 0.026, 0.48, 6), matRustyFrame, s * 0.24, -0.05, 0.28, 0.2, 0, s * 0.35);
        addPart(chassisGroup, new THREE.BoxGeometry(0.16, 0.03, 0.05), matDarkSteel, s * 0.28, -0.29, -0.08);
    }

    // --- 4.2 СИЛОВАЯ УСТАНОВКА: V-ОБРАЗНЫЙ ДВУХЦИЛИНДРОВЫЙ МОТОР И КОРОБКА ПЕРЕДАЧ ---
    const engineGroup = new THREE.Group();
    engineGroup.position.set(0, -0.14, 0.08);
    chassisGroup.add(engineGroup);

    addPart(engineGroup, new THREE.BoxGeometry(0.30, 0.28, 0.42), matEngineBlock, 0, -0.04, -0.02);
    addMechanicalHub(engineGroup, 0.13, 0.36, 0, -0.05, 0.06, 'x');
    addMechanicalHub(engineGroup, 0.095, 0.34, 0, -0.06, -0.14, 'x');

    for (const cyl of [
        { z: 0.12, pitch: 0.42 },
        { z: -0.08, pitch: -0.38 }
    ]) {
        const cylGroup = new THREE.Group();
        cylGroup.position.set(0, 0.08, cyl.z);
        cylGroup.rotation.x = cyl.pitch;
        engineGroup.add(cylGroup);

        addPart(cylGroup, new THREE.CylinderGeometry(0.115, 0.105, 0.24, 8), matEngineBlock, 0, 0.12, 0);
        addPart(cylGroup, new THREE.BoxGeometry(0.24, 0.07, 0.22), matRustyFrame, 0, 0.25, 0);
        addPart(cylGroup, new THREE.BoxGeometry(0.18, 0.04, 0.16), matCopperExhaust, 0, 0.29, 0);
    }

    for (const s of [-1, 1]) {
        addPart(chassisGroup, new THREE.BoxGeometry(0.08, 0.26, 0.18), matEngineBlock, s * 0.19, 0.04, 0.38, -0.18, s * 0.25, 0);
        addPart(chassisGroup, new THREE.BoxGeometry(0.09, 0.28, 0.04), matDesertArmor, s * 0.20, 0.04, 0.47, -0.18, s * 0.25, 0);
        addPart(chassisGroup, new THREE.CylinderGeometry(0.022, 0.022, 0.26, 6), matRubberHose, s * 0.16, -0.08, 0.26, 0.85, 0, 0);
    }

    // --- 4.3 ГРАНЕный БРОНИРОВАННЫЙ ТОПЛИВНЫЙ БАК, СЕДЛО И ХВОСТОВОЙ КОФР ---
    addPart(chassisGroup, new THREE.BoxGeometry(0.38, 0.24, 0.56), matDesertArmor, 0, 0.26, 0.20, -0.10, 0, 0);
    addPart(chassisGroup, new THREE.BoxGeometry(0.30, 0.10, 0.46), matDesertArmor, 0, 0.38, 0.18, -0.06, 0, 0);
    addPart(chassisGroup, new THREE.BoxGeometry(0.16, 0.05, 0.36), matHazardStripe, 0, 0.425, 0.18, -0.06, 0, 0);
    addPart(chassisGroup, new THREE.CylinderGeometry(0.048, 0.052, 0.04, 7), matChromeRod, 0, 0.45, 0.28);

    for (const s of [-1, 1]) {
        addPart(chassisGroup, new THREE.BoxGeometry(0.06, 0.22, 0.44), matDesertArmor, s * 0.21, 0.20, 0.32, 0.16, s * 0.15, 0);
        addPart(chassisGroup, new THREE.BoxGeometry(0.065, 0.08, 0.28), matHazardStripe, s * 0.215, 0.18, 0.36, 0.16, s * 0.15, 0);
    }

    // Анатомическое кожаное седло с поясничным упором
    addPart(chassisGroup, new THREE.BoxGeometry(0.32, 0.08, 0.48), matLeatherSeat, 0, 0.25, -0.24, 0.05, 0, 0);
    addPart(chassisGroup, new THREE.BoxGeometry(0.28, 0.10, 0.16), matLeatherSeat, 0, 0.31, -0.44, 0.25, 0, 0);

    // Задний бронированный хвост, багажная рама, канистры и стоп-сигнал
    addPart(chassisGroup, new THREE.BoxGeometry(0.34, 0.16, 0.44), matDesertArmor, 0, 0.28, -0.66, 0.14, 0, 0);
    addPart(chassisGroup, new THREE.BoxGeometry(0.26, 0.06, 0.26), matHazardStripe, 0, 0.37, -0.66, 0.14, 0, 0);
    addPart(chassisGroup, new THREE.BoxGeometry(0.18, 0.055, 0.04), matRubyTail, 0, 0.28, -0.89, 0.14, 0, 0);

    for (const s of [-1, 1]) {
        addPart(chassisGroup, new THREE.BoxGeometry(0.11, 0.24, 0.30), matRustyFrame, s * 0.22, 0.22, -0.62, 0.10, 0, 0);
        addPart(chassisGroup, new THREE.BoxGeometry(0.115, 0.06, 0.28), matDesertArmor, s * 0.22, 0.24, -0.62, 0.10, 0, 0);
        addPart(chassisGroup, new THREE.CylinderGeometry(0.028, 0.032, 0.48, 6), matCopperExhaust, s * 0.19, -0.18, -0.05, Math.PI / 2 + 0.22, 0, 0);
        addPart(chassisGroup, new THREE.CylinderGeometry(0.052, 0.046, 0.52, 7), matEngineBlock, s * 0.21, 0.06, -0.52, Math.PI / 2 - 0.28, 0, s * 0.06);
        addPart(chassisGroup, new THREE.CylinderGeometry(0.056, 0.056, 0.24, 7), matRustyFrame, s * 0.21, 0.05, -0.48, Math.PI / 2 - 0.28, 0, s * 0.06);
        addPart(chassisGroup, new THREE.CylinderGeometry(0.038, 0.044, 0.08, 7), matCopperExhaust, s * 0.22, 0.14, -0.78, Math.PI / 2 - 0.28, 0, s * 0.06);
    }

    addPart(chassisGroup, new THREE.CylinderGeometry(0.005, 0.013, 0.68, 5), matRustyFrame, -0.16, 0.66, -0.78, -0.18, 0, 0);

    // --- 4.4 ЗАДНИЙ МАЯТНИК (SWINGARM), РАБОЧИЕ АМОРТИЗАТОРЫ И ВЕДУЩЕЕ КОЛЕСО ---
    const swingarmPivotGroup = new THREE.Group();
    swingarmPivotGroup.position.set(0, -0.18, -0.18);
    chassisGroup.add(swingarmPivotGroup);

    addMechanicalHub(chassisGroup, 0.075, 0.38, 0, -0.18, -0.18, 'x');

    for (const s of [-1, 1]) {
        addPart(swingarmPivotGroup, new THREE.BoxGeometry(0.065, 0.11, SWINGARM_LEN), matRustyFrame, s * 0.26, 0, -SWINGARM_LEN * 0.5);
        addPart(swingarmPivotGroup, new THREE.BoxGeometry(0.072, 0.07, 0.24), matDesertArmor, s * 0.26, 0.02, -SWINGARM_LEN * 0.55);
        addPart(swingarmPivotGroup, new THREE.BoxGeometry(0.08, 0.13, 0.16), matDarkSteel, s * 0.26, 0, -SWINGARM_LEN);

        registerHydraulicShock(
            chassisGroup, new THREE.Vector3(s * 0.22, 0.20, -0.34),
            swingarmPivotGroup, new THREE.Vector3(s * 0.26, 0.06, -SWINGARM_LEN * 0.72),
            0.034, 0.26, 0.26, true
        );
    }

    addPart(swingarmPivotGroup, new THREE.BoxGeometry(0.28, 0.05, 0.42), matDesertArmor, 0, 0.34, -SWINGARM_LEN * 0.45, -0.35, 0, 0);
    addPart(swingarmPivotGroup, new THREE.BoxGeometry(0.035, 0.22, SWINGARM_LEN * 0.82), matHazardStripe, -0.295, 0.06, -SWINGARM_LEN * 0.48);

    const rearWheelMount = new THREE.Group();
    rearWheelMount.position.set(0, 0, -SWINGARM_LEN);
    swingarmPivotGroup.add(rearWheelMount);

    const rearWheelSpinGroup = createDesertWheel(REAR_WHEEL_RADIUS, REAR_WHEEL_WIDTH, 14);
    rearWheelMount.add(rearWheelSpinGroup);

    // --- 4.5 ПЕРЕДНЯЯ РУЛЕВАЯ КОЛОНКА, ТЕЛЕСКОПИЧЕСКАЯ ВИЛКА, ПРОЖЕКТОР И КОЛЕСО ---
    const steeringRakeGroup = new THREE.Group();
    steeringRakeGroup.position.set(0, 0.28, 0.64);
    steeringRakeGroup.rotation.x = HEAD_ANGLE;
    chassisGroup.add(steeringRakeGroup);

    const steeringYawGroup = new THREE.Group();
    steeringRakeGroup.add(steeringYawGroup);

    addPart(steeringYawGroup, new THREE.CylinderGeometry(0.055, 0.055, 0.26, 8), matRustyFrame, 0, 0, 0);
    addPart(steeringYawGroup, new THREE.BoxGeometry(0.46, 0.055, 0.14), matDarkSteel, 0, 0.11, 0.04);
    addPart(steeringYawGroup, new THREE.BoxGeometry(0.46, 0.055, 0.14), matDarkSteel, 0, -0.11, 0.04);

    // Широкий кроссовый руль с защитой рукояток
    addPart(steeringYawGroup, new THREE.CylinderGeometry(0.018, 0.018, 0.78, 6), matRustyFrame, 0, 0.24, -0.01, 0, 0, Math.PI / 2);
    addPart(steeringYawGroup, new THREE.CylinderGeometry(0.012, 0.012, 0.44, 6), matDarkSteel, 0, 0.29, -0.01, 0, 0, Math.PI / 2);
    addPart(steeringYawGroup, new THREE.CylinderGeometry(0.026, 0.026, 0.22, 6), matHazardStripe, 0, 0.29, -0.01, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) {
        addPart(steeringYawGroup, new THREE.CylinderGeometry(0.022, 0.022, 0.15, 6), matRubberHose, s * 0.35, 0.24, -0.01, 0, 0, Math.PI / 2);
        addPart(steeringYawGroup, new THREE.BoxGeometry(0.14, 0.07, 0.04), matDesertArmor, s * 0.34, 0.24, 0.05, 0, -s * 0.22, 0);
    }

    // Передний бронированный обтекатель и сдвоенный прожектор
    const headlightGroup = new THREE.Group();
    headlightGroup.position.set(0, 0.04, 0.14);
    headlightGroup.rotation.x = -HEAD_ANGLE;
    steeringYawGroup.add(headlightGroup);

    addPart(headlightGroup, new THREE.BoxGeometry(0.32, 0.30, 0.14), matDesertArmor, 0, 0.02, 0.02);
    addPart(headlightGroup, new THREE.BoxGeometry(0.28, 0.14, 0.10), matHazardStripe, 0, 0.18, -0.01, -0.35, 0, 0);
    addPart(headlightGroup, new THREE.CylinderGeometry(0.014, 0.014, 0.36, 6), matRustyFrame, 0, 0.12, 0.10, 0, 0, Math.PI / 2);

    addPart(headlightGroup, new THREE.CylinderGeometry(0.078, 0.084, 0.10, 8), matRustyFrame, -0.065, 0.01, 0.08, Math.PI / 2, 0, 0);
    addPart(headlightGroup, new THREE.CylinderGeometry(0.068, 0.068, 0.105, 8), matCopperExhaust, -0.065, 0.01, 0.082, Math.PI / 2, 0, 0);
    addPart(headlightGroup, new THREE.CylinderGeometry(0.056, 0.056, 0.11, 8), matAmberOptic, -0.065, 0.01, 0.085, Math.PI / 2, 0, 0);

    addPart(headlightGroup, new THREE.CylinderGeometry(0.048, 0.052, 0.09, 7), matRustyFrame, 0.075, 0.02, 0.075, Math.PI / 2, 0, 0);
    addPart(headlightGroup, new THREE.CylinderGeometry(0.036, 0.036, 0.095, 7), matAmberOptic, 0.075, 0.02, 0.08, Math.PI / 2, 0, 0);

    addPart(headlightGroup, new THREE.BoxGeometry(0.26, 0.055, 0.42), matDesertArmor, 0, -0.15, 0.18, 0.18, 0, 0);

    // Подвижные стаканы передней вилки и переднее колесо
    const frontAxleSliderGroup = new THREE.Group();
    frontAxleSliderGroup.position.set(0, -0.60, 0.08);
    steeringYawGroup.add(frontAxleSliderGroup);

    for (const s of [-1, 1]) {
        addPart(frontAxleSliderGroup, new THREE.CylinderGeometry(0.042, 0.038, 0.36, 7), matRustyFrame, s * 0.21, 0.14, -0.02);
        addPart(frontAxleSliderGroup, new THREE.BoxGeometry(0.06, 0.26, 0.10), matDesertArmor, s * 0.225, 0.15, 0.03);
        addPart(frontAxleSliderGroup, new THREE.BoxGeometry(0.07, 0.10, 0.12), matDarkSteel, s * 0.21, 0, 0);

        registerHydraulicShock(
            steeringYawGroup, new THREE.Vector3(s * 0.21, 0.10, 0.04),
            frontAxleSliderGroup, new THREE.Vector3(s * 0.21, 0.02, 0.0),
            0.032, 0.34, 0.38, false
        );
    }

    const frontWheelUprightGroup = new THREE.Group();
    frontWheelUprightGroup.rotation.x = -HEAD_ANGLE;
    frontAxleSliderGroup.add(frontWheelUprightGroup);

    const frontWheelSpinGroup = createDesertWheel(FRONT_WHEEL_RADIUS, FRONT_WHEEL_WIDTH, 12);
    frontWheelUprightGroup.add(frontWheelSpinGroup);

    // ============================================================================
    // 5. ЯКОРНЫЕ УЗЛЫ ПРИВЯЗКИ ПИЛОТА (SEAT, HANDLEBAR GRIPS, FOOTPEGS, DISMOUNT)
    // ============================================================================
    // Таз Cosmo (pelvisGroup) ставится на верх кожаного седла (y=0.29) и прижимается к спинке (z=-0.36).
    // С учетом нижнего пахового киля (y_local = -0.19) и задней бронеплиты таза (z_local = -0.20):
    const seatAnchor = new THREE.Group();
    seatAnchor.name = 'seatAnchor';
    seatAnchor.position.set(0, 0.47, -0.14);
    chassisGroup.add(seatAnchor);

    // Центры резиновых рукояток руля в steeringYawGroup (вращаются вместе с рулем!)
    const leftGripAnchor = new THREE.Group();
    leftGripAnchor.name = 'leftGripAnchor';
    leftGripAnchor.position.set(-0.35, 0.24, -0.01);
    steeringYawGroup.add(leftGripAnchor);

    const rightGripAnchor = new THREE.Group();
    rightGripAnchor.name = 'rightGripAnchor';
    rightGripAnchor.position.set(0.35, 0.24, -0.01);
    steeringYawGroup.add(rightGripAnchor);

    // Опорные площадки подножек на раме (подошва стопы ставится на подножку с легким наклоном носка вниз)
    const leftPegAnchor = new THREE.Group();
    leftPegAnchor.name = 'leftPegAnchor';
    leftPegAnchor.position.set(-0.29, -0.275, -0.09);
    leftPegAnchor.rotation.set(0.16, 0.08, 0);
    chassisGroup.add(leftPegAnchor);

    const rightPegAnchor = new THREE.Group();
    rightPegAnchor.name = 'rightPegAnchor';
    rightPegAnchor.position.set(0.29, -0.275, -0.09);
    rightPegAnchor.rotation.set(0.16, -0.08, 0);
    chassisGroup.add(rightPegAnchor);

    // Точка безопасного спешивания слева от мотоцикла
    const dismountAnchor = new THREE.Group();
    dismountAnchor.name = 'dismountAnchor';
    dismountAnchor.position.set(BUGGY.dismountOffsetX, 0, BUGGY.dismountOffsetZ);
    bikeRoot.add(dismountAnchor);

    // ============================================================================
    // 6. ПУБЛИЧНЫЙ ИНТЕРФЕЙС МОДЕЛИ И ОБНОВЛЕНИЕ КИНЕМАТИКИ ПОДВЕСКИ
    // ============================================================================
    const defaultAttachPoints = createDefaultVehicleAttachPoints();

    const model: IVehicleModel = {
        id,
        group: rigRootGroup,
        joints: {
            bikeRoot,
            chassisGroup,
            engineGroup,
            swingarmPivotGroup,
            rearWheelSpinGroup,
            steeringRakeGroup,
            steeringYawGroup,
            headlightGroup,
            frontAxleSliderGroup,
            frontWheelSpinGroup,
            seatAnchor,
            leftGripAnchor,
            rightGripAnchor,
            leftPegAnchor,
            rightPegAnchor,
            dismountAnchor
        },
        pose: {
            rootPosition: new THREE.Vector3(0, 0, 0),
            rootYaw: 0.0,
            chassisHeightOffset: 0.0,
            chassisPitch: 0.0,
            chassisRoll: 0.0,
            steeringAngle: 0.0,
            frontGroundY: 0.0,
            rearGroundY: 0.0,
            frontWheelSpin: 0.0,
            rearWheelSpin: 0.0
        },

        update(_groundAt = null): void {
            bikeRoot.position.copy(this.pose.rootPosition);
            bikeRoot.rotation.set(0, this.pose.rootYaw, 0);

            chassisGroup.position.set(0, BASE_CHASSIS_Y + this.pose.chassisHeightOffset, 0);
            chassisGroup.rotation.set(this.pose.chassisPitch, 0, this.pose.chassisRoll);

            steeringYawGroup.rotation.y = THREE.MathUtils.clamp(
                this.pose.steeringAngle,
                -BUGGY.maxSteerAngle,
                BUGGY.maxSteerAngle
            );

            // Кинематика заднего маятника и передней вилки:
            // Поскольку rootPosition.y и chassisPitch уже выравнивают базу колес по линии склона
            // (rearGroundY -> frontGroundY), маятник и вилка отрабатывают чистое сжатие подвески
            // chassisHeightOffset, удерживая шины в плотном контакте с песком без двойного вычитания уклона.
            const dyRear = THREE.MathUtils.clamp(
                -0.02 - this.pose.chassisHeightOffset,
                -SWINGARM_LEN * 0.35,
                SWINGARM_LEN * 0.35
            );
            swingarmPivotGroup.rotation.x = THREE.MathUtils.clamp(
                Math.asin(dyRear / SWINGARM_LEN),
                -0.32,
                0.32
            );

            const cosRake = Math.max(0.65, Math.cos(HEAD_ANGLE));
            const forkTravelY = -0.60 - this.pose.chassisHeightOffset / cosRake;
            frontAxleSliderGroup.position.y = THREE.MathUtils.clamp(forkTravelY, -0.72, -0.48);

            // Вращение колес вокруг поперечной оси X
            frontWheelSpinGroup.rotation.x = this.pose.frontWheelSpin;
            rearWheelSpinGroup.rotation.x = this.pose.rearWheelSpin;

            rigRootGroup.updateMatrixWorld(true);
            updateAllHydraulicShocks();
        },

        getAttachPoints(out: VehicleAttachPoints = defaultAttachPoints): VehicleAttachPoints {
            rigRootGroup.updateMatrixWorld(true);

            seatAnchor.getWorldPosition(out.seatPosition);
            seatAnchor.getWorldQuaternion(out.seatQuaternion);

            leftGripAnchor.getWorldPosition(out.leftHandPosition);
            rightGripAnchor.getWorldPosition(out.rightHandPosition);

            leftPegAnchor.getWorldPosition(out.leftFootPosition);
            leftPegAnchor.getWorldQuaternion(out.leftFootQuaternion);

            rightPegAnchor.getWorldPosition(out.rightFootPosition);
            rightPegAnchor.getWorldQuaternion(out.rightFootQuaternion);

            dismountAnchor.getWorldPosition(out.dismountPosition);
            out.dismountYaw = this.pose.rootYaw;
            return out;
        },

        dispose(): void {
            if (rigRootGroup.parent) {
                rigRootGroup.parent.remove(rigRootGroup);
            }
            const geometries = new Set<THREE.BufferGeometry>();
            rigRootGroup.traverse((obj: THREE.Object3D) => {
                const mesh = obj as THREE.Mesh;
                if (mesh.geometry) geometries.add(mesh.geometry);
            });
            geometries.forEach(g => g.dispose());
            allMaterials.forEach(m => m.dispose());
            allTextures.forEach(t => t.dispose());
        }
    };

    model.update();
    rigRootGroup.scale.setScalar(scale);
    return model;
}
