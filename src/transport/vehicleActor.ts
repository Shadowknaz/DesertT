import * as THREE from 'three';
import { BUGGY } from '../config.ts';
import type { ActorRegistration } from '../actor/actorRegistry.ts';
import type { SandField } from '../world/sandField.ts';
import { createDefaultVehicleAttachPoints } from './buggyModel.ts';
import type {
    IVehicleController,
    IVehicleModel,
    VehicleAttachPoints,
    VehicleContactEvent,
    VehicleVisualState
} from './types.ts';

const _roosterVel = new THREE.Vector3();
const _landingVel = new THREE.Vector3(0, 0.7, 0);

export interface CreateVehicleActorOptions {
    id?: string;
    contextId?: string;
    hintsKey?: string;
    model: IVehicleModel;
    controller: IVehicleController;
    dust?: any;
    granules?: any;
    sandField?: SandField | null;
    syncSand?: ((x: number, z: number, radius: number) => void) | null;
    worldStep?: (() => void) | null;
    groundAt?: ((x: number, z: number) => any) | null;
    cameraConfig?: any;
    frontTireWidth?: number;
    rearTireWidth?: number;
    tirePatchLength?: number;
    tireTrackDepth?: number;
    tireTrackCompaction?: number;
    onActivateVehicle?: ((vehicleId: string) => void) | null;
    onDeactivateVehicle?: ((vehicleId: string) => void) | null;
    onSyncSeatedRider?: ((vehicleId: string, attachPoints: VehicleAttachPoints, state: VehicleVisualState) => void) | null;
}

export interface VehicleActor extends ActorRegistration {
    model: IVehicleModel;
    controller: IVehicleController;
    getVisualPose: (alpha?: number) => any;
    getAttachPoints: (out?: VehicleAttachPoints) => VehicleAttachPoints;
    dispose: () => void;
}

function isSolidSurface(surfaceType?: string, materialId?: string): boolean {
    return surfaceType === 'solid' || materialId === 'stone' || materialId === 'bedrock';
}

/**
 * Создает управляемого актера транспортного средства, совместимого с ActorRegistry.
 * Не зависит от конкретного вида транспорта (принимает любой IVehicleModel + IVehicleController).
 */
export function createVehicleActor({
    id = BUGGY.id,
    contextId = 'transport',
    hintsKey = 'transport',
    model,
    controller,
    dust = null,
    granules = null,
    sandField = null,
    syncSand = null,
    worldStep = null,
    groundAt = null,
    cameraConfig = {
        focusHeight: 1.15,
        followGain: 10.5,
        groundClearance: 1.0,
        minDistance: 2.8,
        maxDistance: 24.0,
        defaultDistance: 6.8
    },
    frontTireWidth = BUGGY.frontWheelWidth,
    rearTireWidth = BUGGY.rearWheelWidth,
    tirePatchLength = 0.44,
    tireTrackDepth = BUGGY.tireTrackDepth,
    tireTrackCompaction = BUGGY.tireTrackCompaction,
    onActivateVehicle = null,
    onDeactivateVehicle = null,
    onSyncSeatedRider = null
}: CreateVehicleActorOptions): VehicleActor {
    if (!model || !controller) {
        throw new Error('VehicleActor requires both a model and a controller');
    }

    let boundSandField: any = sandField;
    let currentChunks: any = null;
    let currentSampler: any = null;
    const attachPointsScratch = createDefaultVehicleAttachPoints();

    const withdrawMassFn = (x: number, z: number, a: number) => boundSandField.withdrawMass(x, z, a);
    const granulesEnv = {
        windX: 0,
        windZ: 0,
        sampleHeight: (x: number, z: number) => currentChunks.sandField.sampleHeight(x, z),
        sampleGround: (x: number, z: number) => (currentSampler ? currentSampler.sample(x, z) : null),
        depositMass: (x: number, z: number, amount: number) => currentChunks.sandField.depositMass(x, z, amount),
        addReserve: (amount: number) => currentChunks.sandField.addReserve(amount)
    };

    function stampTireTrack(
        x: number,
        z: number,
        width: number,
        length: number,
        yaw: number,
        pitch: number,
        roll: number,
        depth: number,
        compaction: number,
        surfaceType?: string,
        materialId?: string
    ): void {
        if (isSolidSurface(surfaceType, materialId) || !boundSandField) return;

        if (typeof boundSandField.stampSole === 'function') {
            boundSandField.stampSole(x, z, width, length, yaw, pitch, roll, depth, compaction);
        } else if (typeof boundSandField.stampCrater === 'function') {
            boundSandField.stampCrater(x, z, Math.max(width, length) * 0.65, depth, compaction);
        }

        if (typeof syncSand === 'function') {
            syncSand(x, z, Math.max(width, length) * 1.4);
        }
    }

    function processContactEvents(events: VehicleContactEvent[], state: VehicleVisualState): void {
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const fSurf = ev.frontGround?.surfaceType;
            const fMat = ev.frontGround?.materialId;
            const rSurf = ev.rearGround?.surfaceType;
            const rMat = ev.rearGround?.materialId;

            if (ev.type === 'liftoff') {
                if (!isSolidSurface(rSurf, rMat) && dust && typeof dust.spawnSplash === 'function') {
                    dust.spawnSplash(ev.rearWheelPos, 6, 0.48);
                }
            } else if (ev.type === 'landing') {
                const impactFactor = THREE.MathUtils.clamp((ev.impactSpeed || 1.0) / 3.2, 0.75, 2.2);
                const landDepth = tireTrackDepth * 1.45 * impactFactor;
                stampTireTrack(
                    ev.frontWheelPos.x,
                    ev.frontWheelPos.z,
                    frontTireWidth * 1.1,
                    tirePatchLength * 1.25,
                    ev.yaw + ev.steeringAngle,
                    state.chassisPitch,
                    state.chassisRoll,
                    landDepth,
                    tireTrackCompaction * 1.25,
                    fSurf,
                    fMat
                );
                stampTireTrack(
                    ev.rearWheelPos.x,
                    ev.rearWheelPos.z,
                    rearTireWidth * 1.15,
                    tirePatchLength * 1.35,
                    ev.yaw,
                    state.chassisPitch,
                    state.chassisRoll,
                    landDepth * 1.15,
                    tireTrackCompaction * 1.35,
                    rSurf,
                    rMat
                );
                if (!isSolidSurface(rSurf, rMat)) {
                    const splashCount = Math.round(6 * impactFactor);
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(ev.frontWheelPos, splashCount, 0.45 * impactFactor);
                        dust.spawnSplash(ev.rearWheelPos, splashCount + 3, 0.55 * impactFactor);
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        _landingVel.set(0, 0.65 * impactFactor, 0);
                        granules.spawnFootEjection(ev.rearWheelPos, _landingVel, Math.round(12 * impactFactor), 0.48 * impactFactor, withdrawMassFn);
                    }
                }
            } else if (ev.type === 'wheel_roll' || ev.type === 'brake_skid') {
                const isSkid = ev.type === 'brake_skid';
                const speedFactor = THREE.MathUtils.clamp(ev.speed / BUGGY.maxForwardSpeed, 0.35, 1.45);
                const frontDepth = tireTrackDepth * (isSkid ? 1.25 : 0.85) * speedFactor;
                const rearDepth = tireTrackDepth * (ev.isBoosting ? 1.35 : isSkid ? 1.3 : 1.05) * speedFactor;

                stampTireTrack(
                    ev.frontWheelPos.x,
                    ev.frontWheelPos.z,
                    frontTireWidth,
                    tirePatchLength,
                    ev.yaw + ev.steeringAngle,
                    state.chassisPitch,
                    state.chassisRoll,
                    frontDepth,
                    tireTrackCompaction,
                    fSurf,
                    fMat
                );
                stampTireTrack(
                    ev.rearWheelPos.x,
                    ev.rearWheelPos.z,
                    rearTireWidth,
                    tirePatchLength * 1.1,
                    ev.yaw,
                    state.chassisPitch,
                    state.chassisRoll,
                    rearDepth,
                    tireTrackCompaction * 1.15,
                    rSurf,
                    rMat
                );

                if (!isSolidSurface(rSurf, rMat) && ev.speed > 1.2) {
                    const boostMult = ev.isBoosting ? 1.35 : 1.0;
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(
                            ev.rearWheelPos,
                            ev.isBoosting ? 7 : isSkid ? 5 : 3,
                            (0.28 + 0.24 * speedFactor) * boostMult
                        );
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        const dirSign = state.forwardSpeed >= 0 ? -1 : 1;
                        const ejectSpeed = (2.0 + ev.speed * 0.26) * boostMult;
                        _roosterVel.set(
                            Math.sin(ev.yaw) * dirSign * ejectSpeed,
                            0.55 + 0.28 * speedFactor,
                            Math.cos(ev.yaw) * dirSign * ejectSpeed
                        );
                        granules.spawnFootEjection(
                            ev.rearWheelPos,
                            _roosterVel,
                            ev.isBoosting ? 11 : 7,
                            0.36 * boostMult,
                            withdrawMassFn
                        );
                    }
                }
            }
        }
    }

    return {
        id,
        contextId,
        hintsKey,
        model,
        controller,
        cameraConfig,
        getPose: () => controller.getPose(),
        getVisualPose: (alpha = 1.0) =>
            typeof controller.getVisualPose === 'function'
                ? controller.getVisualPose(alpha)
                : controller.getPose(),
        getAttachPoints: (out = attachPointsScratch) => model.getAttachPoints(out),
        onActivate() {
            if (onActivateVehicle) {
                onActivateVehicle(id);
            }
        },
        onDeactivate() {
            if (onDeactivateVehicle) {
                onDeactivateVehicle(id);
            }
        },
        simulateStep(dt: number, command: any, weatherState: any) {
            const result = controller.simulateStep(dt, command, weatherState);
            if (worldStep) worldStep();
            return result;
        },
        syncVisuals(alpha = 1.0) {
            const state = controller.getVisualState(alpha);
            model.pose.rootPosition.copy(state.position);
            model.pose.rootYaw = state.yaw;
            model.pose.chassisHeightOffset = state.chassisHeightOffset;
            model.pose.chassisPitch = state.chassisPitch;
            model.pose.chassisRoll = state.chassisRoll;
            model.pose.steeringAngle = state.steeringAngle;
            model.pose.frontGroundY = state.frontGroundY;
            model.pose.rearGroundY = state.rearGroundY;
            model.pose.frontWheelSpin = state.frontWheelSpin;
            model.pose.rearWheelSpin = state.rearWheelSpin;

            model.update(groundAt);

            if (onSyncSeatedRider) {
                const attachPoints = model.getAttachPoints(attachPointsScratch);
                onSyncSeatedRider(id, attachPoints, state);
            }

            const events = controller.consumeContactEvents();
            if (events.length > 0) {
                processContactEvents(events, state);
            }
        },
        updateWorld({ motion, frameDt, weatherState, chunks, sampler }: any) {
            if (!boundSandField && chunks?.sandField) {
                boundSandField = chunks.sandField;
            }
            if (!syncSand && chunks?.syncSandAt) {
                syncSand = chunks.syncSandAt;
            }
            const bodyPos = motion?.bodyPos || controller.getPose().position;
            if (dust && typeof dust.updateAmbient === 'function') {
                dust.updateAmbient(bodyPos, frameDt, weatherState);
            }
            if (granules && typeof granules.update === 'function' && chunks?.sandField) {
                currentChunks = chunks;
                currentSampler = sampler;
                granulesEnv.windX = weatherState.windX;
                granulesEnv.windZ = weatherState.windZ;
                granules.update(frameDt, granulesEnv);
            }
        },
        getDebug() {
            return controller.getDebug();
        },
        dispose() {
            model.dispose();
            controller.dispose();
        }
    };
}
