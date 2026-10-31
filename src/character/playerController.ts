import * as THREE from 'three';
import { COSMO } from '../config.ts';
import { createPlayerRig, type PlayerRig } from './playerRig.ts';
import {
    createCharacterGroundProbes,
    createDefaultGroundSample,
    copyGroundSample,
    resolveGroundSample,
    sampleCharacterGroundProbes,
    type CharacterGroundProbes,
    type GroundSample
} from '../world/groundSampler.ts';

export type GroundQuery = ((x: number, z: number) => any) | null;

export type MovementLimitReason =
    | 'none'
    | 'steep_sand_slip'
    | 'steep_slope_limit'
    | 'obstacle_blocked';

export type CosmoContactEventType =
    | 'left_touchdown'
    | 'right_touchdown'
    | 'landing'
    | 'liftoff'
    | 'slide'
    | 'solid_contact';

export interface CosmoContactEvent {
    type: CosmoContactEventType;
    foot: 'left' | 'right' | 'both' | 'none';
    position: THREE.Vector3;
    leftPosition: THREE.Vector3;
    rightPosition: THREE.Vector3;
    yaw: number;
    speed: number;
    impactSpeed: number;
    normalLoad: number;
    isSprinting: boolean;
    dt: number;
    ground: GroundSample;
    leftGround: GroundSample;
    rightGround: GroundSample;
}

export interface PlayerControllerOptions {
    world?: any;
    rig?: PlayerRig | null;
    groundAt?: GroundQuery;
    speed?: number;
    runSpeed?: number;
    gravity?: number;
    spawnPosition?: THREE.Vector3 | { x: number; y: number; z: number };
    config?: typeof COSMO | any;
}

export interface PlayerControllerMotion {
    bodyPos: THREE.Vector3;
    currentYaw: number;
    flatFwd: THREE.Vector3;
    crouch: number;
    moveX: number;
    moveZ: number;
    walkAmount: number;
    walkPhase: number;
    isSliding: boolean;
    slideSpeed: number;
    isSprinting: boolean;
    slopeAngle: number;
    uphillAngle?: number;
    downhillAngle?: number;
    crossSlopeAngle?: number;
    forwardSpeed?: number;
    forwardAccel?: number;
    movementLimitReason?: MovementLimitReason;
    ground?: GroundSample;
    probes?: CharacterGroundProbes;
}

export interface PlayerVisualState {
    position: THREE.Vector3;
    yaw: number;
    crouch: number;
    moveX: number;
    moveZ: number;
    walkAmount: number;
    walkPhase: number;
    bankingRoll: number;
    grounded: boolean;
    isSliding: boolean;
    slideSpeed: number;
    isSprinting: boolean;
    slopeAngle: number;
    uphillAngle?: number;
    downhillAngle?: number;
    crossSlopeAngle?: number;
    forwardSpeed?: number;
    forwardAccel?: number;
    movementLimitReason?: MovementLimitReason;
    ground?: GroundSample;
    probes?: CharacterGroundProbes;
}

export interface PlayerController {
    rig: PlayerRig | null;
    update(dt: number, ctx?: any): any;
    simulateStep(dt: number, command: any, weatherState?: any): { motion: PlayerControllerMotion; support: any };
    consumeContactEvents(): CosmoContactEvent[];
    peekContactEvents(): readonly CosmoContactEvent[];
    getProbes(): CharacterGroundProbes;
    setModelDebug?(modelDebug: any): void;
    setWaypoint(): void;
    reset(): void;
    getPose(): { position: THREE.Vector3; currentYaw: number; flatFwd: THREE.Vector3 };
    getVisualPose(alpha?: number): { position: THREE.Vector3; currentYaw: number; flatFwd: THREE.Vector3 };
    getVisualState(alpha?: number): PlayerVisualState;
    getDebug(): any;
    getState(alpha?: number): PlayerVisualState;
    dispose(): void;
}

/**
 * Контроллер двуногого персонажа Cosmo.
 * При наличии world или rig работает через физический KinematicCharacterController в Rapier 3D,
 * обеспечивая коллизии со скалами, мехом и расталкивание обломков.
 * При отсутствии world сохраняет аналитический масс-пружинный режим для изоляции в headless тестах.
 */
export function createPlayerController(options: PlayerControllerOptions = {}): PlayerController {
    const {
        world = null,
        rig = null,
        speed = COSMO.speed,
        runSpeed = COSMO.runSpeed ?? (COSMO.speed * 1.9),
        gravity = COSMO.gravity,
        spawnPosition = new THREE.Vector3(0, 0, 0),
        config = COSMO
    } = options;

    const hasCustomGroundAt = typeof options.groundAt === 'function';
    const spawnVec = spawnPosition instanceof THREE.Vector3
        ? spawnPosition.clone()
        : new THREE.Vector3(spawnPosition?.x || 0, spawnPosition?.y || 0, spawnPosition?.z || 0);

    const playerRig = rig || (world ? createPlayerRig({ world, spawnPosition: spawnVec, config }) : null);

    const effectiveGroundAt: (x: number, z: number) => any = hasCustomGroundAt
        ? (options.groundAt as (x: number, z: number) => any)
        : (playerRig && typeof playerRig.sampleWorldGround === 'function'
            ? (x: number, z: number) => playerRig.sampleWorldGround!(x, z) ?? 0
            : () => 0);

    const probes = createCharacterGroundProbes();
    const scratchSample = createDefaultGroundSample();
    const filteredNormal = new THREE.Vector3(0, 1, 0);
    const tangentVec = new THREE.Vector3();

    function sampleGround(x: number, z: number, out: GroundSample = scratchSample, computeNormal = true): GroundSample {
        return resolveGroundSample(effectiveGroundAt, x, z, out, computeNormal);
    }

    const initialSample = sampleGround(spawnVec.x, spawnVec.z, scratchSample, false);
    let initialY = spawnVec.y;
    if (!playerRig) {
        initialY = initialSample.y + Math.max(0, spawnVec.y);
    } else if (typeof playerRig.sampleWorldGround === 'function') {
        const wg = playerRig.sampleWorldGround(spawnVec.x, spawnVec.z);
        if (wg && initialY < wg.y && Math.abs(initialY - wg.y) < 0.5) {
            initialY = wg.y;
            playerRig.setFeetPosition(spawnVec.x, initialY, spawnVec.z);
        }
    }
    const position = new THREE.Vector3(spawnVec.x, initialY, spawnVec.z);

    const prevPosition = position.clone();
    const currPosition = position.clone();
    const visualPosition = position.clone();

    const flatFwd = new THREE.Vector3(0, 0, 1);
    const visualFlatFwd = new THREE.Vector3(0, 0, 1);
    const desiredTranslationScratch = { x: 0, y: 0, z: 0 };
    let yaw = 0;
    let prevYaw = 0;
    let currYaw = 0;
    let visualYaw = 0;

    let crouch = 0;
    let verticalVelocity = 0;
    let grounded = !playerRig ? (spawnVec.y <= 0.02) : (Math.abs(initialY - initialSample.y) <= 0.15 || spawnVec.y <= 0.02);
    let walkPhase = 0;
    let walkAmount = 0;
    let lastMoveX = 0;
    let lastMoveZ = 0;
    let lastObstacleResistance = false;

    let bankingRoll = 0;
    let smoothBanking = 0;

    // Состояние песчаного серфинга (Sand Sliding), уклонов и гистерезиса
    let isSliding = false;
    let slideSpeed = 0;
    let slideExitTimer = 0;
    let isSteepSlopeBlocked = false;
    let movementLimitReason: MovementLimitReason = 'none';
    let isSprinting = false;
    let currentSlopeAngle = 0;
    let currentUphillAngle = 0;
    let currentDownhillAngle = 0;
    let currentCrossSlopeAngle = 0;
    let currentSlopeFactor = 1.0;
    let currentDownhillX = 0;
    let currentDownhillZ = 0;
    let isOnCrest = false;
    let currentForwardSpeed = 0;
    let currentForwardAccel = 0;

    const slideMinAngle = config.slideMinAngle ?? (22 * Math.PI / 180);
    const slideExitAngle = config.slideExitAngle ?? (14 * Math.PI / 180);
    const slideMaxSpeed = config.slideMaxSpeed ?? 7.2;
    const slideExitHysteresisTime = config.slideExitHysteresisTime ?? 0.06;
    const steepEnterMarginRad = config.steepEnterMarginRad ?? (1.5 * Math.PI / 180);
    const steepExitMarginRad = config.steepExitMarginRad ?? (3.0 * Math.PI / 180);

    // Буфер симуляционных событий контакта со средой (потребляется в playerActor)
    const pendingContactEvents: CosmoContactEvent[] = [];
    const eventCounts = {
        leftTouchdown: 0,
        rightTouchdown: 0,
        landing: 0,
        liftoff: 0,
        slide: 0,
        solidContact: 0
    };
    let prevSimGrounded = grounded;
    let prevLeftInStance = true;
    let prevRightInStance = true;
    let prevSurfaceType = initialSample.surfaceType;
    let smoothStepDy = 0;
    let lastModelDebug: any = null;

    function pushContactEvent(
        type: CosmoContactEventType,
        foot: 'left' | 'right' | 'both' | 'none',
        footPos: THREE.Vector3,
        leftPos: THREE.Vector3,
        rightPos: THREE.Vector3,
        speedVal: number,
        impactSpeedVal: number,
        normalLoadVal: number,
        dtVal: number,
        groundSample: GroundSample
    ) {
        if (type === 'left_touchdown') eventCounts.leftTouchdown++;
        else if (type === 'right_touchdown') eventCounts.rightTouchdown++;
        else if (type === 'landing') eventCounts.landing++;
        else if (type === 'liftoff') eventCounts.liftoff++;
        else if (type === 'slide') eventCounts.slide++;
        else if (type === 'solid_contact') eventCounts.solidContact++;

        pendingContactEvents.push({
            type,
            foot,
            position: footPos.clone(),
            leftPosition: leftPos.clone(),
            rightPosition: rightPos.clone(),
            yaw: currYaw,
            speed: speedVal,
            impactSpeed: impactSpeedVal,
            normalLoad: normalLoadVal,
            isSprinting,
            dt: dtVal,
            ground: copyGroundSample(groundSample, createDefaultGroundSample()),
            leftGround: copyGroundSample(probes.leftFoot, createDefaultGroundSample()),
            rightGround: copyGroundSample(probes.rightFoot, createDefaultGroundSample())
        });
    }

    function updateProbes(x: number, z: number, dirX: number, dirZ: number) {
        const len = Math.hypot(dirX, dirZ);
        const fwdX = len > 1e-4 ? dirX / len : Math.sin(yaw);
        const fwdZ = len > 1e-4 ? dirZ / len : Math.cos(yaw);
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);
        sampleCharacterGroundProbes(effectiveGroundAt, x, z, fwdX, fwdZ, rightX, rightZ, config, probes);
    }

    // Инициализируем пробы в точке спавна
    updateProbes(currPosition.x, currPosition.z, Math.sin(yaw), Math.cos(yaw));
    filteredNormal.copy(probes.center.normal);

    function update(dt: number, ctx: any = {}): any {
        const actions = ctx.actions || {};
        const moveX = (actions.right ? 1 : 0) - (actions.left ? 1 : 0);
        const moveZ = (actions.forward ? 1 : 0) - (actions.backward ? 1 : 0);
        crouch = actions.crouchDown ? 1 : (actions.crouchUp ? 0 : crouch);

        let localX = moveX;
        let localZ = moveZ;
        let worldX = 0;
        let worldZ = 0;
        const inputLength = Math.hypot(localX, localZ);

        if (ctx.cameraAzimuth !== undefined && inputLength > 0) {
            // Third-Person Action: перемещение относительно ракурса камеры
            const normX = localX / (inputLength > 1 ? inputLength : 1);
            const normZ = localZ / (inputLength > 1 ? inputLength : 1);
            const camAzimuth = ctx.cameraAzimuth;
            const camFwdX = Math.sin(camAzimuth);
            const camFwdZ = Math.cos(camAzimuth);
            // Вектор «вправо» для камеры: F x (0,1,0) = (-Fz, 0, Fx)
            const camRightX = -Math.cos(camAzimuth);
            const camRightZ = Math.sin(camAzimuth);

            const dirX = camFwdX * normZ + camRightX * normX;
            const dirZ = camFwdZ * normZ + camRightZ * normX;

            const targetYaw = Math.atan2(dirX, dirZ);
            let error = targetYaw - yaw;
            while (error > Math.PI) error -= Math.PI * 2;
            while (error < -Math.PI) error += Math.PI * 2;

            // Критически демпфированный поворот без резких скачков
            const turnRate = 12.0;
            const maxTurnStep = dt * 14.0;
            const turnDelta = THREE.MathUtils.clamp(error * Math.min(1.0, dt * turnRate), -maxTurnStep, maxTurnStep);
            yaw += turnDelta;

            // Динамический наклон (banking) при повороте на бегу
            const turnAngVel = turnDelta / Math.max(1e-4, dt);
            bankingRoll = THREE.MathUtils.clamp(-turnAngVel * 0.045 * Math.min(1, inputLength), -0.16, 0.16);

            worldX = dirX;
            worldZ = dirZ;

            // Локальный вектор направления относительно текущего yaw персонажа
            const cosY = Math.cos(yaw);
            const sinY = Math.sin(yaw);
            lastMoveX = (cosY * dirX - sinY * dirZ) * Math.min(1, inputLength);
            lastMoveZ = (sinY * dirX + cosY * dirZ) * Math.min(1, inputLength);
        } else {
            if (inputLength > 1) {
                localX /= inputLength;
                localZ /= inputLength;
            }
            lastMoveX = localX;
            lastMoveZ = localZ;
            bankingRoll = 0;
            // Резервный режим без привязки к камере
            worldX = Math.sin(yaw) * localZ + Math.cos(yaw) * localX;
            worldZ = Math.cos(yaw) * localZ - Math.sin(yaw) * localX;
        }

        smoothBanking += (bankingRoll - smoothBanking) * Math.min(1.0, dt * 9.0);

        // --- Многоточечный опрос поверхности (центр, левая/правая стопа, впереди, позади) ---
        const probeDirX = inputLength > 0.01 ? worldX : Math.sin(yaw);
        const probeDirZ = inputLength > 0.01 ? worldZ : Math.cos(yaw);
        updateProbes(currPosition.x, currPosition.z, probeDirX, probeDirZ);

        const groundInfo = probes.center;
        // Сглаживание эффективной нормали по центру и стопам для защиты от локального шума отпечатков и гребней
        const avgVec = tangentVec.set(
            groundInfo.normal.x * 0.5 + (probes.leftFoot.normal.x + probes.rightFoot.normal.x) * 0.25,
            Math.max(0.05, groundInfo.normal.y * 0.5 + (probes.leftFoot.normal.y + probes.rightFoot.normal.y) * 0.25),
            groundInfo.normal.z * 0.5 + (probes.leftFoot.normal.z + probes.rightFoot.normal.z) * 0.25
        ).normalize();
        const normBlend = Math.min(1.0, dt * 18.0);
        filteredNormal.lerp(avgVec, normBlend).normalize();

        const nx = avgVec.x;
        const ny = Math.max(0.05, avgVec.y);
        const nz = avgVec.z;
        const horizLen = Math.hypot(nx, nz);
        const terrainSlopeAngle = Math.atan2(horizLen, ny);
        let downhillX = 0;
        let downhillZ = 0;
        if (horizLen > 1e-4) {
            downhillX = nx / horizLen;
            downhillZ = nz / horizLen;
        }
        currentSlopeAngle = terrainSlopeAngle;
        currentDownhillX = downhillX;
        currentDownhillZ = downhillZ;

        // Обнаружение перехода через гребень дюны (центр выше и передней, и задней пробы)
        const aheadDist = config.probeAheadDistance ?? COSMO.probeAheadDistance ?? 0.42;
        const behindDist = config.probeBehindDistance ?? COSMO.probeBehindDistance ?? 0.36;
        const deltaAhead = probes.ahead.y - groundInfo.y;
        const deltaBehind = probes.behind.y - groundInfo.y;
        isOnCrest = (deltaAhead < -0.015 && deltaBehind < -0.015);

        // Разделение продольного (подъем/спуск) и поперечного уклона с использованием нормали и проб
        let moveSlopeAngle = 0;
        let crossSlopeAngle = 0;
        const moveNorm = Math.hypot(worldX, worldZ);
        if (moveNorm > 0.01) {
            const dirX = worldX / moveNorm;
            const dirZ = worldZ / moveNorm;
            const rightMoveX = dirZ;
            const rightMoveZ = -dirX;

            // Продольный наклон по нормали поверхности + по передней пробе
            // Если впереди небольшой уступ в пределах autostepMaxHeight с плоской верхней гранью,
            // не считаем вертикальную грань уступа крутым склоном, чтобы сохранить работу autostep.
            const maxAutostep = config.autostepMaxHeight ?? COSMO.autostepMaxHeight ?? 0.32;
            const aheadHoriz = Math.hypot(probes.ahead.normal.x, probes.ahead.normal.z);
            const aheadNormalSlope = Math.atan2(aheadHoriz, Math.max(0.05, probes.ahead.normal.y));
            const isSteppableLedge = deltaAhead > 0.01 && deltaAhead <= maxAutostep && aheadNormalSlope < terrainSlopeAngle + 0.20;

            const normalLongSlope = Math.atan2(-(nx * dirX + nz * dirZ), ny);
            const rawProbeSlope = Math.atan2(deltaAhead, aheadDist);
            const probeLongSlope = isSteppableLedge
                ? Math.min(rawProbeSlope, Math.max(normalLongSlope, aheadNormalSlope) + 0.08)
                : rawProbeSlope;
            moveSlopeAngle = isOnCrest
                ? normalLongSlope * 0.5 + probeLongSlope * 0.25
                : normalLongSlope * 0.45 + probeLongSlope * 0.55;

            // Поперечный уклон по нормали поверхности и перепаду между стопами
            const normalCrossSlope = Math.atan2(Math.abs(nx * rightMoveX + nz * rightMoveZ), ny);
            const footSpan = (config.probeFootOffsetX ?? 0.19) * 2.0;
            const probeCrossSlope = Math.atan2(Math.abs(probes.leftFoot.y - probes.rightFoot.y), footSpan);
            crossSlopeAngle = normalCrossSlope * 0.65 + probeCrossSlope * 0.35;
        } else {
            const footSpan = (config.probeFootOffsetX ?? 0.19) * 2.0;
            crossSlopeAngle = Math.atan2(Math.abs(probes.leftFoot.y - probes.rightFoot.y), footSpan);
        }

        currentUphillAngle = Math.max(0, moveSlopeAngle);
        currentDownhillAngle = Math.max(0, -moveSlopeAngle);
        currentCrossSlopeAngle = crossSlopeAngle;

        // --- Модификатор скорости и сцепления по типу поверхности и материалу ---
        const onSand = groundInfo.surfaceType === 'sand';
        let matMultiplier = 1.0;
        if (groundInfo.materialId === 'loose_sand') {
            // Уплотнение песка повышает скорость от 0.90 до 0.96, просадка (sink) слегка тормозит
            const packBonus = (groundInfo.packing || 0) * 0.06;
            const sinkPenalty = Math.min(0.12, (groundInfo.sink || 0) * 0.35);
            matMultiplier = 0.90 + packBonus - sinkPenalty;
        } else if (groundInfo.materialId === 'compacted_sand' || groundInfo.materialId === 'dense_layer') {
            matMultiplier = 0.98;
        } else if (groundInfo.surfaceType === 'solid' || groundInfo.materialId === 'stone' || groundInfo.materialId === 'bedrock') {
            matMultiplier = config.stoneGripMultiplier ?? 1.05; // твердое сцепление со скалой
        }

        // --- Гистерезис ограничения движения на слишком крутом склоне ---
        const maxAllowedAngle = groundInfo.maxContactAngle ?? (config.maxSlopeClimbAngle ?? (45 * Math.PI / 180));
        const maxAutostepH = config.autostepMaxHeight ?? COSMO.autostepMaxHeight ?? 0.32;
        const dotDown = worldX * downhillX + worldZ * downhillZ;
        const climbingSteep = moveNorm > 0.01 && (dotDown < -0.15 || deltaAhead > maxAutostepH);

        if (!isSteepSlopeBlocked) {
            if (climbingSteep && (terrainSlopeAngle > maxAllowedAngle + steepEnterMarginRad || (deltaAhead > maxAutostepH && currentUphillAngle > maxAllowedAngle + steepEnterMarginRad))) {
                isSteepSlopeBlocked = true;
            }
        } else {
            if (!climbingSteep || (currentUphillAngle < maxAllowedAngle - steepExitMarginRad && terrainSlopeAngle < maxAllowedAngle - steepExitMarginRad)) {
                isSteepSlopeBlocked = false;
            }
        }

        // --- Проверка условий песчаного серфинга (Sand Sliding) с угловым и временным гистерезисом ---
        const isSteepDune = terrainSlopeAngle >= slideMinAngle;
        const wantsCrouch = crouch === 1;

        if (grounded && onSand && wantsCrouch && isSteepDune) {
            if (isSliding || inputLength < 0.05 || dotDown > -0.2) {
                isSliding = true;
                slideExitTimer = 0;
            }
        } else if (isSliding) {
            const lostGroundOrCrouch = !grounded || !onSand || !wantsCrouch;
            const flattenedOut = terrainSlopeAngle < slideExitAngle;
            if (lostGroundOrCrouch || flattenedOut) {
                if (flattenedOut && !lostGroundOrCrouch) {
                    slideExitTimer += dt;
                } else {
                    slideExitTimer = slideExitHysteresisTime + 0.01;
                }

                if (slideExitTimer >= slideExitHysteresisTime) {
                    if (slideSpeed <= speed * 1.1) {
                        isSliding = false;
                        slideSpeed = 0;
                        slideExitTimer = 0;
                    } else {
                        // Плавное торможение песком перед полным вставанием на ноги
                        slideSpeed = Math.max(0, slideSpeed - 9.0 * dt);
                        if (slideSpeed <= speed) {
                            isSliding = false;
                            slideSpeed = 0;
                            slideExitTimer = 0;
                        }
                    }
                }
            } else {
                slideExitTimer = 0;
            }
        }

        isSprinting = Boolean((actions.sprint || actions.run) && crouch === 0);
        const sprintTargetSpeed = runSpeed ?? config.runSpeed ?? config.sprintSpeed ?? (speed * 1.9);
        const currentBaseSpeed = isSprinting ? sprintTargetSpeed : speed;
        let effectiveSpeed = currentBaseSpeed * matMultiplier;
        movementLimitReason = 'none';

        if (isSliding) {
            // === РЕЖИМ ПЕСЧАНОГО СЕРФИНГА ===
            const aGravityDown = 18.0 * (Math.sin(terrainSlopeAngle) - 0.38 * Math.cos(terrainSlopeAngle));
            slideSpeed = THREE.MathUtils.clamp(
                (slideSpeed || (speed * 1.3)) + aGravityDown * dt,
                speed * 0.8,
                slideMaxSpeed
            );
            effectiveSpeed = slideSpeed;
            currentSlopeFactor = effectiveSpeed / Math.max(0.1, currentBaseSpeed);

            // Направление серфинга: основной вектор вниз по склону + подруливание игрока
            let slideDirX = downhillX;
            let slideDirZ = downhillZ;
            if (inputLength > 0.05) {
                slideDirX = downhillX * 0.65 + worldX * 0.45;
                slideDirZ = downhillZ * 0.65 + worldZ * 0.45;
                const slLen = Math.hypot(slideDirX, slideDirZ);
                if (slLen > 1e-4) {
                    slideDirX /= slLen;
                    slideDirZ /= slLen;
                }
            }
            worldX = slideDirX;
            worldZ = slideDirZ;

            // Поворот корпуса по направлению скольжения
            const slideTargetYaw = Math.atan2(slideDirX, slideDirZ);
            let sError = slideTargetYaw - yaw;
            while (sError > Math.PI) sError -= Math.PI * 2;
            while (sError < -Math.PI) sError += Math.PI * 2;
            yaw += THREE.MathUtils.clamp(sError * Math.min(1.0, dt * 10.0), -dt * 12.0, dt * 12.0);

            walkAmount = 0; // в скольжении шагов нет — стопы зафиксированы
        } else {
            // === ОБЫЧНЫЙ БЕГ / ХОДЬБА С МОДУЛЯЦИЕЙ ПО ПРОДОЛЬНОМУ И ПОПЕРЕЧНОМУ УКЛОНУ ===
            let targetSlopeFactor = 1.0;
            const uphillSlowdown = config.uphillMaxSlowdown ?? 0.45;
            const downhillSpeedup = config.downhillMaxSpeedup ?? 0.35;
            const crossSlowdown = config.crossSlopeMaxSlowdown ?? 0.18;

            if (moveSlopeAngle > 0.01) {
                // Подъем в гору: плавное замедление до (1 - uphillSlowdown)
                const sinSlope = Math.sin(moveSlopeAngle);
                const climbRatio = THREE.MathUtils.clamp(sinSlope / Math.sin(45 * Math.PI / 180), 0, 1);
                targetSlopeFactor *= (1.0 - uphillSlowdown * climbRatio);
            } else if (moveSlopeAngle < -0.01) {
                // Спуск под гору: контролируемое ускорение до (1 + downhillSpeedup)
                const sinDescent = -Math.sin(moveSlopeAngle);
                const descentRatio = THREE.MathUtils.clamp(sinDescent / Math.sin(30 * Math.PI / 180), 0, 1);
                targetSlopeFactor *= (1.0 + downhillSpeedup * descentRatio);
            }

            if (crossSlopeAngle > 0.08 && Math.abs(moveSlopeAngle) < 0.05) {
                // Поперечный уклон (траверс склона): небольшое снижение скорости для удержания баланса
                const crossRatio = THREE.MathUtils.clamp((crossSlopeAngle - 0.08) / (35 * Math.PI / 180), 0, 1);
                targetSlopeFactor *= (1.0 - crossSlowdown * crossRatio);
            }

            if (isSteepSlopeBlocked) {
                // Превышен предельный угол подъема для данного материала
                movementLimitReason = onSand ? 'steep_sand_slip' : 'steep_slope_limit';
                // Отсекаем компоненту движения вверх по слишком крутому склону
                if (dotDown < 0) {
                    worldX -= downhillX * dotDown;
                    worldZ -= downhillZ * dotDown;
                }
                if (onSand) {
                    // На рыхлом крутом песке возникает сползание вниз по линии ската
                    const slipGain = (config.looseSandSlipFactor ?? 0.22) * (1.0 - 0.65 * (groundInfo.packing || 0));
                    worldX = worldX * 0.35 + downhillX * slipGain;
                    worldZ = worldZ * 0.35 + downhillZ * slipGain;
                    targetSlopeFactor *= 0.35;
                } else {
                    // На твердом камне стопы удерживают сцепление без бокового/продольного сползания
                    targetSlopeFactor *= 0.25;
                }
            } else if (onSand && crossSlopeAngle > 0.18 && inputLength > 0.05) {
                // Различие рыхлого песка и камня на поперечном склоне: легкий снос по песку вниз по уклону
                const slipRatio = THREE.MathUtils.clamp((crossSlopeAngle - 0.18) / (30 * Math.PI / 180), 0, 1);
                const sandSlip = (config.looseSandSlipFactor ?? 0.22) * 0.35 * slipRatio * (1.0 - 0.7 * (groundInfo.packing || 0));
                worldX += downhillX * sandSlip;
                worldZ += downhillZ * sandSlip;
                const wLen = Math.hypot(worldX, worldZ);
                if (wLen > 1.0) {
                    worldX /= wLen;
                    worldZ /= wLen;
                }
            }

            const slopeBlend = (walkAmount < 0.05 || dt >= 0.08) ? 1.0 : Math.min(1.0, dt * 12.0);
            currentSlopeFactor += (targetSlopeFactor - currentSlopeFactor) * slopeBlend;
            effectiveSpeed *= currentSlopeFactor;

            let targetWalk = Math.min(1, inputLength);
            if (lastObstacleResistance) {
                targetWalk *= 0.15; // замедление шага при упоре в препятствие
                movementLimitReason = 'obstacle_blocked';
            } else if (isSteepSlopeBlocked) {
                targetWalk *= 0.35;
            }
            const rampRate = targetWalk > walkAmount ? 8.0 : 10.0;
            walkAmount += THREE.MathUtils.clamp((targetWalk - walkAmount) * dt * rampRate, -1, 1);
            if (targetWalk === 0 && walkAmount < 0.01) walkAmount = 0;

            const cadenceMultiplier = isSprinting ? 2.1 : 2.6;
            walkPhase += walkAmount * effectiveSpeed * dt * cadenceMultiplier;
        }

        // Отслеживание продольного ускорения для наклона корпуса при разгоне/торможении
        const targetFwdSpeed = (inputLength > 0.01 || isSliding) ? effectiveSpeed * Math.min(1, Math.max(inputLength, isSliding ? 1 : 0)) : 0;
        const rawAccel = (targetFwdSpeed - currentForwardSpeed) / Math.max(1e-3, dt);
        currentForwardAccel += (THREE.MathUtils.clamp(rawAccel, -18.0, 18.0) - currentForwardAccel) * Math.min(1.0, dt * 10.0);
        currentForwardSpeed = targetFwdSpeed;

        // Прыжок Cosmo (поддерживается и во время скольжения, выталкивая вверх)
        if (grounded && (actions.jump || (actions.crouchUp && !crouch && actions.isJumpIntent))) {
            verticalVelocity = config.jumpSpeed ?? 4.5;
            grounded = false;
            if (isSliding) {
                isSliding = false;
                slideSpeed = 0;
            }
        }

        return {
            worldX,
            worldZ,
            localX: lastMoveX,
            localZ: lastMoveZ,
            speed: effectiveSpeed,
            baseSpeed: currentBaseSpeed,
            isSprinting,
            crouch,
            walkAmount,
            walkPhase,
            isManual: inputLength !== 0,
            isSliding,
            slideSpeed: isSliding ? slideSpeed : 0,
            terrainSlopeAngle,
            moveSlopeAngle,
            uphillAngle: currentUphillAngle,
            downhillAngle: currentDownhillAngle,
            crossSlopeAngle: currentCrossSlopeAngle,
            movementLimitReason
        };
    }

    function simulateStep(dt: number, command: any, _weatherState?: any): { motion: PlayerControllerMotion; support: any } {
        prevPosition.copy(currPosition);
        prevYaw = currYaw;

        const wasGrounded = prevSimGrounded;
        const preStepVertVel = verticalVelocity;

        const cmdWorldX = command.worldX || 0;
        const cmdWorldZ = command.worldZ || 0;
        const cmdSpeed = command.speed || 0;

        if (playerRig) {
            // === РЕЖИМ 1: Rapier 3D Kinematic Character Controller ===
            const horizX = cmdWorldX * cmdSpeed * dt;
            const horizZ = cmdWorldZ * cmdSpeed * dt;

            // Проекция движения по касательной к поверхности для плавного сопровождения спуска
            let tangentY = 0;
            if (grounded && verticalVelocity <= 0 && (Math.abs(horizX) > 1e-5 || Math.abs(horizZ) > 1e-5)) {
                const n = filteredNormal;
                const ny = Math.max(0.25, n.y);
                tangentY = -(horizX * n.x + horizZ * n.z) / ny;
                if (isOnCrest && tangentY > 0) {
                    tangentY *= (1.0 - (config.crestSmoothFactor ?? 0.65));
                }
                tangentY = THREE.MathUtils.clamp(tangentY, -Math.abs(cmdSpeed * dt * 1.2), Math.abs(cmdSpeed * dt * 1.2));
            }

            // Гравитация и вертикальное смещение:
            // На подъеме Rapier KCC сам скользит вверх по коллайдеру склона от (horizX, horizZ),
            // а для сохранения computedGrounded() === true ему необходим небольшой прижим вниз (vertY <= -0.01).
            verticalVelocity += gravity * dt;
            if (verticalVelocity < -28.0) verticalVelocity = -28.0;

            const vertY = (grounded && verticalVelocity <= 0)
                ? Math.min(-0.01, verticalVelocity * dt + Math.min(0, tangentY * 0.5))
                : verticalVelocity * dt;

            desiredTranslationScratch.x = horizX;
            desiredTranslationScratch.y = vertY;
            desiredTranslationScratch.z = horizZ;

            const { movement, grounded: kccGrounded } = playerRig.computeMovement(desiredTranslationScratch);
            const requestedDist = Math.hypot(horizX, horizZ);

            playerRig.applyMovement(movement);

            const feet = playerRig.getFeetPosition();
            currPosition.set(feet.x, feet.y, feet.z);

            grounded = kccGrounded;

            // Согласование положения Cosmo с реальной высотой поверхности после физического подшага
            // (мягкая защита от проваливания капсулы под рельеф и плавная доводка на гребнях без скачков).
            if (hasCustomGroundAt || typeof playerRig.sampleWorldGround === 'function') {
                const postSample = sampleGround(currPosition.x, currPosition.z, scratchSample, true);
                const worldGround = (hasCustomGroundAt && typeof playerRig.sampleWorldGround === 'function')
                    ? playerRig.sampleWorldGround(currPosition.x, currPosition.z)
                    : null;
                const surfaceY = worldGround ? Math.max(postSample.y, worldGround.y) : postSample.y;
                const heightDiff = surfaceY - currPosition.y;

                if (heightDiff > 0.015 && verticalVelocity <= 0.5) {
                    const liftBlend = heightDiff > 0.08 ? 1.0 : 0.45;
                    currPosition.y += heightDiff * liftBlend;
                    playerRig.setFeetPosition(currPosition.x, currPosition.y, currPosition.z);
                    grounded = true;
                } else if (verticalVelocity <= 0 && Math.abs(heightDiff) <= 0.025) {
                    grounded = true;
                } else if (grounded && verticalVelocity <= 0 && heightDiff < -0.015 && heightDiff > -(config.snapToGroundDistance ?? 0.35)) {
                    const snapRate = isOnCrest ? 0.35 : 0.45;
                    currPosition.y += heightDiff * snapRate;
                    playerRig.setFeetPosition(currPosition.x, currPosition.y, currPosition.z);
                }
            }

            // Плавная фильтрация вертикального шага над свежими воронками/валиками собственных отпечатков
            if (grounded && verticalVelocity <= 0 && requestedDist > 1e-4) {
                const rawY = currPosition.y;
                const rawDy = rawY - prevPosition.y;
                const maxD2y = 0.014;
                smoothStepDy += THREE.MathUtils.clamp(rawDy - smoothStepDy, -maxD2y, maxD2y);
                const smoothedY = prevPosition.y + smoothStepDy;
                if (Math.abs(smoothedY - rawY) <= 0.035) {
                    currPosition.y = smoothedY;
                    smoothStepDy = currPosition.y - prevPosition.y;
                    playerRig.setFeetPosition(currPosition.x, currPosition.y, currPosition.z);
                } else {
                    smoothStepDy = rawDy;
                }
            } else {
                smoothStepDy = currPosition.y - prevPosition.y;
            }

            if (grounded && verticalVelocity < 0) {
                verticalVelocity = 0;
            }

            // Определение упора в реальное вертикальное препятствие (не склон)
            if (requestedDist > 1e-4) {
                const actualDist = Math.hypot(movement.x, movement.z);
                const climbedUp = movement.y > requestedDist * 0.12;
                lastObstacleResistance = (actualDist / requestedDist) < 0.2 && !climbedUp && !isSteepSlopeBlocked;
                if (lastObstacleResistance && movementLimitReason === 'none') {
                    movementLimitReason = 'obstacle_blocked';
                }
            } else {
                lastObstacleResistance = false;
            }
        } else {
            // === РЕЖИМ 2: Аналитический Fallback для легковесных тестов ===
            currPosition.x += cmdWorldX * cmdSpeed * dt;
            currPosition.z += cmdWorldZ * cmdSpeed * dt;

            const postSample = sampleGround(currPosition.x, currPosition.z, scratchSample, false);
            const groundY = postSample.y;

            if (!grounded) {
                verticalVelocity += gravity * dt;
                currPosition.y += verticalVelocity * dt;
                if (currPosition.y <= groundY) {
                    currPosition.y = groundY;
                    verticalVelocity = 0;
                    grounded = true;
                }
            } else {
                // Масс-пружинная подвеска: сглаживание высоты над рельефом
                const diff = groundY - currPosition.y;
                const springForce = diff * 320.0 - verticalVelocity * 36.0;
                verticalVelocity += springForce * dt;
                currPosition.y += verticalVelocity * dt;

                if (currPosition.y < groundY - 0.02) {
                    currPosition.y = groundY - 0.02;
                    if (verticalVelocity < 0) verticalVelocity = 0;
                }
                if (Math.abs(currPosition.y - groundY) < 0.002 && Math.abs(verticalVelocity) < 0.02) {
                    currPosition.y = groundY;
                    verticalVelocity = 0;
                }
            }
        }

        position.copy(currPosition);
        currYaw = yaw;
        flatFwd.set(Math.sin(yaw), 0, Math.cos(yaw));

        // Обновляем пробы в новой физической позиции после подшага
        const probeDirX = Math.hypot(cmdWorldX, cmdWorldZ) > 0.01 ? cmdWorldX : Math.sin(yaw);
        const probeDirZ = Math.hypot(cmdWorldX, cmdWorldZ) > 0.01 ? cmdWorldZ : Math.cos(yaw);
        updateProbes(currPosition.x, currPosition.z, probeDirX, probeDirZ);

        // === Генерация симуляционных событий контакта стоп с поверхностью ===
        const sinY = Math.sin(currYaw);
        const cosY = Math.cos(currYaw);
        const rightX = cosY;
        const rightZ = -sinY;
        const footLat = config.probeFootOffsetX ?? 0.19;
        const leftFootPos = new THREE.Vector3(
            currPosition.x - rightX * footLat,
            probes.leftFoot.y,
            currPosition.z - rightZ * footLat
        );
        const rightFootPos = new THREE.Vector3(
            currPosition.x + rightX * footLat,
            probes.rightFoot.y,
            currPosition.z + rightZ * footLat
        );
        const weightForce = (config.mass ?? 85.0) * Math.abs(gravity);

        if (wasGrounded && !grounded) {
            pushContactEvent(
                'liftoff',
                'both',
                currPosition,
                leftFootPos,
                rightFootPos,
                cmdSpeed,
                0,
                0,
                dt,
                probes.center
            );
        } else if (!wasGrounded && grounded) {
            const impactSpeed = Math.max(0.5, Math.abs(preStepVertVel));
            const impactLoad = weightForce * (1.25 + impactSpeed * 0.18);
            pushContactEvent(
                'landing',
                'both',
                currPosition,
                leftFootPos,
                rightFootPos,
                cmdSpeed,
                impactSpeed,
                impactLoad,
                dt,
                probes.center
            );
            if (probes.center.surfaceType === 'solid') {
                pushContactEvent(
                    'solid_contact',
                    'both',
                    currPosition,
                    leftFootPos,
                    rightFootPos,
                    cmdSpeed,
                    impactSpeed,
                    impactLoad,
                    dt,
                    probes.center
                );
            }
        } else if (grounded && prevSurfaceType !== 'solid' && probes.center.surfaceType === 'solid') {
            pushContactEvent(
                'solid_contact',
                'both',
                currPosition,
                leftFootPos,
                rightFootPos,
                cmdSpeed,
                cmdSpeed * 0.35,
                weightForce,
                dt,
                probes.center
            );
        }
        prevSurfaceType = probes.center.surfaceType;

        const simWalkAmount = isSliding ? 0 : (command.walkAmount ?? walkAmount);
        const simWalkPhase = command.walkPhase ?? walkPhase;

        if (grounded && !isSliding && simWalkAmount > 0.12) {
            let phiL = simWalkPhase % (Math.PI * 2);
            while (phiL < 0) phiL += Math.PI * 2;
            let phiR = (simWalkPhase + Math.PI) % (Math.PI * 2);
            while (phiR < 0) phiR += Math.PI * 2;

            // В playerModel: phi in [0, PI) — мах (swing), phi in [PI, 2*PI) — опора (stance)
            const curLeftInStance = phiL >= Math.PI;
            const curRightInStance = phiR >= Math.PI;
            const strideLen = ((command.isSprinting ?? isSprinting) ? 0.35 : 0.28) * simWalkAmount;
            const stepLoad = weightForce * ((command.isSprinting ?? isSprinting) ? 1.35 : 1.0);

            if (!prevLeftInStance && curLeftInStance) {
                const tdLeftPos = leftFootPos.clone().addScaledVector(flatFwd, strideLen);
                const tdSample = sampleGround(tdLeftPos.x, tdLeftPos.z, createDefaultGroundSample(), true);
                tdLeftPos.y = tdSample.y;
                pushContactEvent(
                    'left_touchdown',
                    'left',
                    tdLeftPos,
                    tdLeftPos,
                    rightFootPos,
                    cmdSpeed,
                    cmdSpeed * 0.35,
                    stepLoad,
                    dt,
                    tdSample
                );
                if (tdSample.surfaceType === 'solid') {
                    pushContactEvent(
                        'solid_contact',
                        'left',
                        tdLeftPos,
                        tdLeftPos,
                        rightFootPos,
                        cmdSpeed,
                        cmdSpeed * 0.35,
                        stepLoad,
                        dt,
                        tdSample
                    );
                }
            }

            if (!prevRightInStance && curRightInStance) {
                const tdRightPos = rightFootPos.clone().addScaledVector(flatFwd, strideLen);
                const tdSample = sampleGround(tdRightPos.x, tdRightPos.z, createDefaultGroundSample(), true);
                tdRightPos.y = tdSample.y;
                pushContactEvent(
                    'right_touchdown',
                    'right',
                    tdRightPos,
                    leftFootPos,
                    tdRightPos,
                    cmdSpeed,
                    cmdSpeed * 0.35,
                    stepLoad,
                    dt,
                    tdSample
                );
                if (tdSample.surfaceType === 'solid') {
                    pushContactEvent(
                        'solid_contact',
                        'right',
                        tdRightPos,
                        leftFootPos,
                        tdRightPos,
                        cmdSpeed,
                        cmdSpeed * 0.35,
                        stepLoad,
                        dt,
                        tdSample
                    );
                }
            }

            prevLeftInStance = curLeftInStance;
            prevRightInStance = curRightInStance;
        } else if (grounded && isSliding) {
            if (probes.center.surfaceType !== 'solid') {
                pushContactEvent(
                    'slide',
                    'both',
                    currPosition,
                    leftFootPos,
                    rightFootPos,
                    slideSpeed,
                    0,
                    weightForce,
                    dt,
                    probes.center
                );
            }
            prevLeftInStance = true;
            prevRightInStance = true;
        } else {
            prevLeftInStance = grounded;
            prevRightInStance = grounded;
        }

        prevSimGrounded = grounded;

        const avgSink = (probes.leftFoot.sink + probes.rightFoot.sink) * 0.5;
        return {
            motion: {
                bodyPos: position.clone(),
                currentYaw: yaw,
                flatFwd: flatFwd.clone(),
                crouch,
                moveX: lastMoveX,
                moveZ: lastMoveZ,
                walkAmount: isSliding ? 0 : command.walkAmount,
                walkPhase: command.walkPhase,
                isSliding,
                slideSpeed: isSliding ? slideSpeed : 0,
                isSprinting: command.isSprinting ?? isSprinting,
                slopeAngle: currentSlopeAngle,
                uphillAngle: currentUphillAngle,
                downhillAngle: currentDownhillAngle,
                crossSlopeAngle: currentCrossSlopeAngle,
                forwardSpeed: currentForwardSpeed,
                forwardAccel: currentForwardAccel,
                movementLimitReason,
                ground: probes.center,
                probes
            },
            support: {
                plantedCount: grounded ? 2 : 0,
                supportedLoads: grounded ? 2 : 0,
                stability: grounded ? Math.max(0.2, Math.cos(currentSlopeAngle)) : 0,
                sink: grounded ? avgSink : 0,
                loadRatio: grounded ? 1 : 0,
                copValid: grounded
            }
        };
    }

    function getVisualState(alpha = 1.0): PlayerVisualState {
        const a = THREE.MathUtils.clamp(alpha, 0, 1);
        visualPosition.lerpVectors(prevPosition, currPosition, a);

        let yawDiff = currYaw - prevYaw;
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        visualYaw = prevYaw + yawDiff * a;

        return {
            position: visualPosition,
            yaw: visualYaw,
            crouch,
            moveX: lastMoveX,
            moveZ: lastMoveZ,
            walkAmount: (grounded || (verticalVelocity <= 0.5 && (currPosition.y - probes.center.y) < 0.12))
                ? (isSliding ? 0 : walkAmount)
                : 0,
            walkPhase,
            bankingRoll: smoothBanking,
            grounded,
            isSliding,
            slideSpeed: isSliding ? slideSpeed : 0,
            isSprinting,
            slopeAngle: currentSlopeAngle,
            uphillAngle: currentUphillAngle,
            downhillAngle: currentDownhillAngle,
            crossSlopeAngle: currentCrossSlopeAngle,
            forwardSpeed: currentForwardSpeed,
            forwardAccel: currentForwardAccel,
            movementLimitReason,
            ground: probes.center,
            probes
        };
    }

    function consumeContactEvents(): CosmoContactEvent[] {
        if (pendingContactEvents.length === 0) return [];
        return pendingContactEvents.splice(0, pendingContactEvents.length);
    }

    function peekContactEvents(): readonly CosmoContactEvent[] {
        return pendingContactEvents;
    }

    function setWaypoint(): void {}

    function reset(): void {
        crouch = 0;
        verticalVelocity = 0;
        isSliding = false;
        slideSpeed = 0;
        slideExitTimer = 0;
        isSteepSlopeBlocked = false;
        movementLimitReason = 'none';
        isSprinting = false;
        currentForwardSpeed = 0;
        currentForwardAccel = 0;
        pendingContactEvents.length = 0;
        if (playerRig) {
            playerRig.setFeetPosition(position.x, position.y, position.z);
        }
        prevPosition.copy(position);
        currPosition.copy(position);
        visualPosition.copy(position);
        prevYaw = yaw;
        currYaw = yaw;
        visualYaw = yaw;
        smoothBanking = 0;
        bankingRoll = 0;
        lastObstacleResistance = false;
        prevSimGrounded = grounded;
        prevLeftInStance = true;
        prevRightInStance = true;
    }

    function getPose(): { position: THREE.Vector3; currentYaw: number; flatFwd: THREE.Vector3 } {
        return { position, currentYaw: yaw, flatFwd };
    }

    function getVisualPose(alpha = 1.0): { position: THREE.Vector3; currentYaw: number; flatFwd: THREE.Vector3 } {
        const vs = getVisualState(alpha);
        visualFlatFwd.set(Math.sin(vs.yaw), 0, Math.cos(vs.yaw));
        return {
            position: vs.position,
            currentYaw: vs.yaw,
            flatFwd: visualFlatFwd
        };
    }

    function getDebug(): any {
        const leftModel = lastModelDebug?.leftFoot;
        const rightModel = lastModelDebug?.rightFoot;
        const weightForce = (config.mass ?? 85.0) * Math.abs(gravity);
        const leftWeight = leftModel?.contactWeight ?? (grounded ? (prevLeftInStance ? 1 : 0) : 0);
        const rightWeight = rightModel?.contactWeight ?? (grounded ? (prevRightInStance ? 1 : 0) : 0);

        return {
            actorType: 'cosmo',
            gaitPhase: walkPhase,
            walkAmount,
            grounded,
            isSliding,
            slideSpeed: isSliding ? slideSpeed : 0,
            isSprinting,
            slopeAngle: currentSlopeAngle,
            slopeAngleDeg: THREE.MathUtils.radToDeg(currentSlopeAngle),
            uphillAngle: currentUphillAngle,
            downhillAngle: currentDownhillAngle,
            crossSlopeAngle: currentCrossSlopeAngle,
            slopeDirection: { x: currentDownhillX, z: currentDownhillZ },
            surfaceType: probes.center.surfaceType,
            materialId: probes.center.materialId,
            packing: probes.center.packing,
            sink: probes.center.sink,
            friction: probes.center.friction,
            maxContactAngle: probes.center.maxContactAngle,
            movementLimitReason,
            eventCounts: { ...eventCounts },
            probes: {
                center: probes.center,
                leftFoot: probes.leftFoot,
                rightFoot: probes.rightFoot,
                ahead: probes.ahead,
                behind: probes.behind
            },
            feet: {
                left: {
                    groundY: leftModel?.groundY ?? probes.leftFoot.y,
                    normal: leftModel?.normal ?? probes.leftFoot.normal,
                    groundGap: leftModel?.groundGap ?? Math.max(0, (currPosition.y - probes.leftFoot.y)),
                    contactWeight: leftWeight,
                    state: leftWeight >= 0.5 ? 'stance' : 'swing',
                    foothold: leftModel?.foothold ?? { x: currPosition.x, y: probes.leftFoot.y, z: currPosition.z },
                    footholdSafe: leftModel?.footholdSafe ?? true,
                    surfaceType: leftModel?.surfaceType ?? probes.leftFoot.surfaceType,
                    materialId: leftModel?.materialId ?? probes.leftFoot.materialId
                },
                right: {
                    groundY: rightModel?.groundY ?? probes.rightFoot.y,
                    normal: rightModel?.normal ?? probes.rightFoot.normal,
                    groundGap: rightModel?.groundGap ?? Math.max(0, (currPosition.y - probes.rightFoot.y)),
                    contactWeight: rightWeight,
                    state: rightWeight >= 0.5 ? 'stance' : 'swing',
                    foothold: rightModel?.foothold ?? { x: currPosition.x, y: probes.rightFoot.y, z: currPosition.z },
                    footholdSafe: rightModel?.footholdSafe ?? true,
                    surfaceType: rightModel?.surfaceType ?? probes.rightFoot.surfaceType,
                    materialId: rightModel?.materialId ?? probes.rightFoot.materialId
                }
            },
            legs: [
                {
                    id: 'left',
                    contactWeight: leftWeight,
                    contactBlend: leftWeight,
                    normalLoad: leftWeight * weightForce * 0.5,
                    groundContact: probes.leftFoot
                },
                {
                    id: 'right',
                    contactWeight: rightWeight,
                    contactBlend: rightWeight,
                    normalLoad: rightWeight * weightForce * 0.5,
                    groundContact: probes.rightFoot
                }
            ],
            loop: {
                slope: Math.tan(currentSlopeAngle),
                slopeFactor: currentSlopeFactor,
                margin: grounded ? Math.max(0, probes.center.maxContactAngle - currentSlopeAngle) : 0,
                assist: grounded ? 1 : 0,
                slide: isSliding ? slideSpeed : 0,
                tipped: false
            },
            contact: {
                normal: grounded ? weightForce : 0,
                tangent: grounded ? cmdSpeedFromDebug() * (config.mass ?? 85.0) : 0,
                capacity: grounded ? weightForce * probes.center.friction : 0,
                saturation: grounded ? THREE.MathUtils.clamp(Math.tan(currentSlopeAngle) / Math.max(0.1, Math.tan(probes.center.maxContactAngle)), 0, 1) : 0,
                slip: isSliding ? slideSpeed : 0,
                grip: probes.center.friction
            }
        };
    }

    function cmdSpeedFromDebug(): number {
        return isSliding ? slideSpeed : currentForwardSpeed;
    }

    function dispose(): void {
        if (playerRig && !rig) {
            playerRig.dispose();
        }
    }

    return {
        rig: playerRig,
        update,
        simulateStep,
        consumeContactEvents,
        peekContactEvents,
        getProbes: () => probes,
        setModelDebug: (modelDebug: any) => { lastModelDebug = modelDebug; },
        setWaypoint,
        reset,
        getPose,
        getVisualPose,
        getVisualState,
        getDebug,
        getState: (alpha = 1.0) => getVisualState(alpha),
        dispose
    };
}
