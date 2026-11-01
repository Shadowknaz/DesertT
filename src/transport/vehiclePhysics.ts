import * as THREE from 'three';
import { BUGGY, COLLISION_GROUPS } from '../config.ts';
import { RAPIER } from '../world/physics.ts';
import {
    createDefaultGroundSample,
    copyGroundSample,
    resolveGroundSample,
    type GroundSample
} from '../world/groundSampler.ts';
import type {
    IVehicleController,
    VehicleContactEvent,
    VehicleContactEventType,
    VehicleVisualState
} from './types.ts';

export type GroundQuery = ((x: number, z: number) => any) | null;

export interface VehicleRig {
    body: any;
    collider: any;
    characterController: any;
    colliderOffsetY: number;
    computeMovement(desiredTranslation: { x: number; y: number; z: number }): {
        movement: { x: number; y: number; z: number };
        grounded: boolean;
    };
    applyMovement(movement: { x: number; y: number; z: number }): void;
    getBasePosition(): { x: number; y: number; z: number };
    setBasePosition(x: number, y: number, z: number): void;
    sampleWorldGround?(x: number, z: number): {
        y: number;
        normal: THREE.Vector3;
        surfaceType: 'sand' | 'solid';
        materialId: string;
    } | null;
    dispose(): void;
}

export interface VehicleRigOptions {
    world: any;
    spawnPosition?: THREE.Vector3 | { x: number; y: number; z: number };
    config?: Partial<typeof BUGGY>;
}

/**
 * Физический риг транспортного средства на базе Rapier 3D.
 * Инкапсулирует kinematicPositionBased тело, капсульный коллайдер и KinematicCharacterController.
 */
export function createVehicleRig({
    world,
    spawnPosition = new THREE.Vector3(0, 0, 0),
    config = BUGGY
}: VehicleRigOptions): VehicleRig {
    if (!world) {
        throw new Error('VehicleRig requires a Rapier physics world');
    }

    const colliderHalfHeight = config.colliderHalfHeight ?? BUGGY.colliderHalfHeight;
    const colliderRadius = config.colliderRadius ?? BUGGY.colliderRadius;
    const colliderOffsetY = config.colliderOffsetY ?? BUGGY.colliderOffsetY;
    const mass = config.mass ?? BUGGY.mass;

    const initialX = spawnPosition.x || 0;
    const initialY = (spawnPosition.y || 0) + colliderOffsetY;
    const initialZ = spawnPosition.z || 0;

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(initialX, initialY, initialZ)
        .setCanSleep(false);

    const body = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.capsule(colliderHalfHeight, colliderRadius)
        .setCollisionGroups(COLLISION_GROUPS.VEHICLE)
        .setFriction(0.35)
        .setRestitution(0.0);

    const collider = world.createCollider(colliderDesc, body);

    const characterController = world.createCharacterController(0.05);
    characterController.setUp({ x: 0.0, y: 1.0, z: 0.0 });
    characterController.setSlideEnabled(true);
    characterController.setMaxSlopeClimbAngle(65 * Math.PI / 180);
    characterController.setMinSlopeSlideAngle(60 * Math.PI / 180);
    characterController.enableSnapToGround(0.55);
    characterController.setApplyImpulsesToDynamicBodies(true);
    characterController.setCharacterMass(mass);

    let disposed = false;
    let isGroundedCache = true;
    const probeRay = new RAPIER.Ray({ x: 0, y: 80, z: 0 }, { x: 0, y: -1, z: 0 });

    const groundRayFilterPredicate = (col: any) => {
        if (!col || col.handle === collider.handle) return false;
        const parent = col.parent?.();
        if (parent && parent.handle === body.handle) return false;
        if (col.shape?.type === RAPIER.ShapeType.Capsule) return false;
        return true;
    };

    const kccFilterPredicate = (col: any) => {
        if (!groundRayFilterPredicate(col)) return false;
        // Вертикальный профиль песка и дюн полностью отслеживается колесными пробами (wheelLineY),
        // поэтому горизонтальный KCC проверяет только твердые препятствия (камни, руины, ноги меха),
        // не застревая и не подпрыгивая на гранях песчаного HeightField.
        if (col.shape?.type === RAPIER.ShapeType.HeightField) return false;
        return true;
    };

    function computeMovement(desiredTranslation: { x: number; y: number; z: number }) {
        if (disposed) return { movement: { x: 0, y: 0, z: 0 }, grounded: false };
        characterController.computeColliderMovement(
            collider,
            desiredTranslation,
            undefined,
            undefined,
            kccFilterPredicate
        );
        const movement = characterController.computedMovement();
        isGroundedCache = characterController.computedGrounded();
        return { movement, grounded: isGroundedCache };
    }

    function applyMovement(movement: { x: number; y: number; z: number }): void {
        if (disposed) return;
        const currentTra = body.translation();
        const nextTra = {
            x: currentTra.x + movement.x,
            y: currentTra.y + movement.y,
            z: currentTra.z + movement.z
        };
        body.setNextKinematicTranslation(nextTra);
        body.setTranslation(nextTra, true);
    }

    function getBasePosition(): { x: number; y: number; z: number } {
        if (disposed) return { x: 0, y: 0, z: 0 };
        const tra = body.translation();
        return {
            x: tra.x,
            y: tra.y - colliderOffsetY,
            z: tra.z
        };
    }

    function setBasePosition(x: number, y: number, z: number): void {
        if (disposed) return;
        const nextTra = {
            x,
            y: y + colliderOffsetY,
            z
        };
        body.setNextKinematicTranslation(nextTra);
        body.setTranslation(nextTra, true);
    }

    function sampleWorldGround(x: number, z: number) {
        if (disposed || !world || typeof world.castRayAndGetNormal !== 'function') return null;
        const baseY = getBasePosition().y;
        probeRay.origin.x = x;
        probeRay.origin.y = baseY + 25.0;
        probeRay.origin.z = z;

        const hit = world.castRayAndGetNormal(
            probeRay,
            60.0,
            true,
            undefined,
            undefined,
            undefined,
            body,
            groundRayFilterPredicate
        );

        if (!hit || hit.toi <= 0.01) return null;
        const hitY = probeRay.origin.y - hit.toi;
        const isHeightField = hit.collider?.shape?.type === RAPIER.ShapeType.HeightField;
        const normal = new THREE.Vector3(
            hit.normal?.x ?? 0,
            Math.max(0.05, hit.normal?.y ?? 1),
            hit.normal?.z ?? 0
        ).normalize();

        return {
            y: hitY,
            normal,
            surfaceType: (isHeightField ? 'sand' : 'solid') as 'sand' | 'solid',
            materialId: isHeightField ? 'loose_sand' : 'stone'
        };
    }

    function dispose(): void {
        if (disposed) return;
        disposed = true;
        if (characterController && typeof characterController.free === 'function') {
            characterController.free();
        }
        if (world && collider) {
            world.removeCollider(collider, false);
        }
        if (world && body) {
            world.removeRigidBody(body);
        }
    }

    return {
        body,
        collider,
        characterController,
        colliderOffsetY,
        computeMovement,
        applyMovement,
        getBasePosition,
        setBasePosition,
        sampleWorldGround,
        dispose
    };
}

export interface VehicleControllerOptions {
    world?: any;
    rig?: VehicleRig | null;
    groundAt?: GroundQuery;
    spawnPosition?: THREE.Vector3 | { x: number; y: number; z: number };
    spawnYaw?: number;
    config?: Partial<typeof BUGGY> & Record<string, any>;
}

/**
 * Физический контроллер колесного транспортного средства (мотоцикла / багги).
 * Рассчитывает продольную динамику, руление с учетом колесной базы, высоту грунта
 * под передним и задним колесом, ход подвески, клевок при торможении, приседание
 * при разгоне и крен в поворотах.
 */
export function createVehicleController(options: VehicleControllerOptions = {}): IVehicleController {
    const {
        world = null,
        rig = null,
        spawnPosition = new THREE.Vector3(BUGGY.spawnX, 0, BUGGY.spawnZ),
        spawnYaw = BUGGY.spawnYaw,
        config = BUGGY
    } = options;

    const hasCustomGroundAt = typeof options.groundAt === 'function';
    const spawnVec = spawnPosition instanceof THREE.Vector3
        ? spawnPosition.clone()
        : new THREE.Vector3(spawnPosition?.x || 0, spawnPosition?.y || 0, spawnPosition?.z || 0);

    const vehicleRig = rig || (world ? createVehicleRig({ world, spawnPosition: spawnVec, config }) : null);

    const effectiveGroundAt: (x: number, z: number) => any = hasCustomGroundAt
        ? (options.groundAt as (x: number, z: number) => any)
        : (vehicleRig && typeof vehicleRig.sampleWorldGround === 'function'
            ? (x: number, z: number) => vehicleRig.sampleWorldGround!(x, z) ?? 0
            : () => 0);

    const centerSample = createDefaultGroundSample();
    const frontSample = createDefaultGroundSample();
    const rearSample = createDefaultGroundSample();
    const leftSample = createDefaultGroundSample();
    const rightSample = createDefaultGroundSample();
    const patchScratchA = createDefaultGroundSample();
    const patchScratchB = createDefaultGroundSample();

    function sampleGround(x: number, z: number, out: GroundSample = centerSample, computeNormal = true): GroundSample {
        return resolveGroundSample(effectiveGroundAt, x, z, out, computeNormal);
    }

    /**
     * Сэмплирует эффективную высоту опоры под широким колесом мотоцикла:
     * усредняет профиль вдоль пятна контакта шины и компенсирует локальную канавку
     * собственного свежего следа (sink), чтобы колесо радиусом 0.52-0.56м плавно
     * катилось по бархану, не подскакивая на микро-ямках собственного протектора.
     */
    function sampleTireEnvelopeY(x: number, z: number, sinY: number, cosY: number, mainSample: GroundSample): number {
        const baseH = mainSample.y + (mainSample.sink || 0) * 0.72;
        const patchOffset = 0.22;
        sampleGround(x + sinY * patchOffset, z + cosY * patchOffset, patchScratchA, false);
        sampleGround(x - sinY * patchOffset, z - cosY * patchOffset, patchScratchB, false);
        const hLead = patchScratchA.y + (patchScratchA.sink || 0) * 0.72;
        const hTrail = patchScratchB.y + (patchScratchB.sink || 0) * 0.72;
        return baseH * 0.5 + (hLead + hTrail) * 0.25;
    }

    const wheelbase = config.wheelbase ?? BUGGY.wheelbase;
    const frontWheelZ = config.frontWheelZ ?? BUGGY.frontWheelZ;
    const rearWheelZ = config.rearWheelZ ?? BUGGY.rearWheelZ;
    const frontWheelRadius = config.frontWheelRadius ?? BUGGY.frontWheelRadius;
    const rearWheelRadius = config.rearWheelRadius ?? BUGGY.rearWheelRadius;
    const maxForwardSpeed = config.maxForwardSpeed ?? BUGGY.maxForwardSpeed;
    const boostSpeed = config.boostSpeed ?? BUGGY.boostSpeed;
    const maxReverseSpeed = config.maxReverseSpeed ?? BUGGY.maxReverseSpeed;
    const driveAccel = config.driveAccel ?? BUGGY.driveAccel;
    const boostAccel = config.boostAccel ?? BUGGY.boostAccel;
    const brakeDecel = config.brakeDecel ?? BUGGY.brakeDecel;
    const coastDrag = config.coastDrag ?? BUGGY.coastDrag;
    const maxSteerAngle = config.maxSteerAngle ?? BUGGY.maxSteerAngle;
    const steerRate = config.steerRate ?? BUGGY.steerRate;
    const steerReturnRate = config.steerReturnRate ?? BUGGY.steerReturnRate;
    const maxRollLean = config.maxRollLean ?? BUGGY.maxRollLean;
    const gravity = config.gravity ?? BUGGY.gravity;
    const tireTrackSpacing = config.tireTrackSpacing ?? BUGGY.tireTrackSpacing;

    const initialSample = sampleGround(spawnVec.x, spawnVec.z, centerSample, true);
    let initialY = spawnVec.y;
    if (!vehicleRig) {
        initialY = initialSample.y + Math.max(0, spawnVec.y);
    } else {
        if (Math.abs(initialY - initialSample.y) < 1.5 || initialY === 0) {
            initialY = initialSample.y;
            vehicleRig.setBasePosition(spawnVec.x, initialY, spawnVec.z);
        }
    }

    const position = new THREE.Vector3(spawnVec.x, initialY, spawnVec.z);
    const prevPosition = position.clone();
    const currPosition = position.clone();
    const visualPosition = position.clone();

    let yaw = spawnYaw;
    let prevYaw = spawnYaw;
    let currYaw = spawnYaw;
    let visualYaw = spawnYaw;

    const flatFwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const visualFlatFwd = flatFwd.clone();

    const frontWheelWorldPos = new THREE.Vector3();
    const rearWheelWorldPos = new THREE.Vector3();

    let forwardSpeed = 0;
    let forwardAccel = 0;
    let lateralSpeed = 0;
    let verticalVelocity = 0;
    let grounded = true;
    let prevSimGrounded = true;

    let steeringAngle = 0;
    let prevSteeringAngle = 0;
    let currentYawRate = 0;

    let chassisHeightOffset = 0;
    let prevChassisHeightOffset = 0;
    let chassisVertVel = 0;
    let chassisPitch = 0;
    let prevChassisPitch = 0;
    let chassisPitchVel = 0;
    let chassisRoll = 0;
    let prevChassisRoll = 0;
    let chassisRollVel = 0;

    let smoothFrontGroundY = initialY;
    let smoothRearGroundY = initialY;
    let smoothCenterGroundY = initialY;
    let prevFrontGroundY = initialY;
    let prevRearGroundY = initialY;
    let prevTargetGroundY = initialY;
    let uphillLaunchVelY = 0;

    let frontWheelSpin = 0;
    let rearWheelSpin = 0;
    let prevFrontWheelSpin = 0;
    let prevRearWheelSpin = 0;

    let isBoosting = false;
    let isBraking = false;
    let currentSlopeAngle = 0;
    let distanceSinceLastTrack = 0;

    // Отслеживание поворота камеры мышью для плавного подруливания за взглядом камеры при езде вперед (W)
    let lastCameraAzimuth: number | null = null;
    let cameraSteerActive = false;

    const pendingContactEvents: VehicleContactEvent[] = [];
    const desiredTranslationScratch = { x: 0, y: 0, z: 0 };

    function updateWheelProbes(x: number, z: number, curYaw: number, dt = 0): void {
        const sinY = Math.sin(curYaw);
        const cosY = Math.cos(curYaw);
        const rightX = -cosY;
        const rightZ = sinY;

        sampleGround(x, z, centerSample, true);
        const rawCenterY = centerSample.y + (centerSample.sink || 0) * 0.65;

        const fx = x + sinY * frontWheelZ;
        const fz = z + cosY * frontWheelZ;
        sampleGround(fx, fz, frontSample, true);
        const rawFrontY = sampleTireEnvelopeY(fx, fz, sinY, cosY, frontSample);
        frontWheelWorldPos.set(fx, frontSample.y, fz);

        const rx = x + sinY * rearWheelZ;
        const rz = z + cosY * rearWheelZ;
        sampleGround(rx, rz, rearSample, true);
        const rawRearY = sampleTireEnvelopeY(rx, rz, sinY, cosY, rearSample);
        rearWheelWorldPos.set(rx, rearSample.y, rz);

        sampleGround(x - rightX * 0.36, z - rightZ * 0.36, leftSample, false);
        sampleGround(x + rightX * 0.36, z + rightZ * 0.36, rightSample, false);

        if (dt <= 0) {
            smoothCenterGroundY = rawCenterY;
            smoothFrontGroundY = rawFrontY;
            smoothRearGroundY = rawRearY;
        } else {
            const filterAlpha = Math.min(1.0, dt * 28.0);
            smoothCenterGroundY += (rawCenterY - smoothCenterGroundY) * filterAlpha;
            smoothFrontGroundY += (rawFrontY - smoothFrontGroundY) * filterAlpha;
            smoothRearGroundY += (rawRearY - smoothRearGroundY) * filterAlpha;
        }
    }

    updateWheelProbes(currPosition.x, currPosition.z, currYaw, 0);
    const initWheelLineY = (smoothRearGroundY * frontWheelZ - smoothFrontGroundY * rearWheelZ) / wheelbase;
    if (Math.abs(currPosition.y - initWheelLineY) < 1.0) {
        currPosition.y = initWheelLineY;
        prevPosition.copy(currPosition);
        position.copy(currPosition);
        visualPosition.copy(currPosition);
        if (vehicleRig) {
            vehicleRig.setBasePosition(currPosition.x, currPosition.y, currPosition.z);
        }
    }
    prevFrontGroundY = smoothFrontGroundY;
    prevRearGroundY = smoothRearGroundY;
    prevTargetGroundY = currPosition.y;

    function pushContactEvent(
        type: VehicleContactEventType,
        speedVal: number,
        impactSpeedVal: number,
        normalLoadVal: number,
        dtVal: number
    ): void {
        pendingContactEvents.push({
            type,
            position: currPosition.clone(),
            frontWheelPos: frontWheelWorldPos.clone(),
            rearWheelPos: rearWheelWorldPos.clone(),
            yaw: currYaw,
            speed: speedVal,
            impactSpeed: impactSpeedVal,
            normalLoad: normalLoadVal,
            isBoosting,
            isBraking,
            steeringAngle,
            dt: dtVal,
            ground: copyGroundSample(centerSample, createDefaultGroundSample()),
            frontGround: copyGroundSample(frontSample, createDefaultGroundSample()),
            rearGround: copyGroundSample(rearSample, createDefaultGroundSample())
        });
    }

    function onAction(_name: string, _phase: string, _repeat = false): void {
        // Прыжок на мотоцикле отключен с кнопки: пробел работает как тормоз, а прыжки происходят динамически на трамплинах/дюнах
    }

    function normalizeAngleDiff(target: number, current: number): number {
        let diff = target - current;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        return diff;
    }

    function update(dt: number, ctx: any = {}): any {
        const actions = ctx.actions || {};
        const throttleInput = (actions.forward ? 1 : 0) - (actions.backward ? 1 : 0);
        // Поворот влево (A) -> положительный угол руля (+Y в Three.js), вправо (D) -> отрицательный
        const rawSteerInput = (actions.left ? 1 : 0) - (actions.right ? 1 : 0);
        const wantBoost = Boolean(actions.boost || actions.sprint || actions.run);
        const wantBrake = Boolean(actions.brake || actions.stomp || actions.jump);

        let steerInput = rawSteerInput;
        if (typeof ctx.cameraAzimuth === 'number' && Number.isFinite(ctx.cameraAzimuth)) {
            if (lastCameraAzimuth !== null) {
                const camDelta = Math.abs(normalizeAngleDiff(ctx.cameraAzimuth, lastCameraAzimuth));
                if (camDelta > 0.0015) {
                    cameraSteerActive = true;
                }
            }
            lastCameraAzimuth = ctx.cameraAzimuth;

            if (rawSteerInput !== 0) {
                // Ручной поворот клавишами A/D всегда имеет приоритет
                cameraSteerActive = false;
                steerInput = rawSteerInput;
            } else if (cameraSteerActive && throttleInput > 0) {
                const yawErr = normalizeAngleDiff(ctx.cameraAzimuth, currYaw);
                if (Math.abs(yawErr) < 0.025) {
                    cameraSteerActive = false;
                    steerInput = 0;
                } else {
                    steerInput = THREE.MathUtils.clamp(yawErr * 1.15, -1.0, 1.0);
                }
            }
        }

        return {
            throttleInput,
            steerInput,
            wantBoost,
            wantBrake,
            dt
        };
    }

    function simulateStep(dt: number, command: any = {}, _weatherState?: any) {
        prevPosition.copy(currPosition);
        prevYaw = currYaw;
        prevSteeringAngle = steeringAngle;
        prevFrontWheelSpin = frontWheelSpin;
        prevRearWheelSpin = rearWheelSpin;
        prevChassisHeightOffset = chassisHeightOffset;
        prevChassisPitch = chassisPitch;
        prevChassisRoll = chassisRoll;
        prevFrontGroundY = smoothFrontGroundY;
        prevRearGroundY = smoothRearGroundY;

        const wasGrounded = prevSimGrounded;
        const preStepVertVel = verticalVelocity;

        const throttleInput = command?.throttleInput ?? 0;
        const steerInput = command?.steerInput ?? 0;
        const wantBoost = Boolean(command?.wantBoost);
        const wantBrake = Boolean(command?.wantBrake);
        const isUnmanned = Boolean(command?.unmanned);

        if (isUnmanned) {
            cameraSteerActive = false;
            lastCameraAzimuth = null;
        }

        // 1. Рулевое управление передней вилкой с прогрессивным сужением угла на высокой скорости
        const speedNorm = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / maxForwardSpeed, 0, 1);
        const highSpeedFactor = config.highSpeedSteerFactor ?? BUGGY.highSpeedSteerFactor ?? 0.52;
        const effectiveMaxSteer = maxSteerAngle * (1.0 - (1.0 - highSpeedFactor) * speedNorm * 0.78);
        const targetSteer = steerInput * effectiveMaxSteer;
        const rate = Math.abs(steerInput) > 0.01
            ? steerRate
            : (isUnmanned ? steerReturnRate * 1.8 : steerReturnRate);
        steeringAngle += THREE.MathUtils.clamp(
            targetSteer - steeringAngle,
            -rate * dt,
            rate * dt
        );
        if (Math.abs(steerInput) < 1e-3 && Math.abs(steeringAngle) < 1e-3) {
            steeringAngle = 0;
        }

        // 2. Опрос рельефа и расчет продольного уклона по сглаженной базе колес
        const isMovingOrTurning =
            Math.abs(forwardSpeed) > 1e-4 ||
            Math.abs(lateralSpeed) > 1e-4 ||
            Math.abs(steerInput) > 1e-3 ||
            !grounded;
        if (isMovingOrTurning) {
            updateWheelProbes(currPosition.x, currPosition.z, currYaw, dt);
        }
        const preMoveSlopeRise = smoothFrontGroundY - smoothRearGroundY;
        const preMoveLongSlopeAngle = Math.atan2(preMoveSlopeRise, wheelbase);
        const nx = centerSample.normal.x;
        const ny = Math.max(0.05, centerSample.normal.y);
        const nz = centerSample.normal.z;
        currentSlopeAngle = Math.atan2(Math.hypot(nx, nz), ny);

        // Сопротивление / помощь гравитации на подъеме и спуске
        const slopeGravityAccel = grounded ? (gravity * Math.sin(preMoveLongSlopeAngle) * 0.45) : 0;

        // Сцепление с песком / камнем
        let surfaceGrip = 1.0;
        if (centerSample.materialId === 'loose_sand') {
            surfaceGrip = 0.90 + (centerSample.packing || 0) * 0.06 - Math.min(0.10, (centerSample.sink || 0) * 0.20);
        } else if (centerSample.surfaceType === 'solid') {
            surfaceGrip = 1.05;
        }

        // 3. Продольная динамика (газ, форсаж, торможение, задний ход, инерционный накат, полет)
        const prevSpeed = forwardSpeed;
        isBoosting = wantBoost && throttleInput > 0 && !wantBrake;
        isBraking = false;

        if (!grounded) {
            // В воздухе колеса не отталкиваются от песка — сохраняется баллистический импульс с легким аэродинамическим сопротивлением
            const airDrag = 0.45 * dt;
            if (Math.abs(forwardSpeed) <= airDrag) {
                forwardSpeed = 0;
            } else {
                forwardSpeed -= Math.sign(forwardSpeed) * airDrag;
            }
        } else if (wantBrake) {
            isBraking = Math.abs(forwardSpeed) > 0.2;
            const brakeStep = brakeDecel * surfaceGrip * dt;
            if (Math.abs(forwardSpeed) <= brakeStep) {
                forwardSpeed = 0;
            } else {
                forwardSpeed -= Math.sign(forwardSpeed) * brakeStep;
            }
        } else if (throttleInput > 0) {
            if (forwardSpeed < -0.2) {
                isBraking = true;
                forwardSpeed = Math.min(0, forwardSpeed + brakeDecel * surfaceGrip * dt);
            } else {
                const topSpeed = (isBoosting ? boostSpeed : maxForwardSpeed) * surfaceGrip;
                const accel = (isBoosting ? boostAccel : driveAccel) * surfaceGrip + slopeGravityAccel;
                forwardSpeed = Math.min(topSpeed, forwardSpeed + Math.max(2.5, accel) * dt);
            }
        } else if (throttleInput < 0) {
            if (forwardSpeed > 0.35) {
                isBraking = true;
                forwardSpeed = Math.max(0, forwardSpeed - brakeDecel * surfaceGrip * dt);
            } else {
                const maxRev = maxReverseSpeed * surfaceGrip;
                const revAccel = driveAccel * 0.75 * surfaceGrip - slopeGravityAccel;
                forwardSpeed = Math.max(-maxRev, forwardSpeed - Math.max(1.8, revAccel) * dt);
            }
        } else {
            // Плавный инерционный выбег 165-кг мотоцикла при сбросе газа и после спешивания на ходу
            const dragStep = coastDrag * dt;
            if (Math.abs(forwardSpeed) > 0.08) {
                forwardSpeed += slopeGravityAccel * dt * 0.5;
            }
            if (Math.abs(forwardSpeed) <= dragStep) {
                forwardSpeed = 0;
            } else {
                forwardSpeed -= Math.sign(forwardSpeed) * dragStep;
            }
        }

        const rawAccel = (forwardSpeed - prevSpeed) / Math.max(1e-3, dt);
        if (Math.abs(forwardSpeed) === 0 && Math.abs(prevSpeed) === 0) {
            forwardAccel = 0;
        } else {
            forwardAccel += (THREE.MathUtils.clamp(rawAccel, -18.0, 18.0) - forwardAccel) * Math.min(1.0, dt * 10.0);
        }

        // 4. Инерционная велосипедная модель поворота с учетом массы (165 кг), момента инерции и бокового сноса шин
        const effectiveSteerSpeed = Math.abs(forwardSpeed) > 0.20
            ? forwardSpeed
            : (Math.abs(steerInput) > 0.01 && throttleInput !== 0 ? Math.sign(throttleInput) * 0.85 : 0);
        const turnGrip = grounded ? (0.94 * surfaceGrip) : (config.airSteerFactor ?? BUGGY.airSteerFactor ?? 0.18);
        let desiredYawRate = (effectiveSteerSpeed / wheelbase) * Math.tan(steeringAngle) * turnGrip;

        // Ограничение предельного центростремительного ускорения на песке (предотвращает резкие развороты на высокой скорости)
        const maxLatAccel = (config.maxLateralAccel ?? BUGGY.maxLateralAccel ?? 8.8) * surfaceGrip;
        if (Math.abs(forwardSpeed) > 2.5) {
            const maxAllowedYawRate = maxLatAccel / Math.abs(forwardSpeed);
            desiredYawRate = THREE.MathUtils.clamp(desiredYawRate, -maxAllowedYawRate, maxAllowedYawRate);
        }

        const yawInertiaRate = config.yawInertiaRate ?? BUGGY.yawInertiaRate ?? 7.2;
        const yawBlend = Math.min(1.0, dt * (grounded ? yawInertiaRate : 2.8));
        currentYawRate += (desiredYawRate - currentYawRate) * yawBlend;
        if (Math.abs(desiredYawRate) < 1e-4 && Math.abs(currentYawRate) < 1e-3) {
            currentYawRate = 0;
        }

        yaw += currentYawRate * dt;
        currYaw = yaw;
        flatFwd.set(Math.sin(currYaw), 0, Math.cos(currYaw));

        // Боковое скольжение (снос задней оси наружу виража на песке под действием центробежной силы)
        const latGrip = centerSample.surfaceType === 'solid'
            ? (config.lateralGripSolid ?? BUGGY.lateralGripSolid ?? 9.5)
            : (config.lateralGripSand ?? BUGGY.lateralGripSand ?? 5.2) * surfaceGrip;
        const centrifugalSlipAccel = grounded ? (forwardSpeed * currentYawRate * 0.28) : 0;
        lateralSpeed += centrifugalSlipAccel * dt;
        lateralSpeed *= Math.max(0, 1.0 - (grounded ? latGrip : 1.2) * dt);
        if (Math.abs(lateralSpeed) < 1e-3 && Math.abs(currentYawRate) < 1e-3) {
            lateralSpeed = 0;
        }

        // 5. Перемещение в мире: горизонтальные коллизии через Rapier KCC,
        //    плюс вертикальная баллистика и отрыв на гребнях холмов/барханов (трамплинах).
        const rightX = -Math.cos(currYaw);
        const rightZ = Math.sin(currYaw);
        const stepDx = (flatFwd.x * forwardSpeed + rightX * lateralSpeed) * dt;
        const stepDz = (flatFwd.z * forwardSpeed + rightZ * lateralSpeed) * dt;

        if (Math.abs(stepDx) > 1e-6 || Math.abs(stepDz) > 1e-6) {
            if (vehicleRig) {
                desiredTranslationScratch.x = stepDx;
                desiredTranslationScratch.y = 0;
                desiredTranslationScratch.z = stepDz;

                const { movement } = vehicleRig.computeMovement(desiredTranslationScratch);
                const reqHoriz = Math.hypot(stepDx, stepDz);
                const actHoriz = Math.hypot(movement.x, movement.z);
                if (reqHoriz > 1e-4 && actHoriz < reqHoriz * 0.35) {
                    // Плавное гашение скорости при упоре в ногу/корпус меха или скалу
                    forwardSpeed *= 0.65;
                    lateralSpeed *= 0.4;
                }

                currPosition.x += movement.x;
                currPosition.z += movement.z;
            } else {
                currPosition.x += stepDx;
                currPosition.z += stepDz;
            }

            // Обновляем колесные пробы в новой горизонтальной точке
            updateWheelProbes(currPosition.x, currPosition.z, currYaw, dt);
        }

        const postMoveSlopeRise = smoothFrontGroundY - smoothRearGroundY;
        const longSlopeAngle = Math.atan2(postMoveSlopeRise, wheelbase);

        // Линия между задним (rearWheelZ) и передним (frontWheelZ) колесом в точке z = 0:
        const wheelLineY = (smoothRearGroundY * frontWheelZ - smoothFrontGroundY * rearWheelZ) / wheelbase;
        // Мягкий подъем на выпуклом гребне дюны, чтобы рама не резала верхушку бархана
        const crestLift = Math.max(0, smoothCenterGroundY - wheelLineY) * 0.38;
        const targetGroundY = wheelLineY + crestLift;
        const instantGroundVelY = (targetGroundY - prevTargetGroundY) / Math.max(1e-4, dt);
        prevTargetGroundY = targetGroundY;

        const minJumpSpeed = config.minJumpSpeed ?? BUGGY.minJumpSpeed ?? 4.6;
        const crestLaunchBoost = config.crestLaunchBoost ?? BUGGY.crestLaunchBoost ?? 0.34;

        if (grounded) {
            // Накопление вертикального импульса разгона вверх по склону (сохраняется на ~0.18с при переходе колесной базы через пик горы)
            const slopeClimbVelY = forwardSpeed > 0.5
                ? forwardSpeed * Math.sin(Math.max(0, Math.max(preMoveLongSlopeAngle, longSlopeAngle)))
                : 0;
            const currentClimbVelY = Math.max(instantGroundVelY, slopeClimbVelY);
            if (currentClimbVelY > uphillLaunchVelY) {
                uphillLaunchVelY = currentClimbVelY;
            } else {
                uphillLaunchVelY = Math.max(0, uphillLaunchVelY + gravity * 0.26 * dt);
            }

            const effVertVel = Math.max(verticalVelocity, uphillLaunchVelY);
            const velDropOff = effVertVel - instantGroundVelY;
            const nextBallisticY = currPosition.y + effVertVel * dt + 0.5 * gravity * dt * dt;

            // Проверка отрыва от гребня горы / трамплина на скорости:
            // когда рельеф под колесами резко уходит вниз относительно набранного вертикального вектора скорости
            const canLaunchFromCrest =
                Math.abs(forwardSpeed) >= minJumpSpeed &&
                nextBallisticY > targetGroundY + 0.008 &&
                ((effVertVel > 0.55 && velDropOff > 1.15) || velDropOff > 2.1);

            if (canLaunchFromCrest) {
                grounded = false;
                const speedFactor = THREE.MathUtils.clamp(
                    (Math.abs(forwardSpeed) - minJumpSpeed) / Math.max(1.0, maxForwardSpeed - minJumpSpeed),
                    0.18,
                    1.35
                );
                const reboundPop = 1.0 + crestLaunchBoost * speedFactor;
                verticalVelocity = Math.max(instantGroundVelY + 0.65, effVertVel * reboundPop);
                uphillLaunchVelY = 0;
                currPosition.y += verticalVelocity * dt;
                // Разжатие вилки подвески и легкий подъем носа в момент отрыва от трамплина
                chassisVertVel += 0.32 * speedFactor;
                chassisPitchVel -= 0.75 * speedFactor;
            } else {
                verticalVelocity = instantGroundVelY;
                // Плавное отслеживание профиля рельефа в наземном режиме
                const yDiff = targetGroundY - currPosition.y;
                if (Math.abs(yDiff) < 0.002) {
                    currPosition.y = targetGroundY;
                } else {
                    currPosition.y += yDiff * Math.min(1.0, dt * 30.0);
                }
            }
        } else {
            // Баллистический полет в воздухе над склоном дюны
            uphillLaunchVelY = 0;
            verticalVelocity += gravity * dt;
            currPosition.y += verticalVelocity * dt;
            if (currPosition.y <= targetGroundY && verticalVelocity <= 0) {
                currPosition.y = targetGroundY;
                grounded = true;
                verticalVelocity = 0;
                const landingImpact = Math.max(0.45, Math.abs(preStepVertVel));
                if (chassisHeightOffset > 0) {
                    chassisHeightOffset *= 0.2;
                }
                // Глубокое сжатие подвески и клевок вилки в момент касания песка после прыжка
                chassisVertVel -= Math.min(2.2, landingImpact * 0.44);
                chassisPitchVel += Math.min(1.9, landingImpact * 0.30);
            }
        }

        if (vehicleRig) {
            vehicleRig.setBasePosition(currPosition.x, currPosition.y, currPosition.z);
        }

        position.copy(currPosition);

        // 6. Пружинно-демпферная динамика подвески, тангажа и крена тяжелого мотоцикла (165 кг)
        const terrainPitch = -Math.atan2(smoothFrontGroundY - smoothRearGroundY, wheelbase);
        const dynamicPitch = THREE.MathUtils.clamp(-forwardAccel * 0.0075, -0.10, 0.12);
        let targetPitch: number;
        if (grounded) {
            targetPitch = THREE.MathUtils.clamp(terrainPitch + dynamicPitch, -0.55, 0.55);
        } else {
            // В прыжке нос мотоцикла следует по касательной к параболе полета с возможностью балансировки газом/тормозом
            const flightArcPitch = THREE.MathUtils.clamp(-verticalVelocity * 0.048, -0.34, 0.32);
            const riderAirControl = wantBrake ? 0.08 : (throttleInput * -0.06);
            targetPitch = THREE.MathUtils.clamp(terrainPitch * 0.30 + flightArcPitch + riderAirControl, -0.52, 0.52);
        }

        const pitchStiff = grounded
            ? (config.pitchStiffness ?? BUGGY.pitchStiffness ?? 68.0)
            : 24.0;
        const pitchDamp = grounded
            ? (config.pitchDamping ?? BUGGY.pitchDamping ?? 13.5)
            : 6.5;
        const pitchAccel = (targetPitch - chassisPitch) * pitchStiff - chassisPitchVel * pitchDamp;
        chassisPitchVel += pitchAccel * dt;
        chassisPitch = THREE.MathUtils.clamp(chassisPitch + chassisPitchVel * dt, -0.58, 0.58);
        if (Math.abs(targetPitch - chassisPitch) < 0.0012 && Math.abs(chassisPitchVel) < 0.008) {
            chassisPitch = targetPitch;
            chassisPitchVel = 0;
        }

        const leftY = leftSample.y + (leftSample.sink || 0) * 0.65;
        const rightY = rightSample.y + (rightSample.sink || 0) * 0.65;
        const terrainRoll = grounded ? (Math.atan2(leftY - rightY, 0.72) * 0.35) : 0;
        const yawCentripetalFactor = THREE.MathUtils.clamp(
            Math.abs(currentYawRate) * Math.abs(forwardSpeed) / Math.max(1.0, maxLatAccel),
            0,
            1.15
        );
        const turnLeanRoll = THREE.MathUtils.clamp(
            (-steeringAngle * (0.26 + 0.55 * speedNorm) - Math.sign(currentYawRate) * yawCentripetalFactor * 0.14) *
                (forwardSpeed >= -0.1 ? 1 : -0.5),
            -maxRollLean,
            maxRollLean
        );
        const targetRoll = THREE.MathUtils.clamp(
            (grounded ? turnLeanRoll : turnLeanRoll * 0.55) + terrainRoll,
            -0.42,
            0.42
        );

        const rollStiff = config.rollStiffness ?? BUGGY.rollStiffness ?? 56.0;
        const rollDamp = config.rollDamping ?? BUGGY.rollDamping ?? 12.0;
        const rollAccel = (targetRoll - chassisRoll) * rollStiff - chassisRollVel * rollDamp;
        chassisRollVel += rollAccel * dt;
        chassisRoll = THREE.MathUtils.clamp(chassisRoll + chassisRollVel * dt, -0.45, 0.45);
        if (Math.abs(targetRoll - chassisRoll) < 0.0012 && Math.abs(chassisRollVel) < 0.008) {
            chassisRoll = targetRoll;
            chassisRollVel = 0;
        }

        // Мягкая длинноходная подвеска шасси: разжимается в полете и глубоко сжимается при приземлении
        const maxSuspTravel = config.suspensionMaxTravel ?? BUGGY.suspensionMaxTravel;
        const crestCompression = grounded
            ? THREE.MathUtils.clamp((wheelLineY - smoothCenterGroundY) * 0.22, -0.055, 0.055)
            : maxSuspTravel * 0.55;
        const targetOffset = THREE.MathUtils.clamp(
            crestCompression - (grounded ? Math.abs(forwardAccel) * 0.0022 : 0),
            -maxSuspTravel,
            maxSuspTravel
        );
        const springStiffness = config.suspensionStiffness ?? BUGGY.suspensionStiffness;
        const springDamping = config.suspensionDamping ?? BUGGY.suspensionDamping;
        const springAccel = (targetOffset - chassisHeightOffset) * springStiffness - chassisVertVel * springDamping;
        chassisVertVel += springAccel * dt;
        chassisHeightOffset = THREE.MathUtils.clamp(
            chassisHeightOffset + chassisVertVel * dt,
            -maxSuspTravel,
            maxSuspTravel
        );
        if (Math.abs(targetOffset - chassisHeightOffset) < 0.001 && Math.abs(chassisVertVel) < 0.005) {
            chassisHeightOffset = targetOffset;
            chassisVertVel = 0;
        }

        // 7. Вращение переднего и заднего колеса
        const travelDist = forwardSpeed * dt;
        frontWheelSpin += travelDist / frontWheelRadius;
        rearWheelSpin += (travelDist * (isBoosting ? 1.18 : 1.0)) / rearWheelRadius;

        // 8. Генерация событий контакта колес с песком (отрыв на трамплине, приземление с пробоем подвески, колеи шин)
        const weightForce = (config.mass ?? BUGGY.mass) * Math.abs(gravity);
        if (wasGrounded && !grounded) {
            pushContactEvent('liftoff', Math.abs(forwardSpeed), Math.max(0, verticalVelocity), 0, dt);
        } else if (!wasGrounded && grounded) {
            const impactSpeed = Math.max(0.45, Math.abs(preStepVertVel));
            pushContactEvent('landing', Math.abs(forwardSpeed), impactSpeed, weightForce * (1.25 + impactSpeed * 0.15), dt);
        }

        if (grounded) {
            distanceSinceLastTrack += Math.hypot(stepDx, stepDz);
            if (distanceSinceLastTrack >= tireTrackSpacing) {
                distanceSinceLastTrack = 0;
                pushContactEvent(
                    isBraking ? 'brake_skid' : 'wheel_roll',
                    Math.abs(forwardSpeed),
                    Math.abs(forwardSpeed) * 0.25,
                    weightForce,
                    dt
                );
            }
        }
        prevSimGrounded = grounded;

        // Если мотоцикл полностью остановился и успокоился, жестко синхронизируем prev* и curr*,
        // чтобы интерполяция syncVisuals(alpha) никогда не вызывала микро-тряску между кадрами
        const isSettled =
            Math.abs(forwardSpeed) === 0 &&
            Math.abs(lateralSpeed) === 0 &&
            Math.abs(currentYawRate) === 0 &&
            Math.abs(steerInput) < 1e-3 &&
            grounded &&
            Math.abs(steeringAngle) < 1e-3 &&
            Math.abs(chassisVertVel) === 0 &&
            Math.abs(chassisPitchVel) === 0 &&
            Math.abs(chassisRollVel) === 0 &&
            Math.abs(targetGroundY - currPosition.y) < 1e-4 &&
            Math.abs(targetPitch - chassisPitch) < 1e-4 &&
            Math.abs(targetRoll - chassisRoll) < 1e-4;

        if (isSettled) {
            prevPosition.copy(currPosition);
            prevYaw = currYaw;
            prevSteeringAngle = steeringAngle;
            prevFrontWheelSpin = frontWheelSpin;
            prevRearWheelSpin = rearWheelSpin;
            prevChassisHeightOffset = chassisHeightOffset;
            prevChassisPitch = chassisPitch;
            prevChassisRoll = chassisRoll;
            prevFrontGroundY = smoothFrontGroundY;
            prevRearGroundY = smoothRearGroundY;
        }

        return {
            motion: {
                bodyPos: position.clone(),
                currentYaw: currYaw,
                flatFwd: flatFwd.clone(),
                forwardSpeed,
                forwardAccel,
                steeringAngle,
                chassisHeightOffset,
                chassisPitch,
                chassisRoll,
                frontGroundY: smoothFrontGroundY,
                rearGroundY: smoothRearGroundY,
                frontWheelSpin,
                rearWheelSpin,
                grounded,
                isBoosting,
                isBraking,
                slopeAngle: currentSlopeAngle
            },
            support: {
                plantedCount: grounded ? 2 : 0,
                supportedLoads: grounded ? 2 : 0,
                stability: grounded ? Math.max(0.3, Math.cos(currentSlopeAngle)) : 0,
                sink: grounded ? (frontSample.sink + rearSample.sink) * 0.5 : 0,
                loadRatio: grounded ? 1 : 0,
                copValid: grounded
            }
        };
    }

    function getVisualState(alpha = 1.0): VehicleVisualState {
        const a = THREE.MathUtils.clamp(alpha, 0, 1);
        visualPosition.lerpVectors(prevPosition, currPosition, a);

        let yawDiff = currYaw - prevYaw;
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        visualYaw = prevYaw + yawDiff * a;

        const interpSteer = prevSteeringAngle + (steeringAngle - prevSteeringAngle) * a;
        const interpFrontSpin = prevFrontWheelSpin + (frontWheelSpin - prevFrontWheelSpin) * a;
        const interpRearSpin = prevRearWheelSpin + (rearWheelSpin - prevRearWheelSpin) * a;
        const interpOffset = prevChassisHeightOffset + (chassisHeightOffset - prevChassisHeightOffset) * a;
        const interpPitch = prevChassisPitch + (chassisPitch - prevChassisPitch) * a;
        const interpRoll = prevChassisRoll + (chassisRoll - prevChassisRoll) * a;
        const interpFrontY = prevFrontGroundY + (smoothFrontGroundY - prevFrontGroundY) * a;
        const interpRearY = prevRearGroundY + (smoothRearGroundY - prevRearGroundY) * a;

        return {
            position: visualPosition,
            yaw: visualYaw,
            forwardSpeed,
            forwardAccel,
            lateralSpeed,
            steeringAngle: interpSteer,
            chassisHeightOffset: interpOffset,
            chassisPitch: interpPitch,
            chassisRoll: interpRoll,
            frontGroundY: interpFrontY,
            rearGroundY: interpRearY,
            frontWheelSpin: interpFrontSpin,
            rearWheelSpin: interpRearSpin,
            frontWheelWorldPos,
            rearWheelWorldPos,
            grounded,
            isBoosting,
            isBraking,
            slopeAngle: currentSlopeAngle,
            ground: centerSample,
            frontGround: frontSample,
            rearGround: rearSample
        };
    }

    function getPose() {
        return { position, currentYaw: currYaw, flatFwd };
    }

    function getVisualPose(alpha = 1.0) {
        const vs = getVisualState(alpha);
        visualFlatFwd.set(Math.sin(vs.yaw), 0, Math.cos(vs.yaw));
        return {
            position: vs.position,
            currentYaw: vs.yaw,
            flatFwd: visualFlatFwd
        };
    }

    function setPose(x: number, y: number, z: number, newYaw = currYaw): void {
        position.set(x, y, z);
        prevPosition.copy(position);
        currPosition.copy(position);
        visualPosition.copy(position);
        yaw = newYaw;
        prevYaw = newYaw;
        currYaw = newYaw;
        visualYaw = newYaw;
        flatFwd.set(Math.sin(newYaw), 0, Math.cos(newYaw));
        visualFlatFwd.copy(flatFwd);
        forwardSpeed = 0;
        forwardAccel = 0;
        lateralSpeed = 0;
        verticalVelocity = 0;
        currentYawRate = 0;
        chassisPitchVel = 0;
        chassisRollVel = 0;
        uphillLaunchVelY = 0;
        grounded = true;
        prevSimGrounded = true;
        if (vehicleRig) {
            vehicleRig.setBasePosition(x, y, z);
        }
        updateWheelProbes(x, z, newYaw, 0);
        prevFrontGroundY = smoothFrontGroundY;
        prevRearGroundY = smoothRearGroundY;
        prevTargetGroundY = y;
    }

    function reset(): void {
        forwardSpeed = 0;
        forwardAccel = 0;
        lateralSpeed = 0;
        verticalVelocity = 0;
        steeringAngle = 0;
        prevSteeringAngle = 0;
        currentYawRate = 0;
        chassisHeightOffset = 0;
        prevChassisHeightOffset = 0;
        chassisVertVel = 0;
        chassisPitch = 0;
        prevChassisPitch = 0;
        chassisPitchVel = 0;
        chassisRoll = 0;
        prevChassisRoll = 0;
        chassisRollVel = 0;
        uphillLaunchVelY = 0;
        grounded = true;
        prevSimGrounded = true;
        isBoosting = false;
        isBraking = false;
        cameraSteerActive = false;
        pendingContactEvents.length = 0;
        if (vehicleRig) {
            vehicleRig.setBasePosition(position.x, position.y, position.z);
        }
        prevPosition.copy(position);
        currPosition.copy(position);
        visualPosition.copy(position);
        prevYaw = yaw;
        currYaw = yaw;
        visualYaw = yaw;
        updateWheelProbes(position.x, position.z, yaw, 0);
        prevFrontGroundY = smoothFrontGroundY;
        prevRearGroundY = smoothRearGroundY;
        prevTargetGroundY = position.y;
    }

    function consumeContactEvents(): VehicleContactEvent[] {
        if (pendingContactEvents.length === 0) return [];
        return pendingContactEvents.splice(0, pendingContactEvents.length);
    }

    function getDebug() {
        const weightForce = (config.mass ?? BUGGY.mass) * Math.abs(gravity);
        return {
            actorType: 'buggy',
            forwardSpeed,
            forwardAccel,
            steeringAngle,
            chassisPitch,
            chassisRoll,
            chassisHeightOffset,
            grounded,
            isBoosting,
            isBraking,
            slopeAngle: currentSlopeAngle,
            frontGroundY: frontSample.y,
            rearGroundY: rearSample.y,
            sink: (frontSample.sink + rearSample.sink) * 0.5,
            loop: {
                slope: Math.tan(currentSlopeAngle),
                slopeFactor: 1.0,
                margin: grounded ? 0.5 : 0,
                assist: grounded ? 1.0 : 0,
                slide: isBraking ? Math.abs(forwardSpeed) : 0,
                tipped: false
            },
            contact: {
                normal: grounded ? weightForce : 0,
                tangent: grounded ? Math.abs(forwardSpeed) * (config.mass ?? BUGGY.mass) : 0,
                capacity: grounded ? weightForce * (centerSample.friction || 0.6) : 0,
                saturation: 0,
                slip: isBraking ? Math.abs(forwardSpeed) : 0,
                grip: centerSample.friction || 0.6
            },
            legs: [
                {
                    id: 'front_wheel',
                    contactWeight: grounded ? 1 : 0,
                    contactBlend: grounded ? 1 : 0,
                    normalLoad: grounded ? weightForce * 0.45 : 0
                },
                {
                    id: 'rear_wheel',
                    contactWeight: grounded ? 1 : 0,
                    contactBlend: grounded ? 1 : 0,
                    normalLoad: grounded ? weightForce * 0.55 : 0
                }
            ]
        };
    }

    function dispose(): void {
        if (vehicleRig && !rig) {
            vehicleRig.dispose();
        }
    }

    return {
        rig: vehicleRig,
        onAction,
        update,
        simulateStep,
        consumeContactEvents,
        getPose,
        getVisualPose,
        getVisualState,
        getState: (alpha = 1.0) => getVisualState(alpha),
        setPose,
        reset,
        getDebug,
        dispose
    };
}
