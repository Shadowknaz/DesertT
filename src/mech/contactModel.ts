// Единая модель контакта лапы: валидность касания, направление реакции,
// ход подвеса и распределение нормальных сил.
//
// Опорная геометрия (плоскость и полигон) и силовой слой пользуются одним
// и тем же критерием: зазор до песка плюс досягаемость IK. Иначе лапа могла
// строить плоскость и полигон, но не получать силу, и запас опоры считался
// по точкам, которых физически нет.
//
// Дробный вес контакта входит в само равновесие: распределение нагрузки
// решается по фактическим силам w_i·p_i, а не по полным p_i с последующим
// масштабированием. Центр давления проецируется на плоскость опоры, а не
// остается на горизонтали под центром корпуса.
import { HEXAPOD, MECH, PHYSICS } from '../config.ts';
import type { Vector3Like, QuaternionLike } from '../types/index.ts';

export type { Vector3Like, QuaternionLike };

export interface ContactInfo {
    weight: number;
    gapFactor: number;
    reachFactor: number;
}

export interface LoadResult {
    sumNormal: number;
    vertical: number;
    loadRatio: number;
    supported: number;
    copX: number;
    copZ: number;
    copValid: boolean;
    normalX: number;
    normalY: number;
    normalZ: number;
}

export interface LegContactState {
    groundNormal?: Vector3Like | null;
    groundGap?: number;
    hipLocal?: Vector3Like | null;
    currentFootPos: Vector3Like;
    contactBlend?: number;
    isPlanted?: boolean;
    isStepping?: boolean;
    supportForce?: number;
    contactWeight?: number;
    [key: string]: any;
}

export interface SupportPlaneLike {
    supportY: number;
    pitchSlope: number;
    rollSlope: number;
    [key: string]: any;
}

// Предельная длина ноги: дальше IK упирается в предел, и стопа до
// поверхности не достает. Единицы те же, что в solveHexapodLeg.
const MAX_REACH_MODEL = (HEXAPOD.femurLength + HEXAPOD.tibiaLength) * 0.992;
const ANKLE_WORLD = HEXAPOD.ankleHeight * HEXAPOD.scale;

const BODY_WEIGHT = MECH.mass * Math.abs(PHYSICS.gravity);

// Максимум лап на меха: буферы рассчитаны с запасом и не аллоцируются
// в горячем цикле.
const MAX_LEGS = 16;

const activeIndex = new Int32Array(MAX_LEGS);
const activeWeight = new Float32Array(MAX_LEGS);
const normalX = new Float32Array(MAX_LEGS);
const normalY = new Float32Array(MAX_LEGS);
const normalZ = new Float32Array(MAX_LEGS);
const armX = new Float32Array(MAX_LEGS);
const armY = new Float32Array(MAX_LEGS);
const armZ = new Float32Array(MAX_LEGS);
// Коэффициенты равновесия столбца: w·n_y, w·(r×n)_x, w·(r×n)_z.
const coefY = new Float64Array(MAX_LEGS);
const coefMX = new Float64Array(MAX_LEGS);
const coefMZ = new Float64Array(MAX_LEGS);
const isFree = new Uint8Array(MAX_LEGS);

const scratchHip: Vector3Like = { x: 0.0, y: 0.0, z: 0.0 };
const scratchNormal: Vector3Like = { x: 0.0, y: 1.0, z: 0.0 };

// Суммарные величины последнего решателя: их читает опорная геометрия.
const loadResult: LoadResult = {
    sumNormal: 0.0,
    vertical: 0.0,
    loadRatio: 0.0,
    supported: 0,
    copX: 0.0,
    copZ: 0.0,
    copValid: false,
    normalX: 0.0,
    normalY: 1.0,
    normalZ: 0.0
};

const contactInfo: ContactInfo = {
    weight: 1.0,
    gapFactor: 1.0,
    reachFactor: 1.0
};

const ERROR = 1e-6;

// Мировой узел бедра: поворот локального выноса кватернионом корпуса.
// Тяга прикладывается именно здесь, а не над стопой: сила приходит в
// корпус через бедро, и выдумывать ей точку приложения не нужно.
export function hipOffset<T extends Vector3Like>(quat: QuaternionLike, hip: Vector3Like, out: T): T {
    const x = quat.x;
    const y = quat.y;
    const z = quat.z;
    const w = quat.w;
    out.x = (1.0 - 2.0 * (y * y + z * z)) * hip.x
        + 2.0 * (x * y - w * z) * hip.y
        + 2.0 * (x * z + w * y) * hip.z;
    out.y = 2.0 * (x * y + w * z) * hip.x
        + (1.0 - 2.0 * (x * x + z * z)) * hip.y
        + 2.0 * (y * z - w * x) * hip.z;
    out.z = 2.0 * (x * z - w * y) * hip.x
        + 2.0 * (y * z + w * x) * hip.y
        + (1.0 - 2.0 * (x * x + y * y)) * hip.z;
    return out;
}

// Направление реакции — нормаль песка под лапой, ограниченная по
// крутизне. Стенка воронки почти вертикальна, и сила вдоль такой
// нормали выстреливала бы корпус вбок; уклон опоры так не делает.
// Крутизну ограничиваем поворотом к вертикали, а не обрезкой компоненты:
// после повторной нормировки обрезка снова ушла бы к почти
// горизонтальной реакции.
export function legContactNormal<T extends Vector3Like>(leg: { groundNormal?: Vector3Like | null }, out: T): T {
    const g = leg.groundNormal;
    const x = g ? g.x : 0.0;
    const y = g ? g.y : 1.0;
    const z = g ? g.z : 0.0;
    const len = Math.hypot(x, y, z);

    if (!(len > ERROR)) {
        out.x = 0.0;
        out.y = 1.0;
        out.z = 0.0;
        return out;
    }

    let nx = x / len;
    let ny = y / len;
    let nz = z / len;

    const minY = MECH.contactNormalMinY;
    if (ny < minY) {
        const h = Math.hypot(nx, nz);
        const s = h > ERROR ? Math.sqrt(1.0 - minY * minY) / h : 0.0;
        nx *= s;
        nz *= s;
        ny = minY;
    }

    out.x = nx;
    out.y = ny;
    out.z = nz;
    return out;
}

// Степень касания лапы: зазор до песка, досягаемость IK и плавный ввод
// стойки после постановки. Возвращает общий объект — читать нужно сразу.
//
// weight — доля силы, которую лапа может передать (0..1). Именно она
// входит и в равновесие, и в пружину, поэтому частичный контакт не
// выпадает из баланса.
export function evaluateContact(
    leg: LegContactState,
    bodyPos: Vector3Like,
    bodyQuat?: QuaternionLike | null
): ContactInfo {
    const gap = leg.groundGap;

    let gapFactor = 1.0;
    if (gap !== undefined) {
        // Зазор не измерен (первый кадр, синтетические лапы) — считаем касание.
        if (!(gap < MECH.contactGapRelease)) {
            contactInfo.weight = 0.0;
            contactInfo.gapFactor = 0.0;
            contactInfo.reachFactor = 1.0;
            return contactInfo;
        }
        if (gap > MECH.contactGapFull) {
            gapFactor = 1.0 - (gap - MECH.contactGapFull)
                / (MECH.contactGapRelease - MECH.contactGapFull);
        }
    }

    let reachFactor = 1.0;
    if (bodyQuat && leg.hipLocal) {
        hipOffset(bodyQuat, leg.hipLocal, scratchHip);
        const dx = leg.currentFootPos.x - bodyPos.x - scratchHip.x;
        const dy = leg.currentFootPos.y + ANKLE_WORLD - bodyPos.y - scratchHip.y;
        const dz = leg.currentFootPos.z - bodyPos.z - scratchHip.z;

        // Match inverse mountNode.matrixWorld in IK: the ankle lift is in
        // world Y, but coxa radius and vertical reach are in the hip frame.
        const { x, y, z, w } = bodyQuat;
        const localX = (1.0 - 2.0 * (y * y + z * z)) * dx
            + 2.0 * (x * y + w * z) * dy + 2.0 * (x * z - w * y) * dz;
        const localY = 2.0 * (x * y - w * z) * dx
            + (1.0 - 2.0 * (x * x + z * z)) * dy + 2.0 * (y * z + w * x) * dz;
        const localZ = 2.0 * (x * z + w * y) * dx
            + 2.0 * (y * z - w * x) * dy + (1.0 - 2.0 * (x * x + y * y)) * dz;
        const radial = Math.hypot(localX, localZ) / HEXAPOD.scale;
        const vertical = localY / HEXAPOD.scale;
        const stretch = Math.hypot(radial - HEXAPOD.coxaOffset, vertical) / MAX_REACH_MODEL;

        if (stretch > 1.0) {
            reachFactor = Math.max(0.0, 1.0 - (stretch - 1.0) / MECH.contactReachSlack);
        }
    }

    // Стойка после постановки нагружается плавно: скачок активного набора
    // при смене трипода не бьет по корпусу моментом.
    const blend = leg.contactBlend === undefined ? 1.0 : leg.contactBlend;

    contactInfo.gapFactor = gapFactor;
    contactInfo.reachFactor = reachFactor;
    contactInfo.weight = gapFactor * reachFactor * blend;
    return contactInfo;
}

// Ход подвеса считается от плоскости, проведенной через стопы, а не от
// мировой вертикали. На склоне 24% стопы расходятся по высоте на метр:
// привязка к абсолютной высоте превращала любой уклон в предельное
// сжатие всех пружин, и корпус швыряло в гору еще до первого шага.
//
// От плоскости остаются только две вещи, которые действительно
// описывают подвес: насколько корпус ниже посадочной высоты над опорой
// и насколько конкретная стопа выбивается из этой плоскости (бугры, ямы).
export function springTravel(
    leg: LegContactState,
    bodyPos: Vector3Like,
    bodyQuat: QuaternionLike | null,
    plane: SupportPlaneLike
): number {
    const foot = leg.currentFootPos;
    const planeAtFoot = plane.supportY
        + plane.pitchSlope * (foot.z - bodyPos.z)
        + plane.rollSlope * (foot.x - bodyPos.x);

    const deviation = foot.y - planeAtFoot;
    const heightError = plane.supportY + MECH.rideHeight - bodyPos.y;

    // Наклон корпуса относительно плоскости опоры: упавшее бедро
    // сжимает свою стойку, поднятое — разгружает. Это единственная
    // пружинная жесткость на крен и тангаж, и без нее корпус держится
    // только моментным бюджетом гидравлики.
    const hip = leg.hipLocal;
    const hipRestY = hip ? hip.y : 0.0;
    const hipTilt = hip && bodyQuat
        ? hipOffset(bodyQuat, hip, scratchHip).y - hipRestY
        : 0.0;

    // Бугор под одной лапой — это работа IK, а не сжатие подвеса.
    // Стойка подстраивается под рельеф, и в пружину идет только часть
    // отклонения: иначе бугор в полметра выбивает корпус вверх, потому
    // что отрицательные отклонения обрезаны нулем и баланс сил ломается.
    const compression = heightError
        + deviation * MECH.contactDeviationGain
        - hipTilt;

    if (compression > MECH.contactTravel) {
        return MECH.contactTravel
            + (compression - MECH.contactTravel) * MECH.contactStopRate;
    }
    return compression;
}

// Решение симметричной системы 3x3 с регуляризацией. Матрица вырождается,
// когда стопы стоят почти на одной прямой: без регуляризации деление на
// почти нулевой определитель дает мусорные нагрузки.
function solveSymmetric3(m: Float64Array, rhs: Float64Array, out: Float64Array): boolean {
    const reg = 1e-6 * (m[0] + m[4] + m[8] + 1.0);
    const a11 = m[0] + reg;
    const a12 = m[1];
    const a13 = m[2];
    const a22 = m[4] + reg;
    const a23 = m[5];
    const a33 = m[8] + reg;

    const i11 = a22 * a33 - a23 * a23;
    const i12 = a13 * a23 - a12 * a33;
    const i13 = a12 * a23 - a13 * a22;
    const i22 = a11 * a33 - a13 * a13;
    const i23 = a13 * a12 - a11 * a23;
    const i33 = a11 * a22 - a12 * a12;

    const det = a11 * i11 + a12 * i12 + a13 * i13;
    if (!(Math.abs(det) > 1e-12)) {
        out[0] = 0.0;
        out[1] = 0.0;
        out[2] = 0.0;
        return false;
    }

    const inv = 1.0 / det;
    const b1 = rhs[0];
    const b2 = rhs[1];
    const b3 = rhs[2];
    out[0] = inv * (i11 * b1 + i12 * b2 + i13 * b3);
    out[1] = inv * (i12 * b1 + i22 * b2 + i23 * b3);
    out[2] = inv * (i13 * b1 + i23 * b2 + i33 * b3);
    return true;
}

const system = new Float64Array(9);
const systemRhs = new Float64Array(3);
const systemSolution = new Float64Array(3);

// Распределение предварительной нагрузки из равновесия моментов.
//
// Применяемая сила лапы — w_i·(p_i + пружина). Поэтому в ограничениях
// участвуют именно w_i·p_i:
//   Σ w_i·n_iy·p_i = W,  Σ w_i·(r_i × n_i p_i)_x,z = 0.
// Равномерное деление p_i = W/N служит только стартовой точкой, а
// отрицательные p_i выводятся из активного набора и система решается
// заново: иначе на краю полигона нагрузка резко перебрасывалась бы на
// оставшиеся лапы.
function solvePreload(active: number): number {
    // Меньше трех контактов не могут удовлетворить вертикаль и два момента:
    // вырожденная коррекция только раскачивает нагрузку. Делим вес поровну,
    // а неизбежный момент опрокидывает корпус физически.
    if (active < 3) {
        systemSolution[0] = 0.0;
        systemSolution[1] = 0.0;
        systemSolution[2] = 0.0;
        for (let k = 0; k < active; k++) isFree[k] = 1;
        return active;
    }

    let freeCount = active;
    isFree.fill(0, 0, active);
    for (let k = 0; k < active; k++) isFree[k] = 1;
    systemSolution[0] = 0.0;
    systemSolution[1] = 0.0;
    systemSolution[2] = 0.0;

    for (let iter = 0; iter <= active; iter++) {
        const base = BODY_WEIGHT / Math.max(1, freeCount);

        system[0] = system[1] = system[2] = 0.0;
        system[3] = system[4] = system[5] = 0.0;
        system[6] = system[7] = system[8] = 0.0;
        systemRhs[0] = BODY_WEIGHT;
        systemRhs[1] = 0.0;
        systemRhs[2] = 0.0;

        for (let k = 0; k < active; k++) {
            if (!isFree[k]) continue;
            const ay = coefY[k];
            const mx = coefMX[k];
            const mz = coefMZ[k];

            system[0] += ay * ay;
            system[1] += ay * mx;
            system[2] += ay * mz;
            system[4] += mx * mx;
            system[5] += mx * mz;
            system[8] += mz * mz;

            systemRhs[0] -= ay * base;
            systemRhs[1] -= mx * base;
            systemRhs[2] -= mz * base;
        }
        system[3] = system[1];
        system[6] = system[2];
        system[7] = system[5];

        if (!solveSymmetric3(system, systemRhs, systemSolution)) {
            // Вырожденная стойка: равновесие не определено, остаемся на
            // равномерном делении, а не на решении от прошлого набора.
            systemSolution[0] = 0.0;
            systemSolution[1] = 0.0;
            systemSolution[2] = 0.0;
            break;
        }

        // Самая отрицательная нагрузка покидает активный набор: ее сила
        // и так была бы нулевой, а равновесие пересчитывается без нее.
        let worst = -1;
        let worstP = -ERROR;
        for (let k = 0; k < active; k++) {
            if (!isFree[k]) continue;
            const p = base + coefY[k] * systemSolution[0]
                + coefMX[k] * systemSolution[1]
                + coefMZ[k] * systemSolution[2];
            if (p < worstP) {
                worstP = p;
                worst = k;
            }
        }

        if (worst < 0) return freeCount;
        isFree[worst] = 0;
        freeCount--;
        if (freeCount <= 0) {
            systemSolution[0] = 0.0;
            systemSolution[1] = 0.0;
            systemSolution[2] = 0.0;
            return 0;
        }
    }

    return freeCount;
}

// Решает нормальные силы всех подтвержденных лап и возвращает суммарные
// величины. Нормальные силы записываются в leg.normalForce/normalLoad.
//
// forceLimit — предел суммарной нормальной силы в ньютонах.
// bodyPos anchors pose, hips and plane height; bodyVel is the CoM velocity.
// Synthetic callers without a mass offset may omit bodyCom.
export function solveNormalLoads(
    legs: LegContactState[],
    bodyPos: Vector3Like,
    bodyQuat: QuaternionLike,
    bodyVel: Vector3Like,
    bodyAngVel: Vector3Like,
    plane: SupportPlaneLike,
    forceLimit: number,
    bodyCom: Vector3Like = bodyPos
): LoadResult {
    const count = Math.min(legs.length, MAX_LEGS);

    // --- Подтверждение касания и геометрия --------------------------------
    let active = 0;

    for (let i = 0; i < count; i++) {
        const leg = legs[i];
        // Решатель ничего не меняет в силовом состоянии лапы: он пишет
        // только предсказание supportForce/contactWeight. Приложенные
        // силы и normalLoad назначает контактный слой, поэтому походка
        // и песок никогда не видят промежуточное решение.
        leg.supportForce = 0.0;
        leg.contactWeight = 0.0;

        if (!leg.isPlanted || leg.isStepping) continue;

        const info = evaluateContact(leg, bodyPos, bodyQuat);
        const weight = info.weight;
        if (weight <= 0.0) continue;

        legContactNormal(leg, scratchNormal);

        const rx = leg.currentFootPos.x - bodyCom.x;
        const ry = leg.currentFootPos.y - bodyCom.y;
        const rz = leg.currentFootPos.z - bodyCom.z;

        const nx = scratchNormal.x;
        const ny = scratchNormal.y;
        const nz = scratchNormal.z;

        leg.contactWeight = weight;

        activeIndex[active] = i;
        activeWeight[active] = weight;
        normalX[active] = nx;
        normalY[active] = ny;
        normalZ[active] = nz;
        armX[active] = rx;
        armY[active] = ry;
        armZ[active] = rz;

        // Столбец равновесия с учетом дробного веса контакта.
        coefY[active] = weight * ny;
        coefMX[active] = weight * (ry * nz - rz * ny);
        coefMZ[active] = weight * (rx * ny - ry * nx);
        active++;
    }

    if (active === 0) {
        loadResult.sumNormal = 0.0;
        loadResult.vertical = 0.0;
        loadResult.loadRatio = 0.0;
        loadResult.supported = 0;
        loadResult.copX = bodyCom.x;
        loadResult.copZ = bodyCom.z;
        loadResult.copValid = false;
        loadResult.normalX = 0.0;
        loadResult.normalY = 1.0;
        loadResult.normalZ = 0.0;
        return loadResult;
    }

    const freeCount = solvePreload(active);
    const base = BODY_WEIGHT / Math.max(1, freeCount);

    // --- Пружины, моменты и центр давления --------------------------------
    let sumNormal = 0.0;
    let sumVertical = 0.0;
    let forceX = 0.0;
    let forceZ = 0.0;
    let momentX = 0.0;
    let momentY = 0.0;
    let momentZ = 0.0;

    for (let k = 0; k < active; k++) {
        const leg = legs[activeIndex[k]];
        const weight = activeWeight[k];
        const nx = normalX[k];
        const ny = normalY[k];
        const nz = normalZ[k];
        const rx = armX[k];
        const ry = armY[k];
        const rz = armZ[k];

        // Нулевая предварительная нагрузка у лап, выведенных из равновесия.
        let p = 0.0;
        if (isFree[k]) {
            p = base + coefY[k] * systemSolution[0]
                + coefMX[k] * systemSolution[1]
                + coefMZ[k] * systemSolution[2];
            if (!(p > 0.0)) p = 0.0;
        }

        // Скорость точки контакта вдоль нормали: (v + ω × r) · n
        const vx = bodyVel.x + bodyAngVel.y * rz - bodyAngVel.z * ry;
        const vy = bodyVel.y + bodyAngVel.z * rx - bodyAngVel.x * rz;
        const vz = bodyVel.z + bodyAngVel.x * ry - bodyAngVel.y * rx;
        const vn = vx * nx + vy * ny + vz * nz;

        const travel = springTravel(leg, bodyPos, bodyQuat, plane);
        const raw = p + MECH.contactStiffness * travel - MECH.contactDamping * vn;
        const dHip = Math.hypot(rx, ry, rz);
        const torqueLimit = HEXAPOD.actuatorTorqueMax || (MECH.maxNormalForce * 1.5);
        const actuatorMax = torqueLimit / Math.max(0.4, dHip);
        const maxForce = Math.min(MECH.maxNormalForce, Math.max(BODY_WEIGHT * 1.5, actuatorMax));
        const magnitude = Math.max(0.0, Math.min(raw * weight, maxForce));

        leg.supportForce = magnitude;

        if (magnitude > 1e-3) {
            const fx = nx * magnitude;
            const fy = ny * magnitude;
            const fz = nz * magnitude;

            sumNormal += magnitude;
            sumVertical += fy;
            forceX += fx;
            forceZ += fz;
            momentX += ry * fz - rz * fy;
            momentY += rz * fx - rx * fz;
            momentZ += rx * fy - ry * fx;
        }
    }

    // Ограничение суммарной силы не меняет точку приложения: масштаб общий.
    if (sumNormal > forceLimit) {
        const scale = forceLimit / sumNormal;
        for (let k = 0; k < active; k++) {
            const leg = legs[activeIndex[k]];
            leg.supportForce = (leg.supportForce ?? 0) * scale;
        }
        sumNormal = forceLimit;
        sumVertical *= scale;
        forceX *= scale;
        forceZ *= scale;
        momentX *= scale;
        momentY *= scale;
        momentZ *= scale;
    }

    let supported = 0;
    let avgX = 0.0;
    let avgY = 0.0;
    let avgZ = 0.0;
    for (let k = 0; k < active; k++) {
        const leg = legs[activeIndex[k]];
        if ((leg.supportForce ?? 0) <= 1e-3) continue;
        supported++;
        avgX += normalX[k] * leg.supportForce!;
        avgY += normalY[k] * leg.supportForce!;
        avgZ += normalZ[k] * leg.supportForce!;
    }

    const avgLen = Math.hypot(avgX, avgY, avgZ);
    if (avgLen > ERROR) {
        loadResult.normalX = avgX / avgLen;
        loadResult.normalY = avgY / avgLen;
        loadResult.normalZ = avgZ / avgLen;
    } else {
        loadResult.normalX = 0.0;
        loadResult.normalY = 1.0;
        loadResult.normalZ = 0.0;
    }

    const copValid = supported > 0
        && sumVertical > BODY_WEIGHT * MECH.copMinRatio;
    loadResult.sumNormal = sumNormal;
    loadResult.vertical = sumVertical;
    loadResult.loadRatio = sumVertical / BODY_WEIGHT;
    loadResult.supported = supported;
    loadResult.copValid = copValid;
    if (copValid) {
        // Центр давления — пересечение линии действия равнодействующей с
        // наклонной плоскостью опоры. Проекция на горизонталь под корпусом
        // давала ошибку порядка уклона × смещение, а на крутых склонах это
        // уже метры. Нормаль плоскости берём из той же подгонки (b, c).
        const forceSq = forceX * forceX + sumVertical * sumVertical + forceZ * forceZ;
        const inv = forceSq > 1e-9 ? 1.0 / forceSq : 0.0;
        // Ближайшая к корпусу точка линии действия: o = (F × M) / |F|².
        const ox = (sumVertical * momentZ - forceZ * momentY) * inv;
        const oy = (forceZ * momentX - forceX * momentZ) * inv;
        const oz = (forceX * momentY - sumVertical * momentX) * inv;

        const roll = plane.rollSlope;
        const pitch = plane.pitchSlope;
        const nlen = Math.hypot(roll, 1.0, pitch);
        const nx = -roll / nlen;
        const ny = 1.0 / nlen;
        const nz = -pitch / nlen;
        // Plane height is anchored at the body origin, moments at world CoM.
        const drop = plane.supportY + roll * (bodyCom.x - bodyPos.x)
            + pitch * (bodyCom.z - bodyPos.z) - bodyCom.y;
        const denom = nx * forceX + ny * sumVertical + nz * forceZ;

        if (Math.abs(denom) > 1e-6) {
            const shift = (ny * drop - (nx * ox + ny * oy + nz * oz)) / denom;
            loadResult.copX = bodyCom.x + ox + shift * forceX;
            loadResult.copZ = bodyCom.z + oz + shift * forceZ;
        } else {
            // Near-parallel resultant: retain the horizontal-plane fallback.
            loadResult.copX = bodyCom.x + (momentZ + drop * forceX) / sumVertical;
            loadResult.copZ = bodyCom.z + (-momentX + drop * forceZ) / sumVertical;
        }
    } else {
        loadResult.copX = bodyCom.x;
        loadResult.copZ = bodyCom.z;
    }

    return loadResult;
}

