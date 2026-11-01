import * as THREE from 'three';
import type { ActorRegistration } from '../actor/actorRegistry.ts';
import type { GroundSample } from '../world/groundSampler.ts';

/**
 * Точки крепления пилота на транспортном средстве в мировых координатах.
 * Любой вид транспорта (мотоцикл, квадроцикл, багги, глайдер) экспортирует этот контракт,
 * чтобы система синхронизации пилота не зависела от конкретного меша.
 */
export interface VehicleAttachPoints {
    /** Точка и ориентация седла/кресла в мировых координатах (таз пилота) */
    seatPosition: THREE.Vector3;
    seatQuaternion: THREE.Quaternion;
    /** Мировые позиции рукояток руля / штурвала (левая и правая кисти/клешни) */
    leftHandPosition: THREE.Vector3;
    rightHandPosition: THREE.Vector3;
    /** Мировые позиции и кватернионы подножек / педалей (левая и правая стопы) */
    leftFootPosition: THREE.Vector3;
    rightFootPosition: THREE.Vector3;
    leftFootQuaternion: THREE.Quaternion;
    rightFootQuaternion: THREE.Quaternion;
    /** Безопасная мировая точка спешивания рядом с транспортом */
    dismountPosition: THREE.Vector3;
    dismountYaw: number;
}

/**
 * Универсальное состояние кинематики и подвески транспортного средства
 * для передачи между физическим контроллером, визуальной 3D-моделью и пилотом.
 */
export interface VehicleVisualState {
    position: THREE.Vector3;
    yaw: number;
    forwardSpeed: number;
    forwardAccel: number;
    lateralSpeed: number;
    steeringAngle: number;
    chassisHeightOffset: number;
    chassisPitch: number;
    chassisRoll: number;
    frontGroundY: number;
    rearGroundY: number;
    frontWheelSpin: number;
    rearWheelSpin: number;
    frontWheelWorldPos: THREE.Vector3;
    rearWheelWorldPos: THREE.Vector3;
    grounded: boolean;
    isBoosting: boolean;
    isBraking: boolean;
    slopeAngle: number;
    ground?: GroundSample;
    frontGround?: GroundSample;
    rearGround?: GroundSample;
}

export type VehicleContactEventType = 'wheel_roll' | 'landing' | 'liftoff' | 'brake_skid';

export interface VehicleContactEvent {
    type: VehicleContactEventType;
    position: THREE.Vector3;
    frontWheelPos: THREE.Vector3;
    rearWheelPos: THREE.Vector3;
    yaw: number;
    speed: number;
    impactSpeed: number;
    normalLoad: number;
    isBoosting: boolean;
    isBraking: boolean;
    steeringAngle: number;
    dt: number;
    ground: GroundSample;
    frontGround: GroundSample;
    rearGround: GroundSample;
}

/**
 * Контракт визуальной 3D-модели любого транспортного средства.
 */
export interface IVehicleModel {
    id: string;
    group: THREE.Group;
    pose: {
        rootPosition: THREE.Vector3;
        rootYaw: number;
        chassisHeightOffset: number;
        chassisPitch: number;
        chassisRoll: number;
        steeringAngle: number;
        frontGroundY: number;
        rearGroundY: number;
        frontWheelSpin: number;
        rearWheelSpin: number;
    };
    joints?: Record<string, THREE.Object3D>;
    update(groundAt?: ((x: number, z: number) => any) | null): void;
    getAttachPoints(out?: VehicleAttachPoints): VehicleAttachPoints;
    dispose(): void;
}

/**
 * Контракт физического контроллера транспортного средства.
 */
export interface IVehicleController {
    rig?: any;
    onAction?(name: string, phase: string, repeat?: boolean): void;
    update(dt: number, ctx?: any): any;
    simulateStep(dt: number, command: any, weatherState?: any): { motion: any; support: any };
    consumeContactEvents(): VehicleContactEvent[];
    getPose(): { position: THREE.Vector3; currentYaw: number; flatFwd: THREE.Vector3 };
    getVisualPose(alpha?: number): { position: THREE.Vector3; currentYaw: number; flatFwd: THREE.Vector3 };
    getVisualState(alpha?: number): VehicleVisualState;
    getState(alpha?: number): VehicleVisualState;
    setPose?(x: number, y: number, z: number, yaw?: number): void;
    reset(): void;
    getDebug(): any;
    dispose(): void;
}

/**
 * Состояние посадки пилота (передается в риг персонажа при управлении транспортом).
 */
export interface SeatedPoseState {
    vehicleId: string;
    seatPosition: THREE.Vector3;
    seatQuaternion: THREE.Quaternion;
    pelvisPitch: number;
    pelvisYaw: number;
    pelvisRoll: number;
    torsoPitch: number;
    torsoYaw: number;
    torsoRoll: number;
    headPitch: number;
    headYaw: number;
    headRoll: number;
    leftHandPosition: THREE.Vector3;
    rightHandPosition: THREE.Vector3;
    leftFootPosition: THREE.Vector3;
    rightFootPosition: THREE.Vector3;
    leftFootQuaternion: THREE.Quaternion;
    rightFootQuaternion: THREE.Quaternion;
    chassisRight: THREE.Vector3;
    chassisForward: THREE.Vector3;
    chassisUp: THREE.Vector3;
}

/**
 * Контракт пилота (например, Cosmo), который может садиться на любое транспортное средство.
 */
export interface IVehicleRider {
    id: string;
    getPosition(): THREE.Vector3;
    getYaw(): number;
    onMount(vehicleId: string, attachPoints: VehicleAttachPoints, state: VehicleVisualState): void;
    syncSeated(vehicleId: string, attachPoints: VehicleAttachPoints, state: VehicleVisualState): void;
    onDismount(dismountPosition: THREE.Vector3, dismountYaw: number): void;
    isMounted(): boolean;
    getMountedVehicleId(): string | null;
}

/**
 * Описание зарегистрированной единицы транспорта в TransportManager.
 */
export interface TransportVehicleDefinition {
    id: string;
    kind: string;
    name?: string;
    model: IVehicleModel;
    controller: IVehicleController;
    actor: ActorRegistration;
    mountRadius?: number;
}
