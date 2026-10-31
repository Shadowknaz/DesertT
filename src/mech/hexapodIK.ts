// Аналитическая 3D-IK шестиногой ноги: горизонтальный разворот коксы,
// затем два угла в вертикальной плоскости лапы (бедро + голень) по теореме
// косинусов. Мировые матрицы узлов считаются от корпуса меха: перед вызовом
// rig.syncFromMotion() ставит root, поэтому mountNode.matrixWorld актуален.
import * as THREE from 'three';
import { HEXAPOD } from '../config.ts';

const _localTarget = new THREE.Vector3();
const _invMountMatrix = new THREE.Matrix4();
const _footWorldQuat = new THREE.Quaternion();
const _parentWorldQuat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();
const _plateQuat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const upAxis = new THREE.Vector3(0, 1, 0);

const SCALE = HEXAPOD.scale;
const ANKLE_WORLD = HEXAPOD.ankleHeight * SCALE;
const L1 = HEXAPOD.femurLength;
const L2 = HEXAPOD.tibiaLength;

export interface HexapodLegIKTarget {
    x: number;
    y: number;
    z: number;
}

export interface HexapodLegIKNodes {
    mountNode: THREE.Object3D;
    coxaYawGroup: THREE.Object3D;
    femurPitchGroup: THREE.Object3D;
    tibiaPitchGroup: THREE.Object3D;
    footGroup: THREE.Object3D;
    groundNormal: THREE.Vector3;
    [key: string]: any;
}

export function solveHexapodLeg(leg: HexapodLegIKNodes, targetWorld: HexapodLegIKTarget | THREE.Vector3): void {
    leg.mountNode.updateWorldMatrix(true, false);
    _invMountMatrix.copy(leg.mountNode.matrixWorld).invert();

    // Щиколотка стоит над точкой опоры; в локальные единицы масштаб
    // переводит обратная матрица узла
    _localTarget
        .set(targetWorld.x, targetWorld.y + ANKLE_WORLD, targetWorld.z)
        .applyMatrix4(_invMountMatrix);

    // 1. Горизонтальный разворот ноги (Coxa Yaw)
    const yaw = Math.atan2(_localTarget.x, _localTarget.z);
    leg.coxaYawGroup.rotation.y = yaw;

    // 2. Расстояние от оси бедра до щиколотки в плоскости лапы
    const horizDist = Math.sqrt(_localTarget.x * _localTarget.x + _localTarget.z * _localTarget.z) - HEXAPOD.coxaOffset;
    const vertDist = _localTarget.y;

    const maxReach = (L1 + L2) * 0.992;
    const minReach = Math.abs(L1 - L2) * 1.04;
    const dist = Math.max(minReach, Math.min(maxReach, Math.hypot(horizDist, vertDist)));

    // 3. Теорема косинусов: колено поднято вверх, как у шагохода
    const angleToTarget = Math.atan2(vertDist, horizDist);
    const cosHipOffset = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
    const hipOffset = Math.acos(Math.max(-1, Math.min(1, cosHipOffset)));
    const femurPitch = angleToTarget + hipOffset;

    const cosKneeInternal = (L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2);
    const kneeInternal = Math.acos(Math.max(-1, Math.min(1, cosKneeInternal)));
    const tibiaPitch = -(Math.PI - kneeInternal);

    leg.femurPitchGroup.rotation.x = -femurPitch;
    leg.tibiaPitchGroup.rotation.x = -tibiaPitch;

    // 4. Стопа ложится плоско по нормали песка и курсу коксы
    leg.tibiaPitchGroup.updateWorldMatrix(true, false);
    leg.tibiaPitchGroup.getWorldQuaternion(_parentWorldQuat);

    _plateQuat.setFromUnitVectors(upAxis, leg.groundNormal);
    _euler.set(0, yaw, 0);
    _yawQuat.setFromEuler(_euler);
    _footWorldQuat.copy(_plateQuat).multiply(_yawQuat);

    leg.footGroup.quaternion.copy(_parentWorldQuat).invert().multiply(_footWorldQuat);
}

