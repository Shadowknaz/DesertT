import * as THREE from 'three';
import { COSMO } from '../config.ts';
import { createPlayerRig, type PlayerRig } from './playerRig.ts';

export type GroundQuery = ((x: number, z: number) => any) | null;

export interface PlayerControllerOptions {
    world?: any;
    rig?: PlayerRig | null;
    groundAt?: GroundQuery;
    speed?: number;
    runSpeed?: number;
    gravity?: number;
    spawnPosition?: THREE.Vector3;
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
}

export interface PlayerController {
    rig: PlayerRig | null;
    update(dt: number, ctx?: any): any;
    simulateStep(dt: number, command: any, weatherState?: any): { motion: PlayerControllerMotion; support: any };
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
export function createPlayerController({
    world = null,
    rig = null,
    groundAt = () => 0,
    speed = COSMO.speed,
    runSpeed = COSMO.runSpeed ?? (COSMO.speed * 1.9),
    gravity = COSMO.gravity,
    spawnPosition = new THREE.Vector3(0, 0, 0),
    config = COSMO
}: PlayerControllerOptions = {}): PlayerController {
    const playerRig = rig || (world ? createPlayerRig({ world, spawnPosition, config }) : null);

    function getGroundInfo(x: number, z: number): {
        y: number;
        normal: THREE.Vector3 | null;
        surfaceType: string;
        materialId: string;
        packing: number;
    } {
        if (typeof groundAt !== 'function') {
            return { y: 0, normal: null, surfaceType: 'sand', materialId: 'loose_sand', packing: 0 };
        }
        const sample = groundAt(x, z);
        if (typeof sample === 'number') {
            return { y: sample, normal: null, surfaceType: 'sand', materialId: 'loose_sand', packing: 0 };
        }
        if (sample && typeof sample.y === 'number') {
            return {
                y: sample.y,
                normal: sample.normal || null,
                surfaceType: sample.surfaceType || 'sand',
                materialId: sample.materialId || 'loose_sand',
                packing: sample.packing ?? 0
            };
        }
        return { y: 0, normal: null, surfaceType: 'sand', materialId: 'loose_sand', packing: 0 };
    }

    let initialY = spawnPosition.y;
    if (!playerRig) {
        const initialGroundY = getGroundInfo(spawnPosition.x, spawnPosition.z).y;
        initialY = initialGroundY + Math.max(0, spawnPosition.y);
    }
    const position = new THREE.Vector3(spawnPosition.x, initialY, spawnPosition.z);

    const prevPosition = position.clone();
    const currPosition = position.clone();
    const visualPosition = position.clone();

    const flatFwd = new THREE.Vector3(0, 0, 1);
    let yaw = 0;
    let prevYaw = 0;
    let currYaw = 0;
    let visualYaw = 0;

    let crouch = 0;
    let verticalVelocity = 0;
    let grounded = spawnPosition.y <= 0.02;
    let walkPhase = 0;
    let walkAmount = 0;
    let lastMoveX = 0;
    let lastMoveZ = 0;
    let lastObstacleResistance = false;

    let bankingRoll = 0;
    let smoothBanking = 0;

    // Состояние песчаного серфинга (Sand Sliding) и склонов
    let isSliding = false;
    let slideSpeed = 0;
    let isSprinting = false;
    let currentSlopeAngle = 0;
    const slideMinAngle = config.slideMinAngle ?? (22 * Math.PI / 180);
    const slideMaxSpeed = config.slideMaxSpeed ?? 7.2;

    function update(dt: number, ctx: any = {}): any {
        const actions = ctx.actions || {};
        const moveX = (actions.right ? 1 : 0) - (actions.left ? 1 : 0);
        const moveZ = (actions.forward ? 1 : 0) - (actions.backward ? 1 : 0);
        crouch = actions.crouchDown ? 1 : (actions.crouchUp ? 0 : crouch);

        let localX = moveX;
        let localZ = moveZ;
        let worldX = 0;
        let worldZ = 0;
        let inputLength = Math.hypot(localX, localZ);

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

        // --- Анализ ландшафта под персонажем и по направлению движения ---
        const groundInfo = getGroundInfo(currPosition.x, currPosition.z);
        let downhillX = 0;
        let downhillZ = 0;
        let terrainSlopeAngle = 0;

        if (groundInfo.normal && typeof groundInfo.normal.x === 'number') {
            const nx = groundInfo.normal.x;
            const ny = Math.max(0.01, groundInfo.normal.y);
            const nz = groundInfo.normal.z;
            const horizLen = Math.hypot(nx, nz);
            terrainSlopeAngle = Math.atan2(horizLen, ny);
            if (horizLen > 1e-4) {
                downhillX = nx / horizLen;
                downhillZ = nz / horizLen;
            }
        } else {
            // Аналитическая оценка уклона через сэмплинг креста
            const sXP = getGroundInfo(currPosition.x + 0.35, currPosition.z).y;
            const sXN = getGroundInfo(currPosition.x - 0.35, currPosition.z).y;
            const sZP = getGroundInfo(currPosition.x, currPosition.z + 0.35).y;
            const sZN = getGroundInfo(currPosition.x, currPosition.z - 0.35).y;
            const gradX = (sXP - sXN) / 0.7;
            const gradZ = (sZP - sZN) / 0.7;
            const gradLen = Math.hypot(gradX, gradZ);
            terrainSlopeAngle = Math.atan(gradLen);
            if (gradLen > 1e-4) {
                downhillX = -gradX / gradLen;
                downhillZ = -gradZ / gradLen;
            }
        }
        currentSlopeAngle = terrainSlopeAngle;

        // Оценка продольного уклона вдоль вектора движения
        let moveSlopeAngle = 0;
        if (inputLength > 0.01) {
            const aheadY = getGroundInfo(currPosition.x + worldX * 0.4, currPosition.z + worldZ * 0.4).y;
            const deltaY = aheadY - groundInfo.y;
            moveSlopeAngle = Math.atan2(deltaY, 0.4);
        }

        // --- Модификатор скорости по типу грунта ---
        let matMultiplier = 1.0;
        if (groundInfo.materialId === 'loose_sand') {
            matMultiplier = 0.90; // сопротивление качению в сыпучем песке
        } else if (groundInfo.materialId === 'compacted_sand') {
            matMultiplier = 0.98;
        } else if (groundInfo.materialId === 'stone' || groundInfo.materialId === 'bedrock') {
            matMultiplier = 1.05; // твердое сцепление со скалой
        }

        // --- Проверка условий песчаного серфинга (Sand Sliding) ---
        const onSand = groundInfo.surfaceType === 'sand';
        const isSteepDune = terrainSlopeAngle >= slideMinAngle;
        const wantsCrouch = crouch === 1;

        if (grounded && onSand && wantsCrouch && isSteepDune) {
            const dotDown = worldX * downhillX + worldZ * downhillZ;
            // Входим в скольжение, если уже скользим, либо стоим/движемся вниз по дюне
            if (isSliding || inputLength < 0.05 || dotDown > -0.2) {
                isSliding = true;
            }
        } else if (isSliding) {
            // Выход из скольжения при выполаживании склона, потере опоры или отпускании приседания
            if (!grounded || !onSand || !wantsCrouch || terrainSlopeAngle < (14 * Math.PI / 180)) {
                if (slideSpeed <= speed * 1.1) {
                    isSliding = false;
                    slideSpeed = 0;
                } else {
                    // Плавное торможение песком перед полным вставанием на ноги
                    slideSpeed = Math.max(0, slideSpeed - 9.0 * dt);
                    if (slideSpeed <= speed) {
                        isSliding = false;
                        slideSpeed = 0;
                    }
                }
            }
        }

        isSprinting = Boolean((actions.sprint || actions.run) && crouch === 0);
        const sprintTargetSpeed = runSpeed ?? config.runSpeed ?? config.sprintSpeed ?? (speed * 1.9);
        const currentBaseSpeed = isSprinting ? sprintTargetSpeed : speed;
        let effectiveSpeed = currentBaseSpeed * matMultiplier;

        if (isSliding) {
            // === РЕЖИМ ПЕСЧАНОГО СЕРФИНГА ===
            // Ускорение под действием гравитации на склоне за вычетом трения песка
            const aGravityDown = 18.0 * (Math.sin(terrainSlopeAngle) - 0.38 * Math.cos(terrainSlopeAngle));
            slideSpeed = THREE.MathUtils.clamp(
                (slideSpeed || (speed * 1.3)) + aGravityDown * dt,
                speed * 0.8,
                slideMaxSpeed
            );
            effectiveSpeed = slideSpeed;

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
            // === ОБЫЧНЫЙ БЕГ / ХОДЬБА С МОДУЛЯЦИЕЙ ПО УКЛОНУ ===
            if (moveSlopeAngle > 0.01) {
                // Подъем в гору: замедление до 55% от базовой скорости при уклоне 45°
                const sinSlope = Math.sin(moveSlopeAngle);
                const climbRatio = THREE.MathUtils.clamp(sinSlope / Math.sin(45 * Math.PI / 180), 0, 1);
                const slopeFactor = 1.0 - 0.45 * climbRatio;
                effectiveSpeed *= slopeFactor;
            } else if (moveSlopeAngle < -0.01) {
                // Спуск под гору: контролируемое ускорение до 135% от базовой скорости
                const sinDescent = -Math.sin(moveSlopeAngle);
                const descentRatio = THREE.MathUtils.clamp(sinDescent / Math.sin(30 * Math.PI / 180), 0, 1);
                const slopeFactor = 1.0 + 0.35 * descentRatio;
                effectiveSpeed *= slopeFactor;
            }

            let targetWalk = Math.min(1, inputLength);
            if (lastObstacleResistance) {
                targetWalk *= 0.15; // замедление шага при упоре в препятствие
            }
            const rampRate = targetWalk > walkAmount ? 8.0 : 10.0;
            walkAmount += THREE.MathUtils.clamp((targetWalk - walkAmount) * dt * rampRate, -1, 1);
            if (targetWalk === 0 && walkAmount < 0.01) walkAmount = 0;
            // Синхронизация частоты шага с фактической скоростью (атлетичный, естественный темп без дергания)
            const cadenceMultiplier = isSprinting ? 2.1 : 2.6;
            walkPhase += walkAmount * effectiveSpeed * dt * cadenceMultiplier;
        }

        // Прыжок Cosmo (поддерживается и во время скольжения, выталкивая вверх)
        if (grounded && (actions.jump || (actions.crouchUp && !crouch && actions.isJumpIntent))) {
            verticalVelocity = config.jumpSpeed ?? 4.5;
            grounded = false;
            if (isSliding) {
                isSliding = false;
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
            moveSlopeAngle
        };
    }

    function simulateStep(dt: number, command: any, _weatherState?: any): { motion: PlayerControllerMotion; support: any } {
        prevPosition.copy(currPosition);
        prevYaw = currYaw;

        if (playerRig) {
            // === РЕЖИМ 1: Rapier 3D Kinematic Character Controller ===
            const horizX = command.worldX * command.speed * dt;
            const horizZ = command.worldZ * command.speed * dt;

            // Гравитация и вертикальное смещение
            verticalVelocity += gravity * dt;
            if (verticalVelocity < -28.0) verticalVelocity = -28.0;

            const vertY = verticalVelocity * dt;
            const desiredTranslation = { x: horizX, y: vertY, z: horizZ };

            const { movement, grounded: kccGrounded } = playerRig.computeMovement(desiredTranslation);
            playerRig.applyMovement(movement);

            const feet = playerRig.getFeetPosition();
            currPosition.set(feet.x, feet.y, feet.z);

            grounded = kccGrounded;
            if (grounded && verticalVelocity < 0) {
                verticalVelocity = 0;
            }

            // Определение упора в препятствие (velocity feedback)
            const requestedDist = Math.hypot(horizX, horizZ);
            if (requestedDist > 1e-4) {
                const actualDist = Math.hypot(movement.x, movement.z);
                lastObstacleResistance = (actualDist / requestedDist) < 0.2;
            } else {
                lastObstacleResistance = false;
            }
        } else {
            // === РЕЖИМ 2: Аналитический Fallback для легковесных тестов ===
            currPosition.x += command.worldX * command.speed * dt;
            currPosition.z += command.worldZ * command.speed * dt;

            const groundY = groundAt ? groundAt(currPosition.x, currPosition.z) : 0;

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
                slopeAngle: currentSlopeAngle
            },
            support: {
                plantedCount: grounded ? 2 : 0,
                supportedLoads: grounded ? 2 : 0,
                stability: grounded ? 1 : 0,
                sink: 0,
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
        while (yawDiff < -Math.PI) yawDiff -= Math.PI * 2;
        visualYaw = prevYaw + yawDiff * a;

        return {
            position: visualPosition,
            yaw: visualYaw,
            crouch,
            moveX: lastMoveX,
            moveZ: lastMoveZ,
            walkAmount: grounded ? (isSliding ? 0 : walkAmount) : 0,
            walkPhase,
            bankingRoll: smoothBanking,
            grounded,
            isSliding,
            slideSpeed: isSliding ? slideSpeed : 0,
            isSprinting,
            slopeAngle: currentSlopeAngle
        };
    }

    function setWaypoint(): void {}

    function reset(): void {
        crouch = 0;
        verticalVelocity = 0;
        isSliding = false;
        slideSpeed = 0;
        isSprinting = false;
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
    }

    function getPose(): { position: THREE.Vector3; currentYaw: number; flatFwd: THREE.Vector3 } {
        return { position, currentYaw: yaw, flatFwd };
    }

    function getVisualPose(alpha = 1.0): { position: THREE.Vector3; currentYaw: number; flatFwd: THREE.Vector3 } {
        const vs = getVisualState(alpha);
        return {
            position: vs.position,
            currentYaw: vs.yaw,
            flatFwd: new THREE.Vector3(Math.sin(vs.yaw), 0, Math.cos(vs.yaw))
        };
    }

    function getDebug(): any {
        return {
            legs: [],
            loop: {
                slope: 0,
                slopeFactor: 1,
                margin: grounded ? 1 : 0,
                assist: grounded ? 1 : 0,
                slide: 0,
                tipped: false
            },
            contact: {}
        };
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
