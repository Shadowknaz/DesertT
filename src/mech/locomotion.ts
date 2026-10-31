// Локомоция корпуса шестиногого шагохода: намерение превращается в
// горизонтальную силу привода, момент курса и момент выравнивания.
//
// Скорость корпуса больше не задается напрямую: ее набирают силовые контакты
// стоящих лап. Рыхлый песок, уклон и потеря опоры действительно влияют на ход,
// а на ребре полигона опоры гидравлика уже не спасает от опрокидывания.
//
// Реактивный прыжок — отдельная ветка: сопла дают разовый вертикальный
// импульс, в полете работают только на выравнивание, а на посадке корпус
// принимают уже выпущенные к песку стойки.
import * as THREE from 'three';
import { HEXAPOD, MECH, PHYSICS, SANDFIELD, WEATHER } from '../config.ts';
import { getDuneHeight } from '../core/duneField.ts';
import { slopesInHeading, type FootSupportResult } from './legSupport.ts';
import type { WeatherState } from '../world/weather.ts';

// Пробы под корпусом для посадки: центр и четыре угла. Корпус
// останавливается самой высокой точкой, а не центром: на косогоре
// угол может встретить склон заметно раньше.
const HULL_PROBES = [
    [0.0, 0.0],
    [HEXAPOD.hullHalfX, HEXAPOD.hullHalfZ],
    [HEXAPOD.hullHalfX, -HEXAPOD.hullHalfZ],
    [-HEXAPOD.hullHalfX, HEXAPOD.hullHalfZ],
    [-HEXAPOD.hullHalfX, -HEXAPOD.hullHalfZ]
];

export interface LocomotionBodyState {
    bodyPos: THREE.Vector3;
    bodyCom: THREE.Vector3;
    bodyQuat: THREE.Quaternion;
    bodyVel: THREE.Vector3;
    bodyAngVel: THREE.Vector3;
    currentYaw: number;
    flatFwd: THREE.Vector3;
    flatRight: THREE.Vector3;
}

export interface LocomotionDebug {
    drive: number;        // приводное ускорение, м/с^2
    assist: number;       // доля бюджета выравнивания
    slide: number;        // сползание вниз по склону, м/с
    sink: number;         // средняя просадка лап, м
    grip: number;         // запас опоры под центром масс
    margin: number;       // запас опоры с поправкой на разгон, м
    slope: number;        // крутизна опорной плоскости (тангенс)
    tipped: boolean;
}

export interface LocomotionOptions {
    body: any;
    groundAt?: ((x: number, z: number) => number) | null;
}

export interface LocomotionController {
    readBodyState(): LocomotionBodyState;
    plan(dt: number, support: FootSupportResult, command: any, state: LocomotionBodyState, weather?: WeatherState | null): any;
    finalize(support: FootSupportResult, motion: any, weather?: WeatherState | null): any;
    update(dt: number, support: FootSupportResult, command: any, state: LocomotionBodyState, weather?: WeatherState | null): any;
    registerStepImpact(): void;
    registerStompImpact(): void;
    getDebug(): LocomotionDebug;
}

export type Locomotion = LocomotionController;

export function createLocomotion({ body, groundAt = null }: LocomotionOptions): LocomotionController {
    let tipTimer = 0.0;

    // Привод прошлого подшага: по нему считается только прирост тяги.
    // Установившийся момент уже отражен центром давления через просадку
    // стоек, и повторно учитывать его нельзя.
    let lastDriveX = 0.0;
    let lastDriveZ = 0.0;
    // Запас опоры прошлого финализированного подшага: его читает походка,
    // пока свежие силы еще не решены.
    let lastMargin = 1.0;

    // Состояние реактивного прыжка: пока корпус в воздухе, привод и
    // контакты лап выключены, а походка поджимает стойки.
    let airborne = false;
    let jumpCooldown = 0.0;
    let jumpHeldPrev = false;
    let landingTimer = 0.0;

    // Диагностика последнего подшага: её читает HUD и отладочная панель
    const debug: LocomotionDebug = {
        drive: 0.0,        // приводное ускорение, м/с^2
        assist: 1.0,       // доля бюджета выравнивания
        slide: 0.0,        // сползание вниз по склону, м/с
        sink: 0.0,         // средняя просадка лап, м
        grip: 1.0,         // запас опоры под центром масс
        margin: 0.0,       // запас опоры с поправкой на разгон, м
        slope: 0.0,        // крутизна опорной плоскости (тангенс)
        tipped: false
    };

    // Крутизна опорной плоскости в три зоны: обычная ходьба, осторожный шаг
    // и отказ от шага. Выше последней границы мех уже не ходит, а сползает.
    function slopeSpeedFactor(slope: number): number {
        if (!(slope > MECH.slopeWalkMax)) return 1.0;
        if (slope <= MECH.slopeCrawlMax) {
            const t = (slope - MECH.slopeWalkMax) / (MECH.slopeCrawlMax - MECH.slopeWalkMax);
            return THREE.MathUtils.lerp(1.0, MECH.slopeCrawlSpeed, t);
        }
        if (slope <= MECH.slopeLimit) {
            const t = (slope - MECH.slopeCrawlMax) / (MECH.slopeLimit - MECH.slopeCrawlMax);
            return THREE.MathUtils.lerp(MECH.slopeCrawlSpeed, MECH.slopeMinSpeed, t);
        }
        return 0.0;
    }

    // Черновики ориентации: регулятор пересобирает целевой кватернион каждый шаг
    const scratchEuler = new THREE.Euler();
    const targetQuat = new THREE.Quaternion();
    const inverseQuat = new THREE.Quaternion();
    const quatError = new THREE.Quaternion();
    const forwardTemp = new THREE.Vector3();
    const upTemp = new THREE.Vector3();
    const uphill = new THREE.Vector3();

    // Снимок физического состояния на начало подшага (до world.step).
    // Позиция и ориентиры возвращаются новыми объектами — их держат
    // потребители фаз, поэтому здесь аллокации оправданы.
    function readBodyState(): LocomotionBodyState {
        const t = body.translation();
        const com = body.worldCom();
        const r = body.rotation();
        const linVel = body.linvel();
        const angVel = body.angvel();

        // Rapier translation is the pose origin; linvel is world CoM velocity.
        const bodyCom = new THREE.Vector3(com.x, com.y, com.z);
        const bodyPos = new THREE.Vector3(t.x, t.y, t.z);
        const bodyQuat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        const bodyVel = new THREE.Vector3(linVel.x, linVel.y, linVel.z);
        const bodyAngVel = new THREE.Vector3(angVel.x, angVel.y, angVel.z);

        // Извлекаем чистый угол курса (Yaw) без паразитного крена
        forwardTemp.set(0, 0, 1).applyQuaternion(bodyQuat);
        const currentYaw = Math.atan2(forwardTemp.x, forwardTemp.z);
        const flatFwd = new THREE.Vector3(Math.sin(currentYaw), 0, Math.cos(currentYaw));
        const flatRight = new THREE.Vector3(Math.cos(currentYaw), 0, -Math.sin(currentYaw));

        return { bodyPos, bodyCom, bodyQuat, bodyVel, bodyAngVel, currentYaw, flatFwd, flatRight };
    }

    // Высота поверхности под центром корпуса. Пробник грунта знает поле
    // песка и воронки, поэтому просадка и перенос песка видны восстановлению
    // и посадке сразу, а не только по аналитическому рельефу.
    function groundHeightAt(x: number, z: number): number {
        return groundAt ? groundAt(x, z) : getDuneHeight(x, z);
    }

    // command: { throttle, turnInput, desiredYawRate, yawError, isManual, stompHeld, jumpHeld }
    // support: { supportY, pitchSlope, rollSlope, slope, normal, tippingMargin,
    //            edgeDirX, edgeDirZ, plantedCount, sink } — геометрическая опора
    // weather: снимок погоды { windX, windZ, windSpeed, speedMultiplier }
    //
    // Первая фаза подшага: намерение → привод и целевые скорости. Опорные
    // силы здесь не решаются: они считаются один раз после похода, когда
    // стопы уже стоят на своих местах. Моменты выравнивания и запас опоры
    // считает finalize() по тому же решению, которое применяют контакты.
    function plan(
        dt: number,
        support: FootSupportResult,
        command: any,
        state: LocomotionBodyState,
        weather: WeatherState | null = null
    ): any {
        const { bodyPos, bodyQuat, bodyVel, bodyAngVel, currentYaw, flatFwd } = state;

        // Высота песка под центром корпуса: нужна для подъема лежащего меха,
        // когда опора под ним уже не плоскость.
        const centerGround = groundHeightAt(bodyPos.x, bodyPos.z);
        const effectiveGroundY = Math.max(support.supportY, centerGround - 0.15);

        // Лежит ли мех на боку: корпус больше не держится за вертикаль,
        // и после падения привод и выравнивание выключаются.
        upTemp.set(0, 1, 0).applyQuaternion(bodyQuat);
        const tipped = upTemp.y < MECH.tipUpThreshold;

        // --- Реактивный прыжок -------------------------------------------
        // Shift — разовый импульс сопел сжатого воздуха. Оттолкнуться можно
        // только с надежной опоры: нужны минимум три стоящие лапы и ровный
        // корпус, иначе сопла сработают в никуда.
        jumpCooldown = Math.max(0.0, jumpCooldown - dt);
        const jumpPressed = command.jumpHeld === true && !jumpHeldPrev;
        jumpHeldPrev = command.jumpHeld === true;

        let launched = false;
        let landed = false;

        if (!airborne && !tipped && jumpPressed && jumpCooldown <= 0.0
            && support.plantedCount >= MECH.jumpMinLegs) {
            body.applyImpulse({ x: 0.0, y: MECH.jumpImpulse, z: 0.0 }, true);
            airborne = true;
            launched = true;
            lastDriveX = 0.0;
            lastDriveZ = 0.0;
        }

        // --- Полет --------------------------------------------------------
        // Привод и гидравлика лап в воздухе молчат: горизонтальный импульс
        // сохраняется, поэтому прыжок на ходу перелетает препятствие,
        // а сопла только выравнивают корпус.
        if (airborne) {
            applyAirAttitude(dt, state);

            // Касание — по высоте корпуса над аналитическим рельефом:
            // поле песка смещает поверхность не больше чем на maxDelta,
            // а походка на посадке заново ставит стопы по лучу.
            // На кадре отрыва снимок тела еще покоящийся, поэтому
            // касание там не проверяется: иначе прыжок заканчивается
            // в том же подшаге, где начался.
            // Касание — только когда и корпус опустился до песка, и стопы
            // уже выпущены к поверхности. Высота корпуса берется по самой
            // высокой точке под его пятном: та же поверхность, по которой
            // считаются зазоры стоп, только по своему x/z.
            const feetReady = support.nearGroundCount === undefined
                || support.nearGroundCount >= MECH.jumpMinLegs;
            const cosYaw = Math.cos(currentYaw);
            const sinYaw = Math.sin(currentYaw);
            let hullGround = centerGround;
            for (let i = 0; i < HULL_PROBES.length; i++) {
                const probe = HULL_PROBES[i];
                const wx = bodyPos.x + probe[0] * cosYaw + probe[1] * sinYaw;
                const wz = bodyPos.z - probe[0] * sinYaw + probe[1] * cosYaw;
                const gy = groundHeightAt(wx, wz);
                if (gy > hullGround) hullGround = gy;
            }
            const groundGap = bodyPos.y - MECH.rideHeight - hullGround;
            if (!launched && bodyVel.y < 0.0 && groundGap <= MECH.jumpLandTolerance
                && feetReady) {
                airborne = false;
                landed = true;
                jumpCooldown = MECH.jumpCooldown;
                landingTimer = MECH.landingAbsorbTime;
                lastDriveX = 0.0;
                lastDriveZ = 0.0;
            } else {
                debug.drive = 0.0;
                debug.assist = 0.0;
                debug.slide = 0.0;
                debug.sink = 0.0;
                debug.grip = 0.0;
                debug.margin = 0.0;
                debug.slope = 0.0;
                debug.tipped = false;

                return {
                    ...state, ...command,
                    bodyPos, bodyQuat, bodyVel, bodyAngVel,
                    signedWalkSpeed: 0.0,
                    desiredVelX: 0.0,
                    desiredVelZ: 0.0,
                    desiredYawRate: 0.0,
                    driveForceX: 0.0,
                    driveForceZ: 0.0,
                    attitudeTorqueX: 0.0,
                    attitudeTorqueZ: 0.0,
                    yawTorque: 0.0,
                    tippingMargin: 0.0,
                    plantedCount: 0,
                    slope: 0.0,
                    slopeFactor: 0.0,
                    recovery: false,
                    airborne: true,
                    launched,
                    landed: false,
                    landingGear: false
                };
            }
        }

        // Амортизаторы после посадки короткое время держат удар выше
        // обычного предела опоры — иначе корпус проваливается на метр
        // с лишним и пружины выбрасывают его обратно.
        landingTimer = Math.max(0.0, landingTimer - dt);

        // Скорость шага замедляется при крутом развороте, в бурю, на
        // глубокой просадке и на крутом склоне: лапы вязнут в собственной
        // колее, а на предельном уклоне шаг вообще бессмысленен.
        const turnSlowdown = command.isManual
            ? (1.0 - Math.abs(command.turnInput) * 0.2)
            : THREE.MathUtils.clamp(1.0 - Math.abs(command.yawError) * 0.55, 0.35, 1.0);
        const maxSpeed = command.throttle < 0 ? MECH.maxReverseSpeed : MECH.maxForwardSpeed;
        const slopeFactor = slopeSpeedFactor(support.slope);
        let signedWalkSpeed = command.throttle * maxSpeed * turnSlowdown * slopeFactor;

        if (weather) signedWalkSpeed *= weather.speedMultiplier;

        const sinkDrag = 1.0 - Math.min(0.45, support.sink * SANDFIELD.sinkDrag);
        signedWalkSpeed *= sinkDrag;

        // Разворот на крутом склоне тоже урезается: иначе мех закручивается
        // вокруг вертикали и выносит центр масс за ребро опоры.
        const yawRate = command.desiredYawRate * slopeFactor;

        // Мир бесконечен: границ у меха нет, чанки подгружаются вокруг него
        let desiredVelX = flatFwd.x * signedWalkSpeed;
        let desiredVelZ = flatFwd.z * signedWalkSpeed;

        // Порывы ветра сносят корпус в сторону; наклон по потоку добавит
        // finalize(), когда будет известна свежая нормаль опоры.
        if (weather && weather.windSpeed > 0.5) {
            const inv = 1.0 / Math.max(0.001, Math.hypot(weather.windX, weather.windZ));
            const wx = weather.windX * inv;
            const wz = weather.windZ * inv;

            // Стоящий мех упирается в ветер, идущий — сильнее сносит
            const brace = MECH.braceBase + (1.0 - MECH.braceBase) * Math.abs(command.throttle);
            const drift = weather.windSpeed * WEATHER.windDrift * brace;
            desiredVelX += wx * drift;
            desiredVelZ += wz * drift;
        }

        // --- Привод -------------------------------------------------------
        // Гравитация тянет корпус вниз по склону, и удерживать его должны
        // стойки. Без явной компенсации P-регулятор держит только с ошибкой
        // скорости: чтобы выдать 800 Н, ему нужно ~0.8 м/с расхождения, то
        // есть мех медленно сползает даже без команды. Компенсация снимает
        // это с регулятора, а пределом остается эллипс сцепления.
        //
        // Направление подъема — горизонтальная проекция нормали со знаком
        // минус: сама нормаль смотрит вниз по склону (прочь от вершины), и
        // без минуса удержание работало бы в сторону падения.
        uphill.set(-support.normal.x, 0.0, -support.normal.z).normalize();

        // Контактный слой проецирует привод на плоскость стопы: чтобы после
        // проекции осталась скатывающая сила mg·sinθ, горизонтальный вектор
        // задается длиннее в 1/cosθ, то есть mg·tanθ. Иначе мех недодерживает
        // склон ровно на cosθ и медленно сползает.
        const holdForce = MECH.mass * Math.abs(PHYSICS.gravity) * support.slope;

        const maxForce = MECH.mass * MECH.driveAccelLimit;

        // Combine compensation and velocity control BEFORE the one engine
        // clamp. Opposing demands can cancel; holding has no reserved budget.
        // Contacts apply a separate tangent-plane friction limit afterward.
        const velocityGain = MECH.velGainGround;
        const demandX = uphill.x * holdForce + MECH.mass * velocityGain * (desiredVelX - bodyVel.x);
        const demandZ = uphill.z * holdForce + MECH.mass * velocityGain * (desiredVelZ - bodyVel.z);
        const demandMagnitude = Math.hypot(demandX, demandZ);
        const driveScale = demandMagnitude > maxForce ? maxForce / demandMagnitude : 1;
        const driveX = demandX * driveScale;
        const driveZ = demandZ * driveScale;

        // Спасение лежащего меха: лебедка поднимает корпус с прежним курсом,
        // иначе демо навсегда остается с опрокинутой машиной.
        if (tipped) tipTimer += dt; else tipTimer = 0.0;

        let recovered = false;
        if (tipTimer >= MECH.tipRecoverDelay) {
            tipTimer = 0.0;
            recovered = true;

            // Ставим корпус ровно по курсу и на высоту опоры: стойки
            // вертикальны, поэтому наклонный корпус на склоне сжал бы
            // подвес на метр. Подъем берется от плоскости опоры, а не от
            // аналитического рельефа, чтобы не промахнуться на седловине.
            const liftY = effectiveGroundY + MECH.rideHeight + 0.4;
            const upY = Math.sin(currentYaw * 0.5);
            const upW = Math.cos(currentYaw * 0.5);

            body.setTranslation({ x: bodyPos.x, y: liftY, z: bodyPos.z }, true);
            body.setRotation({ x: 0.0, y: upY, z: 0.0, w: upW }, true);
            body.setLinvel({ x: 0.0, y: 0.0, z: 0.0 }, true);
            body.setAngvel({ x: 0.0, y: 0.0, z: 0.0 }, true);

            // Снимок кадра тоже должен стать новым: походка ставит лапы по
            // motion.bodyQuat, и со старым (лежащим) кватернионом стопы
            // уезжали в стороны, а IK дергался.
            bodyPos.y = liftY;
            bodyQuat.set(0.0, upY, 0.0, upW);
            if (state.bodyCom) state.bodyCom.copy(body.worldCom());
            bodyVel.set(0.0, 0.0, 0.0);
            bodyAngVel.set(0.0, 0.0, 0.0);

            // После переноса прежний привод и запас опоры уже не описывают
            // новую стойку: первый подшаг не должен получить скачок deltaShift.
            lastDriveX = 0.0;
            lastDriveZ = 0.0;
            lastMargin = Math.max(MECH.assistMargin, support.tippingMargin);
        }

        debug.drive = Math.hypot(driveX, driveZ) / MECH.mass;
        debug.slide = Math.max(0.0, -(bodyVel.x * uphill.x + bodyVel.z * uphill.z));
        debug.sink = support.sink;
        debug.grip = support.stability;
        debug.slope = support.slope;
        debug.tipped = tipped;

        // Запас опоры здесь — прошлый финализированный: походке он нужен
        // для решения о переступании, а свежий появится после нее.
        return {
            ...state, ...command,
            bodyPos, bodyQuat, bodyVel, bodyAngVel,
            signedWalkSpeed, desiredVelX, desiredVelZ, velocityGain,
            desiredYawRate: yawRate,
            driveForceX: tipped ? 0.0 : driveX,
            driveForceZ: tipped ? 0.0 : driveZ,
            attitudeTorqueX: 0.0,
            attitudeTorqueZ: 0.0,
            yawTorque: 0.0,
            tippingMargin: lastMargin,
            plantedCount: support.plantedCount,
            slope: support.slope,
            slopeFactor,
            recovery: recovered,
            airborne: false,
            launched: false,
            landed,
            landingGear: landingTimer > 0.0
        };
    }

    // Вторая фаза подшага. Опора здесь — та же, по которой контактный слой
    // прикладывает силы: запас, бюджет выравнивания и моменты считаются по
    // одному решению, без второй версии нагрузок.
    function finalize(support: FootSupportResult, motion: any, weather: WeatherState | null = null): any {
        if (motion.airborne) return motion;

        const { bodyPos, bodyQuat, bodyAngVel, currentYaw, flatFwd, flatRight } = motion;

        // Целевая ориентация по свежей нормали опоры: мировые уклоны
        // пересчитываются в систему курса, иначе после разворота наклон
        // применяется вокруг неверной оси.
        const localSlopes = slopesInHeading(support.normal, currentYaw);
        let targetPitch = -localSlopes.pitchSlope * MECH.pitchSlopeGain;
        let targetRoll = localSlopes.rollSlope * MECH.rollSlopeGain;

        // Порывы ветра наклоняют корпус по потоку
        if (weather && weather.windSpeed > 0.5) {
            const inv = 1.0 / Math.max(0.001, Math.hypot(weather.windX, weather.windZ));
            const wx = weather.windX * inv;
            const wz = weather.windZ * inv;
            const windRight = wx * flatRight.x + wz * flatRight.z;
            const windForward = wx * flatFwd.x + wz * flatFwd.z;
            targetRoll -= THREE.MathUtils.clamp(
                windRight * weather.windSpeed * WEATHER.windLean, -0.18, 0.18
            );
            targetPitch += THREE.MathUtils.clamp(
                windForward * weather.windSpeed * WEATHER.windLean * 0.6, -0.12, 0.12
            );
        }

        // Запас опоры: геометрия + фактический центр давления + прирост
        // приводной силы. Установившийся момент уже виден в CoP через
        // просадку стоек, поэтому полный привод добавляется только когда
        // центра давления нет.
        const edgeDirX = support.edgeDirX || 0.0;
        const edgeDirZ = support.edgeDirZ || 0.0;
        const driveX = motion.driveForceX;
        const driveZ = motion.driveForceZ;
        const shiftScale = MECH.comHeight / (MECH.mass * Math.abs(PHYSICS.gravity));
        const fullShift = THREE.MathUtils.clamp(
            (driveX * edgeDirX + driveZ * edgeDirZ) * shiftScale, -1.2, 1.2
        );
        const deltaShift = THREE.MathUtils.clamp(
            ((driveX - lastDriveX) * edgeDirX + (driveZ - lastDriveZ) * edgeDirZ) * shiftScale,
            -0.6, 0.6
        );
        const bodyCom = motion.bodyCom || bodyPos;
        const copShift = support.copValid
            ? (support.copX - bodyCom.x) * edgeDirX
                + (support.copZ - bodyCom.z) * edgeDirZ
            : 0.0;
        const tippingMargin = support.tippingMargin
            + (support.copValid ? -copShift + deltaShift : fullShift);

        scratchEuler.set(targetPitch, currentYaw, targetRoll, 'YXZ');
        targetQuat.setFromEuler(scratchEuler);
        inverseQuat.copy(bodyQuat).invert();
        quatError.copy(targetQuat).multiply(inverseQuat);
        if (quatError.w < 0.0) {
            quatError.x = -quatError.x;
            quatError.y = -quatError.y;
            quatError.z = -quatError.z;
            quatError.w = -quatError.w;
        }

        upTemp.set(0, 1, 0).applyQuaternion(bodyQuat);
        const tipped = upTemp.y < MECH.tipUpThreshold;

        // Бюджет выравнивания режется у ребра опоры. Загрузка стоек
        // остается диагностикой: кратковременная разгрузка после отскока
        // не должна выключать гидравлику, иначе корпус раскачивается.
        const assist = tipped ? 0.0 : THREE.MathUtils.clamp(
            support.tippingMargin / MECH.assistMargin,
            MECH.assistFloor,
            1.0
        );
        const torqueLimit = MECH.attitudeTorque * assist;

        const attitudeTorqueX = THREE.MathUtils.clamp(
            MECH.inertiaPitch * (MECH.attitudeKp * quatError.x - MECH.attitudeKd * bodyAngVel.x),
            -torqueLimit, torqueLimit
        );
        const attitudeTorqueZ = THREE.MathUtils.clamp(
            MECH.inertiaRoll * (MECH.attitudeKp * quatError.z - MECH.attitudeKd * bodyAngVel.z),
            -torqueLimit, torqueLimit
        );
        const yawTorque = tipped ? 0.0 : THREE.MathUtils.clamp(
            MECH.inertiaYaw * MECH.yawKp * (motion.desiredYawRate - bodyAngVel.y),
            -MECH.yawTorque, MECH.yawTorque
        );

        debug.assist = assist;
        debug.margin = tippingMargin;
        debug.tipped = tipped;

        lastDriveX = tipped ? 0.0 : driveX;
        lastDriveZ = tipped ? 0.0 : driveZ;
        lastMargin = tippingMargin;

        return {
            ...motion,
            attitudeTorqueX,
            attitudeTorqueZ,
            yawTorque,
            tippingMargin
        };
    }

    // Совмещенный вызов для тестов и внешних потребителей: обе фазы на одной
    // опоре. В приложении фазы разделены, чтобы силы решались один раз —
    // после похода, когда стойки уже стоят на своих местах.
    function update(
        dt: number,
        support: FootSupportResult,
        command: any,
        state: LocomotionBodyState,
        weather: WeatherState | null = null
    ): any {
        const motion = plan(dt, support, command, state, weather);
        return finalize(support, motion, weather);
    }

    // Сопла холодного наддува в полете выравнивают корпус, но не тянут его:
    // момента хватает только на крен с тангажом, а курс остается прежним.
    // Импульс момента не зависит от resetTorques контактного слоя.
    function applyAirAttitude(dt: number, state: LocomotionBodyState): void {
        scratchEuler.set(0.0, state.currentYaw, 0.0, 'YXZ');
        targetQuat.setFromEuler(scratchEuler);
        inverseQuat.copy(state.bodyQuat).invert();
        quatError.copy(targetQuat).multiply(inverseQuat);
        if (quatError.w < 0.0) {
            quatError.x = -quatError.x;
            quatError.y = -quatError.y;
            quatError.z = -quatError.z;
            quatError.w = -quatError.w;
        }

        const torqueX = THREE.MathUtils.clamp(
            MECH.inertiaPitch * (MECH.jumpAirKp * quatError.x - MECH.jumpAirKd * state.bodyAngVel.x),
            -MECH.jumpAirTorque, MECH.jumpAirTorque
        );
        const torqueZ = THREE.MathUtils.clamp(
            MECH.inertiaRoll * (MECH.jumpAirKp * quatError.z - MECH.jumpAirKd * state.bodyAngVel.z),
            -MECH.jumpAirTorque, MECH.jumpAirTorque
        );

        body.applyTorqueImpulse({ x: torqueX * dt, y: 0.0, z: torqueZ * dt }, true);
    }

    // Импульс просадки амортизаторов при постановке трипода: теперь это
    // настоящее вертикальное воздействие, а не сдвиг целевой высоты.
    function registerStepImpact(): void {
        body.applyImpulse({ x: 0.0, y: -MECH.stepImpactImpulse, z: 0.0 }, true);
    }

    // Разовый удар корпуса при ударе по песку
    function registerStompImpact(): void {
        body.applyImpulse({ x: 0.0, y: -MECH.stompImpulse, z: 0.0 }, true);
    }

    function getDebug(): LocomotionDebug {
        return debug;
    }

    return {
        readBodyState, plan, finalize, update,
        registerStepImpact, registerStompImpact, getDebug
    };
}
