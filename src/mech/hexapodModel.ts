// Модель шестиногого промышленного шагохода: модульный корпус
// (центральное ядро с открытой фермой, носовая рубка со смотровой щелью
// и камерами, боковые спонсоны, верхняя надстройка с башней охлаждения
// и поручнями) и шесть массивных ног с читаемыми шарнирами.
// Геометрия собрана в единицах прототипа; в мир приходит масштабом
// HEXAPOD.scale, который выставляет mechRig.
import * as THREE from 'three';
import { HEXAPOD, MECH } from '../config.ts';
import type { HexapodMaterials } from './hexapodMaterials.ts';

const BASE_CHASSIS_Y = HEXAPOD.baseChassisY;
const FEMUR_LENGTH = HEXAPOD.femurLength;
const TIBIA_LENGTH = HEXAPOD.tibiaLength;
const ANKLE_HEIGHT = HEXAPOD.ankleHeight;

// Граненый блок со скосами: низ и верх могут иметь разную ширину/глубину
function createSlopedBlock(
    wBot: number,
    dBot: number,
    wTop: number,
    dTop: number,
    height: number,
    offsetTopX = 0,
    offsetTopZ = 0
): THREE.BufferGeometry {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const pos = geom.attributes.position;

    for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const vz = pos.getZ(i);

        if (vy > 0) {
            pos.setX(i, vx * wTop + offsetTopX);
            pos.setY(i, height * 0.5);
            pos.setZ(i, vz * dTop + offsetTopZ);
        } else {
            pos.setX(i, vx * wBot);
            pos.setY(i, -height * 0.5);
            pos.setZ(i, vz * dBot);
        }
    }

    geom.computeVertexNormals();
    return geom;
}

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
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
}

// Блок камеры/выключенного прожектора: кожух, темная ниша и объектив
function createCameraPod(materials: HexapodMaterials, width: number, height: number, depth: number, twin = false): THREE.Group {
    const { secondaryMat, slitMat, rimMat, lensMat } = materials;
    const group = new THREE.Group();
    addPart(group, createSlopedBlock(width, depth, width * 0.92, depth * 0.92, height, 0, 0), secondaryMat, 0, 0, 0);
    addPart(group, new THREE.BoxGeometry(width * 0.82, height * 0.76, 0.06), slitMat, 0, 0, depth * 0.49);

    if (twin) {
        for (const s of [-1, 1]) {
            const lx = s * (width * 0.23);
            addPart(group, new THREE.CylinderGeometry(height * 0.28, height * 0.28, 0.08, 8), rimMat, lx, 0, depth * 0.5, Math.PI / 2, 0, 0);
            addPart(group, new THREE.CylinderGeometry(height * 0.2, height * 0.2, 0.1, 8), lensMat, lx, 0, depth * 0.51, Math.PI / 2, 0, 0);
        }
    } else {
        const rOuter = Math.min(width, height) * 0.34;
        addPart(group, new THREE.CylinderGeometry(rOuter, rOuter, 0.09, 8), rimMat, 0, 0, depth * 0.5, Math.PI / 2, 0, 0);
        addPart(group, new THREE.CylinderGeometry(rOuter * 0.72, rOuter * 0.72, 0.11, 8), lensMat, 0, 0, depth * 0.51, Math.PI / 2, 0, 0);
    }
    return group;
}

export interface HexapodLegConfig {
    id: string;
    side: number;
    mountX: number;
    mountY: number;
    mountZ: number;
    restX: number;
    restZ: number;
    phase: number;
}

// Конфигурация шести ног: широкая паукообразная постановка, триподы
// переступают в противофазе (phase 0 и π)
export const LEG_CONFIGS: HexapodLegConfig[] = [
    { id: 'FL', side: 1, mountX: 2.05, mountY: -0.95, mountZ: 1.95, restX: 5.25, restZ: 5.45, phase: 0.0 },
    { id: 'ML', side: 1, mountX: 2.25, mountY: -0.95, mountZ: -0.15, restX: 6.95, restZ: -0.15, phase: Math.PI },
    { id: 'RL', side: 1, mountX: 2.05, mountY: -0.95, mountZ: -2.25, restX: 5.35, restZ: -5.45, phase: 0.0 },
    { id: 'FR', side: -1, mountX: -2.05, mountY: -0.95, mountZ: 1.95, restX: -5.25, restZ: 5.45, phase: Math.PI },
    { id: 'MR', side: -1, mountX: -2.25, mountY: -0.95, mountZ: -0.15, restX: -6.95, restZ: -0.15, phase: 0.0 },
    { id: 'RR', side: -1, mountX: -2.05, mountY: -0.95, mountZ: -2.25, restX: -5.35, restZ: -5.45, phase: Math.PI }
];

export interface HexapodLeg {
    id: string;
    cfg: HexapodLegConfig;
    mountNode: THREE.Group;
    coxaYawGroup: THREE.Group;
    femurPitchGroup: THREE.Group;
    tibiaPitchGroup: THREE.Group;
    footGroup: THREE.Group;
    gaitGroup: number;
    restLocal: THREE.Vector3;
    hipLocal: THREE.Vector3;
    currentFootPos: THREE.Vector3;
    stepStartPos: THREE.Vector3;
    stepTargetPos: THREE.Vector3;
    stepProgress: number;
    isStepping: boolean;
    groundNormal: THREE.Vector3;
    isPlanted: boolean;
    normalLoad: number;
    loadShare: number;
    sink: number;
    sinkRate: number;
    packing: number;
    traction: number;
    groundGap?: number;
    supportForce?: number;
    contactWeight?: number;
    supportIncluded?: boolean;
    [key: string]: any;
}

// Одна нога: поворотный узел (coxa), бронекороб бедра с барабаном колена,
// голень с верхним щитом, открытыми штоками гидравлики и нижним манжетом,
// широкая многосекционная стопа.
function buildMechanicalLeg({
    cfg,
    chassisGroup,
    materials
}: {
    cfg: HexapodLegConfig;
    chassisGroup: THREE.Group;
    materials: HexapodMaterials;
}): HexapodLeg {
    const { darkMat, secondaryMat, armorMat, chromeMat } = materials;

    const mountNode = new THREE.Group();
    mountNode.position.set(cfg.mountX, cfg.mountY, cfg.mountZ);
    chassisGroup.add(mountNode);

    // 1. COXA: тазовый поворотный шарнир с вилкой крепления бедра
    const coxaYawGroup = new THREE.Group();
    mountNode.add(coxaYawGroup);

    addPart(coxaYawGroup, new THREE.CylinderGeometry(0.58, 0.62, 0.88, 8), darkMat, 0, 0, 0);
    addPart(coxaYawGroup, new THREE.BoxGeometry(0.26, 0.78, 0.95), secondaryMat, -0.42, 0, 0.35);
    addPart(coxaYawGroup, new THREE.BoxGeometry(0.26, 0.78, 0.95), secondaryMat, 0.42, 0, 0.35);
    addPart(coxaYawGroup, new THREE.CylinderGeometry(0.28, 0.28, 1.15, 8), darkMat, 0, 0, 0.58, 0, 0, Math.PI / 2);

    // 2. FEMUR: массивный бронекороб с гидроприводами и барабаном колена
    const femurPitchGroup = new THREE.Group();
    femurPitchGroup.position.set(0, 0, 0.58);
    coxaYawGroup.add(femurPitchGroup);

    addPart(femurPitchGroup, new THREE.BoxGeometry(0.76, 0.82, FEMUR_LENGTH), darkMat, 0, 0, FEMUR_LENGTH * 0.5);

    const femurBox = createSlopedBlock(1.18, FEMUR_LENGTH * 0.68, 1.06, FEMUR_LENGTH * 0.62, 1.08, 0, 0);
    addPart(femurPitchGroup, femurBox, armorMat, 0, 0.08, FEMUR_LENGTH * 0.44);

    addPart(femurPitchGroup, new THREE.BoxGeometry(1.24, 0.68, 0.24), secondaryMat, 0, 0.08, FEMUR_LENGTH * 0.24);
    addPart(femurPitchGroup, new THREE.BoxGeometry(1.24, 0.68, 0.24), secondaryMat, 0, 0.08, FEMUR_LENGTH * 0.62);

    for (const s of [-1, 1]) {
        addPart(femurPitchGroup, new THREE.CylinderGeometry(0.14, 0.14, FEMUR_LENGTH * 0.55, 6), darkMat, s * 0.26, -0.52, FEMUR_LENGTH * 0.36, Math.PI / 2, 0, 0);
        addPart(femurPitchGroup, new THREE.CylinderGeometry(0.08, 0.08, FEMUR_LENGTH * 0.45, 6), chromeMat, s * 0.26, -0.52, FEMUR_LENGTH * 0.68, Math.PI / 2, 0, 0);
    }

    // Крупный круглый барабанный шарнир колена
    addPart(femurPitchGroup, new THREE.CylinderGeometry(0.64, 0.64, 1.12, 10), darkMat, 0, 0, FEMUR_LENGTH, 0, 0, Math.PI / 2);
    addPart(femurPitchGroup, new THREE.CylinderGeometry(0.42, 0.42, 1.22, 8), secondaryMat, 0, 0, FEMUR_LENGTH, 0, 0, Math.PI / 2);
    addPart(femurPitchGroup, new THREE.CylinderGeometry(0.18, 0.18, 1.28, 6), darkMat, 0, 0, FEMUR_LENGTH, 0, 0, Math.PI / 2);

    // 3. TIBIA: верхний бронещит, открытая гидравлика, нижний манжет
    const tibiaPitchGroup = new THREE.Group();
    tibiaPitchGroup.position.set(0, 0, FEMUR_LENGTH);
    femurPitchGroup.add(tibiaPitchGroup);

    addPart(tibiaPitchGroup, new THREE.BoxGeometry(0.86, 0.42, 0.65), darkMat, 0, 0.58, 0.08);
    addPart(tibiaPitchGroup, new THREE.CylinderGeometry(0.16, 0.16, 0.94, 6), chromeMat, 0, 0.64, 0.08, 0, 0, Math.PI / 2);

    addPart(tibiaPitchGroup, new THREE.BoxGeometry(0.58, 0.62, TIBIA_LENGTH * 0.92), darkMat, 0, -0.08, TIBIA_LENGTH * 0.48);

    // А) Верхний массивный граненый бронещит голени
    const upperShieldGroup = new THREE.Group();
    upperShieldGroup.position.set(0, 0.44, TIBIA_LENGTH * 0.27);
    tibiaPitchGroup.add(upperShieldGroup);

    const shieldMain = createSlopedBlock(1.42, 0.62, 1.26, 0.48, TIBIA_LENGTH * 0.44, 0, 0.04);
    addPart(upperShieldGroup, shieldMain, armorMat, 0, 0, -0.12, -Math.PI / 2, 0, 0);

    const shieldLowerBevel = createSlopedBlock(0.92, 0.42, 1.42, 0.62, TIBIA_LENGTH * 0.14, 0, -0.06);
    addPart(upperShieldGroup, shieldLowerBevel, armorMat, 0, -0.03, TIBIA_LENGTH * 0.17, -Math.PI / 2, 0, 0);

    // Парные утопленные планки-замки на лицевой грани щита
    for (const s of [-1, 1]) {
        addPart(upperShieldGroup, new THREE.BoxGeometry(0.16, 0.12, 0.56), darkMat, s * 0.18, 0.24, -0.18);
        addPart(upperShieldGroup, new THREE.BoxGeometry(0.12, 0.14, 0.14), secondaryMat, s * 0.18, 0.25, -0.18);
    }

    const rearCalfBox = createSlopedBlock(1.05, 0.65, 0.92, 0.55, TIBIA_LENGTH * 0.28, 0, 0);
    addPart(tibiaPitchGroup, rearCalfBox, secondaryMat, 0, -0.46, TIBIA_LENGTH * 0.25, -Math.PI / 2, 0, 0);

    // Б) Открытые парные гидроцилиндры с блестящими штоками
    for (const s of [-1, 1]) {
        addPart(tibiaPitchGroup, new THREE.CylinderGeometry(0.16, 0.16, TIBIA_LENGTH * 0.34, 6), darkMat, s * 0.42, 0.14, TIBIA_LENGTH * 0.38, Math.PI / 2, 0, 0);
        addPart(tibiaPitchGroup, new THREE.CylinderGeometry(0.105, 0.105, TIBIA_LENGTH * 0.36, 6), chromeMat, s * 0.42, 0.14, TIBIA_LENGTH * 0.62, Math.PI / 2, 0, 0);
        addPart(tibiaPitchGroup, new THREE.CylinderGeometry(0.12, 0.12, TIBIA_LENGTH * 0.48, 6), darkMat, s * 0.34, -0.26, TIBIA_LENGTH * 0.56, Math.PI / 2, 0, 0);
    }

    // В) Нижний прямоугольный бронеманжет над щиколоткой
    const lowerCuffGroup = new THREE.Group();
    lowerCuffGroup.position.set(0, 0.06, TIBIA_LENGTH * 0.78);
    tibiaPitchGroup.add(lowerCuffGroup);

    const cuffFront = createSlopedBlock(1.06, 0.58, 0.92, 0.48, TIBIA_LENGTH * 0.25, 0, 0);
    addPart(lowerCuffGroup, cuffFront, armorMat, 0, 0.18, 0, -Math.PI / 2, 0, 0);

    const cuffRear = createSlopedBlock(1.16, 0.64, 0.98, 0.52, TIBIA_LENGTH * 0.22, 0, 0);
    addPart(lowerCuffGroup, cuffRear, secondaryMat, 0, -0.22, 0.04, -Math.PI / 2, 0, 0);

    // Шарнирный узел щиколотки
    addPart(tibiaPitchGroup, new THREE.CylinderGeometry(0.44, 0.48, 0.92, 8), darkMat, 0, 0, TIBIA_LENGTH * 0.96, 0, 0, Math.PI / 2);

    // 4. FOOT PAD: широкая опора с трапециевидными грунтозацепами
    const footGroup = new THREE.Group();
    footGroup.position.set(0, 0, TIBIA_LENGTH);
    tibiaPitchGroup.add(footGroup);

    addPart(footGroup, new THREE.CylinderGeometry(0.56, 0.68, 0.32, 8), darkMat, 0, -0.14, 0);

    const footCore = createSlopedBlock(1.55, 1.65, 1.05, 1.12, ANKLE_HEIGHT * 0.72, 0, 0);
    addPart(footGroup, footCore, secondaryMat, 0, -ANKLE_HEIGHT * 0.55, 0);

    for (const s of [-1, 1]) {
        const frontToe = createSlopedBlock(0.58, 0.82, 0.42, 0.52, 0.44, 0, -0.15);
        addPart(footGroup, frontToe, armorMat, s * 0.42, -ANKLE_HEIGHT + 0.22, 0.78, 0, s * 0.18, 0);
    }
    for (const s of [-1, 1]) {
        const sideToe = createSlopedBlock(0.76, 0.64, 0.48, 0.46, 0.42, -s * 0.14, 0);
        addPart(footGroup, sideToe, armorMat, s * 0.88, -ANKLE_HEIGHT + 0.21, -0.05);
    }
    const rearHeel = createSlopedBlock(0.84, 0.72, 0.58, 0.46, 0.42, 0, 0.14);
    addPart(footGroup, rearHeel, armorMat, 0, -ANKLE_HEIGHT + 0.21, -0.82);

    addPart(footGroup, new THREE.BoxGeometry(1.95, 0.1, 1.95), darkMat, 0, -ANKLE_HEIGHT + 0.05, 0);

    // Поля, которые ведет походка: позиции в мировых единицах и узлы IK
    const S = HEXAPOD.scale;
    const restLocal = new THREE.Vector3(cfg.restX * S, -MECH.rideHeight + 0.2, cfg.restZ * S);
    const hipLocal = new THREE.Vector3(cfg.mountX * S, cfg.mountY * S, cfg.mountZ * S);

    return {
        id: cfg.id,
        cfg,
        mountNode,
        coxaYawGroup,
        femurPitchGroup,
        tibiaPitchGroup,
        footGroup,
        // Трипод: ноги с phase 0 и π переступают в противофазе
        gaitGroup: cfg.phase === 0 ? 0 : 1,
        restLocal,
        hipLocal,
        currentFootPos: new THREE.Vector3(restLocal.x, 0, restLocal.z),
        stepStartPos: new THREE.Vector3(restLocal.x, 0, restLocal.z),
        stepTargetPos: new THREE.Vector3(restLocal.x, 0, restLocal.z),
        stepProgress: 1.0,
        isStepping: false,
        groundNormal: new THREE.Vector3(0, 1, 0),

        // Состояние контакта: заполняется походкой и читается опорой
        isPlanted: true,
        normalLoad: 0.0,
        loadShare: 1.0,
        sink: 0.0,
        sinkRate: 0.0,
        packing: 0.0,
        traction: 0.0
    };
}

export interface HexapodModel {
    root: THREE.Group;
    chassisGroup: THREE.Group;
    legs: HexapodLeg[];
}

export function buildHexapodModel(materials: HexapodMaterials): HexapodModel {
    const {
        armorMat, secondaryMat, darkMat, louverMat, ochreMat, slitMat
    } = materials;

    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    // Корпус в единицах модели: высокая посадка над стопами
    const chassisGroup = new THREE.Group();
    chassisGroup.position.y = BASE_CHASSIS_Y;
    root.add(chassisGroup);

    // --- МОДУЛЬ A: центральное ядро и нижняя открытая силовая ферма ---
    const coreModule = new THREE.Group();
    chassisGroup.add(coreModule);

    const centralHull = createSlopedBlock(4.9, 5.4, 4.5, 5.0, 1.85, 0, -0.1);
    addPart(coreModule, centralHull, armorMat, 0, 0.55, -0.25);

    const underPan = createSlopedBlock(3.8, 4.8, 4.7, 5.2, 0.85, 0, 0.1);
    addPart(coreModule, underPan, darkMat, 0, -0.75, -0.15);

    const trussGroup = new THREE.Group();
    trussGroup.position.set(0, -0.72, 2.35);
    coreModule.add(trussGroup);

    addPart(trussGroup, new THREE.BoxGeometry(2.65, 0.26, 0.55), secondaryMat, 0, -0.45, 0.25);
    addPart(trussGroup, new THREE.BoxGeometry(3.2, 0.24, 0.45), darkMat, 0, 0.32, 0.35);

    for (const side of [-1, 1]) {
        addPart(trussGroup, new THREE.BoxGeometry(0.24, 1.05, 0.32), secondaryMat, side * 1.15, -0.05, 0.3, 0, 0, -side * 0.42);
        addPart(trussGroup, new THREE.BoxGeometry(0.2, 0.95, 0.28), secondaryMat, side * 0.48, -0.08, 0.32, 0, 0, side * 0.46);
        addPart(trussGroup, new THREE.BoxGeometry(0.22, 0.85, 0.3), darkMat, side * 0.82, -0.06, 0.26);
        addPart(trussGroup, new THREE.BoxGeometry(0.18, 0.36, 0.42), armorMat, side * 0.95, -0.66, 0.32);
        addPart(trussGroup, new THREE.CylinderGeometry(0.08, 0.08, 0.22, 6), slitMat, side * 0.95, -0.68, 0.36, 0, 0, Math.PI / 2);
    }

    // Продольные силовые балки рамы вдоль бортов
    for (const side of [-1, 1]) {
        addPart(coreModule, new THREE.BoxGeometry(0.45, 0.55, 5.2), darkMat, side * 2.1, -0.62, -0.2);
    }

    // --- МОДУЛЬ B: передний клиновидный блок наблюдения и носовая броня ---
    const frontModule = new THREE.Group();
    frontModule.position.set(0, 0.32, 2.55);
    chassisGroup.add(frontModule);

    const noseCore = createSlopedBlock(3.5, 2.2, 2.9, 1.8, 1.35, 0, -0.2);
    addPart(frontModule, noseCore, armorMat, 0, 0.05, 0.35);

    const upperGlacis = createSlopedBlock(2.55, 2.45, 2.15, 2.25, 0.36, 0, -0.15);
    addPart(frontModule, upperGlacis, armorMat, 0, 0.56, 1.05, 0.34, 0, 0);

    for (const side of [-1, 1]) {
        addPart(frontModule, new THREE.BoxGeometry(0.12, 0.12, 0.26), darkMat, side * 0.62, 0.52, 1.38, 0.34, 0, 0);
        addPart(frontModule, new THREE.BoxGeometry(0.12, 0.12, 0.26), darkMat, side * 0.78, 0.82, 0.52, 0.34, 0, 0);
        addPart(frontModule, new THREE.BoxGeometry(0.48, 0.08, 0.36), darkMat, side * 0.45, 0.94, 0.12, 0.34, 0, 0);
    }

    // Тупой срез носа с узкой смотровой щелью
    const noseTipGroup = new THREE.Group();
    noseTipGroup.position.set(0, 0.06, 2.12);
    frontModule.add(noseTipGroup);

    const noseUpperLip = createSlopedBlock(2.08, 0.52, 1.92, 0.38, 0.28, 0, -0.06);
    addPart(noseTipGroup, noseUpperLip, armorMat, 0, 0.22, 0.04);

    addPart(noseTipGroup, new THREE.BoxGeometry(1.76, 0.14, 0.24), slitMat, 0, 0.03, 0.02);

    for (const side of [-1, 1]) {
        addPart(noseTipGroup, new THREE.BoxGeometry(0.18, 0.24, 0.32), secondaryMat, side * 0.92, 0.03, 0.04);
        addPart(noseTipGroup, new THREE.BoxGeometry(0.08, 0.16, 0.34), ochreMat, side * 0.84, 0.03, 0.05);
    }

    const noseLowerJaw = createSlopedBlock(1.42, 0.42, 1.96, 0.62, 0.56, 0, 0.12);
    addPart(noseTipGroup, noseLowerJaw, armorMat, 0, -0.34, -0.02);

    // Скуловые бронеплиты
    for (const side of [-1, 1]) {
        const cheekGroup = new THREE.Group();
        cheekGroup.position.set(side * 1.62, 0.12, 0.72);
        frontModule.add(cheekGroup);

        const mainCheek = createSlopedBlock(0.88, 2.15, 0.52, 1.75, 1.12, -side * 0.18, -0.15);
        addPart(cheekGroup, mainCheek, armorMat, 0, 0.06, 0, 0, side * 0.28, 0);

        const lowerCheek = createSlopedBlock(0.45, 1.65, 0.84, 2.05, 0.45, side * 0.16, 0.1);
        addPart(cheekGroup, lowerCheek, secondaryMat, -side * 0.05, -0.68, -0.05, 0, side * 0.28, 0);

        addPart(cheekGroup, new THREE.BoxGeometry(0.22, 0.26, 0.08), louverMat, -side * 0.18, 0.12, 0.92, 0, side * 0.28, 0);
    }

    // Камеры, сенсоры и выключенные фонари на носу
    for (const side of [-1, 1]) {
        const upperTwinPod = createCameraPod(materials, 0.56, 0.34, 0.48, true);
        upperTwinPod.position.set(side * 1.18, 0.22, 1.62);
        frontModule.add(upperTwinPod);

        const midSensorPod = createCameraPod(materials, 0.38, 0.28, 0.42, false);
        midSensorPod.position.set(side * 1.18, -0.16, 1.56);
        frontModule.add(midSensorPod);

        const chinPod = createCameraPod(materials, 0.58, 0.52, 0.58, false);
        chinPod.position.set(side * 1.05, -0.62, 1.48);
        frontModule.add(chinPod);
    }

    // --- МОДУЛЬ C: боковые навесные секции-контейнеры ---
    for (const side of [-1, 1]) {
        const sponsonGroup = new THREE.Group();
        sponsonGroup.position.set(side * 2.55, 0.62, -0.15);
        chassisGroup.add(sponsonGroup);

        const frontShoulderBlock = createSlopedBlock(1.15, 1.65, 0.95, 1.42, 1.65, -side * 0.08, -0.05);
        addPart(sponsonGroup, frontShoulderBlock, armorMat, side * 0.35, 0.08, 1.18);

        addPart(sponsonGroup, new THREE.BoxGeometry(0.12, 0.38, 0.32), darkMat, side * 0.88, 0.15, 1.18);

        const midSponsonCore = createSlopedBlock(1.45, 3.25, 1.32, 2.95, 1.68, -side * 0.06, 0);
        addPart(sponsonGroup, midSponsonCore, secondaryMat, side * 0.72, 0.05, -0.65);

        const outerFrontPod = createSlopedBlock(0.95, 1.35, 0.82, 1.18, 1.32, -side * 0.06, 0);
        addPart(sponsonGroup, outerFrontPod, armorMat, side * 1.48, 0.08, 0.05);
        addPart(sponsonGroup, new THREE.BoxGeometry(0.36, 0.78, 0.08), darkMat, side * 1.52, 0.08, 0.71);

        const outerMainPod = createSlopedBlock(1.05, 1.95, 0.92, 1.75, 1.28, -side * 0.05, 0);
        addPart(sponsonGroup, outerMainPod, secondaryMat, side * 1.78, 0.08, -1.25);

        const outerCap = createSlopedBlock(0.28, 1.65, 0.22, 1.48, 1.05, 0, 0);
        addPart(sponsonGroup, outerCap, armorMat, side * 2.28, 0.08, -1.25);

        addPart(sponsonGroup, new THREE.BoxGeometry(1.65, 0.38, 2.85), darkMat, side * 0.85, -0.88, -0.55);
    }

    // --- МОДУЛЬ D: верхняя надстройка, башня охлаждения, решетки и поручни ---
    const dorsalGroup = new THREE.Group();
    dorsalGroup.position.set(0, 1.48, 0.0);
    chassisGroup.add(dorsalGroup);

    const upperCasemate = createSlopedBlock(2.85, 2.35, 2.35, 1.85, 0.68, 0, -0.15);
    addPart(dorsalGroup, upperCasemate, armorMat, 0, 0.22, 1.05);

    for (const side of [-1, 1]) {
        addPart(dorsalGroup, new THREE.BoxGeometry(0.46, 0.26, 0.14), darkMat, side * 0.56, 0.22, 2.04, -0.35, 0, 0);
        addPart(dorsalGroup, new THREE.BoxGeometry(0.36, 0.18, 0.16), slitMat, side * 0.56, 0.22, 2.06, -0.35, 0, 0);

        const shoulderVentBox = createSlopedBlock(0.82, 1.15, 0.74, 1.02, 0.52, 0, 0);
        addPart(dorsalGroup, shoulderVentBox, secondaryMat, side * 1.68, 0.16, 0.85);
        addPart(dorsalGroup, new THREE.BoxGeometry(0.66, 0.36, 0.08), louverMat, side * 1.68, 0.16, 1.41);
        addPart(dorsalGroup, new THREE.BoxGeometry(0.08, 0.36, 0.84), louverMat, side * 2.08, 0.16, 0.85);
    }

    // Трубчатое ограждение безопасности на крыше рубки
    const railingGroup = new THREE.Group();
    railingGroup.position.set(-0.15, 0.58, 0.92);
    dorsalGroup.add(railingGroup);

    const railW = 1.55;
    const railD = 1.25;
    const railH = 0.42;
    const pipeRadius = 0.025;

    const postCoords: [number, number][] = [
        [-railW * 0.5, -railD * 0.5], [0, -railD * 0.5], [railW * 0.5, -railD * 0.5],
        [-railW * 0.5, railD * 0.5], [0, railD * 0.5], [railW * 0.5, railD * 0.5],
        [-railW * 0.5, 0], [railW * 0.5, 0]
    ];
    for (const [px, pz] of postCoords) {
        addPart(railingGroup, new THREE.CylinderGeometry(pipeRadius, pipeRadius, railH, 5), darkMat, px, railH * 0.5, pz);
    }

    for (const hLevel of [railH * 0.52, railH]) {
        addPart(railingGroup, new THREE.BoxGeometry(railW, pipeRadius * 1.8, pipeRadius * 1.8), darkMat, 0, hLevel, railD * 0.5);
        addPart(railingGroup, new THREE.BoxGeometry(railW, pipeRadius * 1.8, pipeRadius * 1.8), darkMat, 0, hLevel, -railD * 0.5);
        addPart(railingGroup, new THREE.BoxGeometry(pipeRadius * 1.8, pipeRadius * 1.8, railD), darkMat, railW * 0.5, hLevel, 0);
        addPart(railingGroup, new THREE.BoxGeometry(pipeRadius * 1.8, pipeRadius * 1.8, railD), darkMat, -railW * 0.5, hLevel, 0);
    }

    // Высокая трапециевидная башня силовой установки и охлаждения
    const coolingTower = new THREE.Group();
    coolingTower.position.set(0.68, 0.15, -0.85);
    dorsalGroup.add(coolingTower);

    const towerBase = createSlopedBlock(2.25, 2.45, 2.05, 2.25, 0.58, 0, 0);
    addPart(coolingTower, towerBase, secondaryMat, 0, 0.25, 0);
    addPart(coolingTower, new THREE.BoxGeometry(0.08, 0.38, 1.65), louverMat, 1.08, 0.25, 0);

    const towerUpper = createSlopedBlock(1.85, 2.15, 1.48, 1.75, 1.35, 0, -0.08);
    addPart(coolingTower, towerUpper, armorMat, 0, 1.18, 0);

    addPart(coolingTower, new THREE.BoxGeometry(0.08, 0.92, 1.25), louverMat, 0.82, 1.15, 0, 0, 0, 0.12);
    addPart(coolingTower, new THREE.BoxGeometry(0.08, 0.92, 1.25), louverMat, -0.82, 1.15, 0, 0, 0, -0.12);
    addPart(coolingTower, new THREE.BoxGeometry(0.68, 0.28, 0.1), louverMat, 0, 1.52, 0.92, -0.12, 0, 0);
    addPart(coolingTower, new THREE.BoxGeometry(0.68, 0.28, 0.1), louverMat, 0, 1.52, -0.96, 0.12, 0, 0);

    // Кормовой технический блок и штыревые антенны
    const leftRearDeckBox = createSlopedBlock(1.65, 2.1, 1.42, 1.85, 0.62, 0, 0);
    addPart(dorsalGroup, leftRearDeckBox, secondaryMat, -1.12, 0.26, -1.05);

    const antennaPositions: [number, number, number, number][] = [
        [1.75, 0.35, 0.15, 2.15],
        [-1.45, 0.45, -1.35, 1.85]
    ];
    for (const [ax, ay, az, ah] of antennaPositions) {
        addPart(dorsalGroup, new THREE.CylinderGeometry(0.12, 0.16, 0.38, 6), darkMat, ax, ay, az);
        addPart(dorsalGroup, new THREE.CylinderGeometry(0.025, 0.045, ah, 5), darkMat, ax, ay + ah * 0.5 + 0.15, az);
    }

    // Кормовой моторно-технический отсек
    const rearHullBlock = createSlopedBlock(4.1, 1.65, 3.6, 1.25, 1.55, 0, 0.18);
    addPart(chassisGroup, rearHullBlock, secondaryMat, 0, 0.52, -3.35);
    for (const side of [-1, 1]) {
        addPart(chassisGroup, new THREE.BoxGeometry(1.15, 0.68, 0.12), louverMat, side * 1.05, 0.58, -4.08);
    }

    // --- Шесть ног ---
    const legs = LEG_CONFIGS.map(cfg => buildMechanicalLeg({ cfg, chassisGroup, materials }));

    return { root, chassisGroup, legs };
}

