import * as THREE from 'three';
import type { PlayerController } from '../character/playerController.ts';
import type { PlayerModel } from '../character/playerModel.ts';
import type {
    IVehicleRider,
    SeatedPoseState,
    VehicleAttachPoints,
    VehicleVisualState
} from './types.ts';

export interface CreateCosmoVehicleRiderOptions {
    model: PlayerModel;
    controller: PlayerController;
    groundAt?: ((x: number, z: number) => any) | null;
}

/**
 * Адаптер синхронизации персонажа Cosmo с любым видом транспорта через контракт IVehicleRider.
 * Обеспечивает жесткую кинематическую согласованность:
 * - таз плотно сидит в седле и наследует крен/тангаж/высоту подвески шасси;
 * - корпус наклоняется к рулю, реагирует на разгон/торможение и поворачивает плечи вслед за рулем;
 * - механические клешни рук через Two-Bone 3D IK сжимают вращающиеся рукоятки руля;
 * - стопы стоят на подножках рамы, а колени охватывают топливный бак.
 */
export function createCosmoVehicleRider({
    model,
    controller,
    groundAt = null
}: CreateCosmoVehicleRiderOptions): IVehicleRider {
    let mountedVehicleId: string | null = null;

    const _basisMatrix = new THREE.Matrix4();
    const _chassisRight = new THREE.Vector3(1, 0, 0);
    const _chassisUp = new THREE.Vector3(0, 1, 0);
    const _chassisForward = new THREE.Vector3(0, 0, 1);

    const seatedPose: SeatedPoseState = {
        vehicleId: '',
        seatPosition: new THREE.Vector3(),
        seatQuaternion: new THREE.Quaternion(),
        pelvisPitch: 0.14,
        pelvisYaw: 0,
        pelvisRoll: 0,
        torsoPitch: 0.38,
        torsoYaw: 0,
        torsoRoll: 0,
        headPitch: -0.42,
        headYaw: 0,
        headRoll: 0,
        leftHandPosition: new THREE.Vector3(),
        rightHandPosition: new THREE.Vector3(),
        leftFootPosition: new THREE.Vector3(),
        rightFootPosition: new THREE.Vector3(),
        leftFootQuaternion: new THREE.Quaternion(),
        rightFootQuaternion: new THREE.Quaternion(),
        chassisRight: _chassisRight,
        chassisForward: _chassisForward,
        chassisUp: _chassisUp
    };

    function applySeatedSync(
        vehicleId: string,
        attachPoints: VehicleAttachPoints,
        state: VehicleVisualState
    ): void {
        _basisMatrix.makeRotationFromQuaternion(attachPoints.seatQuaternion);
        _basisMatrix.extractBasis(_chassisRight, _chassisUp, _chassisForward);
        // В Three.js левая сторона при взгляде вдоль +Z — это +X, а правая сторона — это -X.
        // Инвертируем знак X-базиса для вектора «вправо» персонажа (в playerModel rightWorld = (cosYaw, 0, -sinYaw),
        // где при yaw=0 вектор rightWorld равен (+1, 0, 0), а leftLeg имеет sideSign = -1, rightLeg = +1).
        // В chassisGroup координаты: левая рукоятка/подножка имеют x = -0.35 / -0.29, правая x = +0.35 / +0.29.
        // Поэтому локальная ось +X шасси совпадает с направлением sideSign = +1 (правая сторона модели Cosmo)!

        const steer = state.steeringAngle || 0;
        const accelLean = THREE.MathUtils.clamp((state.forwardAccel || 0) * 0.011, -0.12, 0.14);
        const boostLean = state.isBoosting ? 0.07 : 0;
        // Амортизация корпусом райдера в прыжке и при сжатии подвески на приземлении
        const suspCompressLean = THREE.MathUtils.clamp(-(state.chassisHeightOffset || 0) * 0.85, -0.08, 0.12);
        const airLean = state.grounded === false ? 0.08 : 0;

        const pelvisPitch = 0.14 + suspCompressLean * 0.35 + airLean * 0.4;
        const torsoPitch = 0.38 + accelLean + boostLean + suspCompressLean + airLean;
        const torsoYaw = steer * 0.25;
        const torsoRoll = -steer * 0.15 - (state.chassisRoll || 0) * 0.18;

        // Сенсорная голова поднимается вверх (компенсируя наклон торса к рулю) и смотрит в сторону поворота
        const headPitch = -(pelvisPitch + torsoPitch) * 0.82;
        const headYaw = steer * 0.38;
        const headRoll = -(state.chassisRoll || 0) * 0.32;

        seatedPose.vehicleId = vehicleId;
        seatedPose.seatPosition.copy(attachPoints.seatPosition);
        seatedPose.seatQuaternion.copy(attachPoints.seatQuaternion);
        seatedPose.pelvisPitch = pelvisPitch;
        seatedPose.pelvisYaw = 0;
        seatedPose.pelvisRoll = 0;
        seatedPose.torsoPitch = torsoPitch;
        seatedPose.torsoYaw = torsoYaw;
        seatedPose.torsoRoll = torsoRoll;
        seatedPose.headPitch = headPitch;
        seatedPose.headYaw = headYaw;
        seatedPose.headRoll = headRoll;

        seatedPose.leftHandPosition.copy(attachPoints.leftHandPosition);
        seatedPose.rightHandPosition.copy(attachPoints.rightHandPosition);
        seatedPose.leftFootPosition.copy(attachPoints.leftFootPosition);
        seatedPose.rightFootPosition.copy(attachPoints.rightFootPosition);
        seatedPose.leftFootQuaternion.copy(attachPoints.leftFootQuaternion);
        seatedPose.rightFootQuaternion.copy(attachPoints.rightFootQuaternion);

        if (typeof model.setSeatedPose === 'function') {
            model.setSeatedPose(seatedPose);
        }
        model.pose.rootPosition.copy(state.position);
        model.pose.rootYaw = state.yaw;
        model.update(null);

        // Синхронизируем скрытую физическую позицию контроллера Cosmo с позицией транспорта,
        // чтобы при поездке через чанки Cosmo всегда находился в актуальной точке мира.
        if (controller.rig?.collider && typeof controller.rig.collider.setEnabled === 'function') {
            controller.rig.collider.setEnabled(false);
        }
        if (typeof (controller as any).setPose === 'function') {
            (controller as any).setPose(state.position.x, state.position.y, state.position.z, state.yaw);
        } else {
            const pose = controller.getPose();
            pose.position.copy(state.position);
        }
    }

    return {
        id: 'cosmo',
        getPosition(): THREE.Vector3 {
            return controller.getPose().position;
        },
        getYaw(): number {
            return controller.getPose().currentYaw;
        },
        onMount(vehicleId: string, attachPoints: VehicleAttachPoints, state: VehicleVisualState): void {
            mountedVehicleId = vehicleId;
            if (controller.rig?.collider && typeof controller.rig.collider.setEnabled === 'function') {
                controller.rig.collider.setEnabled(false);
            }
            if (typeof model.resetSmoothing === 'function') {
                model.resetSmoothing();
            }
            applySeatedSync(vehicleId, attachPoints, state);
        },
        syncSeated(vehicleId: string, attachPoints: VehicleAttachPoints, state: VehicleVisualState): void {
            mountedVehicleId = vehicleId;
            applySeatedSync(vehicleId, attachPoints, state);
        },
        onDismount(dismountPosition: THREE.Vector3, dismountYaw: number): void {
            mountedVehicleId = null;
            if (controller.rig?.collider && typeof controller.rig.collider.setEnabled === 'function') {
                controller.rig.collider.setEnabled(true);
            }
            if (typeof model.setSeatedPose === 'function') {
                model.setSeatedPose(null);
            }
            if (typeof model.resetSmoothing === 'function') {
                model.resetSmoothing();
            }

            let groundY = dismountPosition.y;
            if (typeof groundAt === 'function') {
                const sample = groundAt(dismountPosition.x, dismountPosition.z);
                if (typeof sample === 'number' && Number.isFinite(sample)) {
                    groundY = sample;
                } else if (sample && typeof sample === 'object' && Number.isFinite(sample.y)) {
                    groundY = sample.y;
                }
            }

            if (typeof (controller as any).setPose === 'function') {
                (controller as any).setPose(dismountPosition.x, groundY, dismountPosition.z, dismountYaw);
            } else {
                const pose = controller.getPose();
                pose.position.set(dismountPosition.x, groundY, dismountPosition.z);
                controller.reset();
            }

            model.pose.rootPosition.set(dismountPosition.x, groundY, dismountPosition.z);
            model.pose.rootYaw = dismountYaw;
            model.pose.pelvisOffset.set(0, 0, 0);
            model.resetTargetsToStance();
            model.update(groundAt);
        },
        isMounted(): boolean {
            return mountedVehicleId !== null;
        },
        getMountedVehicleId(): string | null {
            return mountedVehicleId;
        }
    };
}
