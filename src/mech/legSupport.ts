// Опорная геометрия по стоящим лапам: плоскость опоры, полигон, центр
// давления и запас до ребра опрокидывания.
//
// Валидность стоп общая с силовым слоем (contactModel): зазор до песка плюс
// досягаемость IK. Раньше плоскость строилась по одним лапам, а полигон и
// пружины — по другим, и на смене трипода угол корпуса и запас опоры
// скакали.
import * as THREE from 'three';
import { MECH, PHYSICS, SANDFIELD } from '../config.ts';
import {
    evaluateContact,
    legContactNormal,
    solveNormalLoads,
    type LegContactState,
    type QuaternionLike,
    type Vector3Like
} from './contactModel.ts';

// Предел наклона опорной плоскости. Он же предел ходьбы: если плоскость
// ограничить сильнее, скорость, держащая сила и нормаль контакта начинают
// описывать разные по крутизне поверхности.
const MAX_SLOPE = MECH.slopeLimit;

// Уклон, после которого подгонка плоскости считается мусором: три лапы
// почти на прямой линии дают деление на почти нулевой определитель.
const MAX_FIT_SLOPE = 1.6;

const BODY_WEIGHT = MECH.mass * Math.abs(PHYSICS.gravity);
const NORMAL_LIMIT = BODY_WEIGHT * MECH.normalForceLimit;

const ZERO: Vector3Like = { x: 0.0, y: 0.0, z: 0.0 };
const normalScratch: Vector3Like = { x: 0.0, y: 1.0, z: 0.0 };

export interface SlopesInHeading {
    pitchSlope: number;
    rollSlope: number;
}

// Уклон опорной плоскости в системе курса корпуса. Мировые коэффициенты
// b/c (dy/dx и dy/dz) годятся только при курсе вдоль оси Z: после разворота
// та же поверхность наклоняет корпус вокруг другой локальной оси, и подавать
// мировой уклон в локальный pitch/roll нельзя.
export function slopesInHeading(normal: Vector3Like, yaw: number): SlopesInHeading {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const ny = Math.max(0.2, normal.y);

    // Обратный поворот вокруг Y переводит нормаль в систему курса.
    const nxLocal = normal.x * cos - normal.z * sin;
    const nzLocal = normal.x * sin + normal.z * cos;

    return {
        pitchSlope: -nzLocal / ny,
        rollSlope: -nxLocal / ny
    };
}

export interface HullPoint {
    x: number;
    y: number;
    z: number;
}

// Выпуклая оболочка точек опоры; на вход приходит 3 или 6 стоп.
function convexHull(points: HullPoint[]): HullPoint[] {
    if (points.length < 3) return points.slice();

    const sorted = points.slice().sort((a, b) => (a.x - b.x) || (a.z - b.z));
    const cross = (o: HullPoint, a: HullPoint, b: HullPoint): number =>
        (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

    const lower: HullPoint[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }

    const upper: HullPoint[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

// Знаковое расстояние от точки до ребра: положительное — внутри полигона.
function edgeDistance(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
    const ex = bx - ax;
    const ez = bz - az;
    const len = Math.hypot(ex, ez);
    if (len < 1e-5) return 0;
    return (ex * (pz - az) - ez * (px - ax)) / len;
}

export interface FootSupportResult {
    supportY: number;
    pitchSlope: number;
    rollSlope: number;
    slope: number;
    normal: THREE.Vector3;
    plantedCount: number;
    supportArea: number;
    stability: number;
    tippingMargin: number;
    edgeDirX: number;
    edgeDirZ: number;
    copX: number;
    copZ: number;
    copValid: boolean;
    traction: number;
    sink: number;
    sinkMax: number;
    minFootGap: number;
    nearGroundCount: number;
    loadsSolved: boolean;
    loadNormal: number;
    loadRatio: number;
    supportedLoads: number;
}

function emptySupport(y: number): FootSupportResult {
    return {
        supportY: y,
        pitchSlope: 0.0,
        rollSlope: 0.0,
        slope: 0.0,
        normal: new THREE.Vector3(0, 1, 0),
        plantedCount: 0,
        supportArea: 0.0,
        stability: 0.0,
        tippingMargin: 0.0,
        edgeDirX: 0.0,
        edgeDirZ: 0.0,
        copX: 0.0,
        copZ: 0.0,
        copValid: false,
        traction: 0.0,
        sink: 0.0,
        sinkMax: 0.0,
        minFootGap: Infinity,
        nearGroundCount: 0,
        loadsSolved: false,
        loadNormal: 0.0,
        loadRatio: 0.0,
        supportedLoads: 0
    };
}

export interface FootSupportPose {
    y?: number;
    quat?: QuaternionLike | null;
    com?: Vector3Like | null;
    vel?: Vector3Like | null;
    angVel?: Vector3Like | null;
    landingGear?: boolean;
    solveLoads?: boolean;
    commitSupport?: boolean;
}

// pose: { y, quat, com, vel, angVel, landingGear, solveLoads, commitSupport }.
// x/z/y remain the body origin; com and vel are world CoM position/velocity.
// Synthetic callers may omit com (origin fallback), rotation and velocities.
export function computeFootSupport(
    legs: LegContactState[],
    bodyX = 0.0,
    bodyZ = 0.0,
    pose: FootSupportPose | null = null
): FootSupportResult {
    const bodyQuat = pose ? pose.quat : null;
    const bodyVel = pose && pose.vel ? pose.vel : ZERO;
    const bodyAngVel = pose && pose.angVel ? pose.angVel : ZERO;
    const probeY = pose && Number.isFinite(pose.y) ? pose.y! : 0.0;
    const probe: Vector3Like = { x: bodyX, y: probeY, z: bodyZ };
    // Гистерезис опорной геометрии обновляется только на постпоходной
    // пробе: до походки используется решение прошлого подшага.
    const commit = pose !== null && pose.commitSupport === true;

    // --- Один набор опорных стоп на все расчеты ---------------------------
    // Плоскость, полигон, центр давления и пружины берут одни и те же стопы.
    let allY = 0.0;
    let minFootGap = Infinity;
    let nearGroundCount = 0;
    const feet: LegContactState[] = [];
    const footWeights: number[] = [];

    for (const leg of legs) {
        const foot = leg.currentFootPos;
        allY += foot.y;

        // Зазор нужен и для посадки: в полете лапы выпущены к песку, но
        // еще не опора, и корпус не должен считать себя севшим раньше них.
        const gap = leg.groundGap === undefined ? 0.0 : leg.groundGap;
        if (Number.isFinite(gap)) {
            if (gap < minFootGap) minFootGap = gap;
            if (gap <= MECH.landingFootTolerance) nearGroundCount++;
        }

        if (!leg.isPlanted || leg.isStepping) {
            if (commit) leg.supportIncluded = false;
            continue;
        }
        const info = evaluateContact(leg, probe, bodyQuat);

        // Плоскость и полигон строят только лапы с существенным касанием.
        // Затухающая лапа еще отдает долю силы, но наклон опоры и запас
        // хода определять не должна. Гистерезис удерживает уже включенную
        // лапу до более низкого порога, чтобы набор не мигал на границе.
        const solid = info.weight >= MECH.supportWeightMin
            || (leg.supportIncluded === true && info.weight >= MECH.supportWeightHold);
        if (commit) leg.supportIncluded = solid;
        if (!solid) continue;

        feet.push(leg);
        // Вес касания идет и в подгонку плоскости: стопа на грани порога
        // наклоняет опору пропорционально своей опоре, а не полностью.
        footWeights.push(info.weight);
    }

    const solveLoads = pose === null || pose.solveLoads !== false;
    const landingGear = pose !== null && pose.landingGear === true;
    const forceLimit = landingGear ? BODY_WEIGHT * MECH.landingForceLimit : NORMAL_LIMIT;
    const grounded = feet.length;
    if (grounded === 0) {
        const empty = emptySupport(allY / Math.max(1, legs.length));
        empty.minFootGap = minFootGap;
        empty.nearGroundCount = nearGroundCount;
        const origin: Vector3Like = {
            x: bodyX,
            y: pose && Number.isFinite(pose.y) ? pose.y! : empty.supportY + MECH.rideHeight,
            z: bodyZ
        };
        const com = pose && pose.com ? pose.com : origin;
        empty.copX = com.x;
        empty.copZ = com.z;
        if (solveLoads && bodyQuat) {
            // Weak contacts still carry force without defining a polygon.
            // Solve here, before finalize, so contacts never need a second solve.
            const loads = solveNormalLoads(
                legs, origin, bodyQuat, bodyVel, bodyAngVel, empty, forceLimit, com
            );
            empty.loadsSolved = true;
            empty.loadNormal = loads.sumNormal;
            empty.loadRatio = loads.loadRatio;
            empty.supportedLoads = loads.supported;
            empty.copX = loads.copX;
            empty.copZ = loads.copZ;
            empty.copValid = loads.copValid;
            empty.normal.set(loads.normalX, loads.normalY, loads.normalZ);
        }
        return empty;
    }

    let sumW = 0.0;
    let sumX = 0.0;
    let sumZ = 0.0;
    let sumY = 0.0;
    for (let i = 0; i < feet.length; i++) {
        const pos = feet[i].currentFootPos;
        const w = footWeights[i];
        sumW += w;
        sumX += pos.x * w;
        sumZ += pos.z * w;
        sumY += pos.y * w;
    }

    const mx = sumX / sumW;
    const mz = sumZ / sumW;
    const my = sumY / sumW;

    // --- Плоскость: геометрия подтвержденных стоп, взвешенная касанием ----
    // Стопа на границе порога наклоняет опору пропорционально своему весу,
    // поэтому переход через порог не дает полного скачка наклона.
    let sxx = 0.0, szz = 0.0, sxz = 0.0, sxy = 0.0, szy = 0.0;
    for (let i = 0; i < feet.length; i++) {
        const pos = feet[i].currentFootPos;
        const w = footWeights[i];
        const dx = pos.x - mx;
        const dz = pos.z - mz;
        const dy = pos.y - my;
        sxx += w * dx * dx;
        szz += w * dz * dz;
        sxz += w * dx * dz;
        sxy += w * dx * dy;
        szy += w * dz * dy;
    }

    const det = sxx * szz - sxz * sxz;

    // Опора считается вырожденной, если лапы почти на одной прямой: тогда
    // наклон плоскости не определен, и любое деление на det дает мусор.
    const regular = Math.abs(det) > 1e-3 * Math.max(1.0, sxx * szz);

    let b = 0.0;
    let c = 0.0;

    if (regular) {
        b = (sxy * szz - szy * sxz) / det;
        c = (szy * sxx - sxy * sxz) / det;

        // Крутизна выше MAX_FIT_SLOPE — уже не рельеф, а мусор подгонки.
        if (!Number.isFinite(b) || !Number.isFinite(c) || Math.hypot(b, c) > MAX_FIT_SLOPE) {
            b = 0.0;
            c = 0.0;
        }
    }

    b = THREE.MathUtils.clamp(b, -MAX_SLOPE, MAX_SLOPE);
    c = THREE.MathUtils.clamp(c, -MAX_SLOPE, MAX_SLOPE);

    const a = my - b * mx - c * mz;
    const supportY = a + b * bodyX + c * bodyZ;

    // --- Нормальные силы, центр давления и средняя нормаль ----------------
    // Считаются по текущей позе и плоскости, без задержки на подшаг:
    // нормальные силы пишутся в лапы и используются контактным слоем.
    const bodyPos: Vector3Like = {
        x: bodyX,
        y: pose && Number.isFinite(pose.y) ? pose.y! : supportY + MECH.rideHeight,
        z: bodyZ
    };
    const bodyCom = pose && pose.com ? pose.com : bodyPos;
    const plane = { supportY, pitchSlope: c, rollSlope: b };

    // One post-gait solve, including weak force-only contacts.
    let loads: ReturnType<typeof solveNormalLoads> | null = null;
    if (solveLoads && bodyQuat) {
        loads = solveNormalLoads(
            legs, bodyPos, bodyQuat, bodyVel, bodyAngVel, plane, forceLimit, bodyCom
        );
    }

    // Нормаль опоры — среднее направление фактических реакций. Без решения
    // сил (до похода) берется направление последних приложенных сил:
    // это фактическая реакция без повторного расчета нагрузок. Совсем без
    // данных остается нормаль геометрической плоскости.
    let normal: THREE.Vector3;
    if (loads !== null && loads.supported > 0) {
        normal = new THREE.Vector3(loads.normalX, loads.normalY, loads.normalZ);
    } else if (!solveLoads) {
        let ax = 0.0;
        let ay = 0.0;
        let az = 0.0;
        for (const leg of feet) {
            const load = leg.normalLoad || 0.0;
            if (load <= 1e-3) continue;
            legContactNormal(leg, normalScratch);
            ax += normalScratch.x * load;
            ay += normalScratch.y * load;
            az += normalScratch.z * load;
        }
        const len = Math.hypot(ax, ay, az);
        normal = len > 1e-6
            ? new THREE.Vector3(ax / len, ay / len, az / len)
            : new THREE.Vector3(-b, 1.0, -c).normalize();
    } else {
        normal = new THREE.Vector3(-b, 1.0, -c).normalize();
    }

    // Крутизна берется из той же нормали, что и ориентация корпуса.
    // Раньше здесь стоял уклон подгонки до ограничения, и на предельных
    // склонах скорость, удержание и реакция описывали разные поверхности.
    const slope = Math.hypot(normal.x, normal.z) / Math.max(0.2, normal.y);

    // --- Полигон и запас: те же стопы -------------------------------------
    const hullPoints: HullPoint[] = [];
    let traction = 0.0;
    let sinkSum = 0.0;
    let sinkMax = 0.0;

    for (const leg of feet) {
        const pos = leg.currentFootPos;
        hullPoints.push({ x: pos.x, z: pos.z, y: pos.y });

        const sink = leg.sink || 0.0;
        sinkSum += sink;
        if (sink > sinkMax) sinkMax = sink;

        traction += leg.traction || 0.0;
    }

    const plantedCount = hullPoints.length;

    // Гравитация вертикальна, поэтому критерий опрокидывания — именно
    // горизонтальная проекция центра масс, а не проекция на плоскость.
    const hull = convexHull(hullPoints);
    let margin = 0.0;
    let area = 0.0;
    let edgeDirX = 0.0;
    let edgeDirZ = 0.0;

    if (hull.length >= 3) {
        margin = Infinity;
        for (let i = 0; i < hull.length; i++) {
            const p0 = hull[i];
            const p1 = hull[(i + 1) % hull.length];
            const d = edgeDistance(p0.x, p0.z, p1.x, p1.z, bodyCom.x, bodyCom.z);
            if (d < margin) {
                margin = d;
                // Наружная нормаль ближайшего ребра: вдоль неё запас
                // уменьшается, и туда же сдвигает центр масс торможение.
                const ex = p1.x - p0.x;
                const ez = p1.z - p0.z;
                const len = Math.hypot(ex, ez);
                if (len > 1e-5) {
                    edgeDirX = ez / len;
                    edgeDirZ = -ex / len;
                }
            }
            area += p0.x * p1.z - p1.x * p0.z;
        }
        area = Math.abs(area) * 0.5;
        if (!Number.isFinite(margin)) margin = 0.0;
    } else {
        margin = 0.0;
    }

    return {
        supportY,
        pitchSlope: c,
        rollSlope: b,
        slope,
        normal,
        plantedCount,
        supportArea: area,
        stability: THREE.MathUtils.clamp(margin / SANDFIELD.stabilityMargin, 0, 1),
        tippingMargin: margin,
        edgeDirX,
        edgeDirZ,
        copX: loads !== null ? loads.copX : bodyCom.x,
        copZ: loads !== null ? loads.copZ : bodyCom.z,
        copValid: loads !== null ? loads.copValid : false,
        traction,
        sink: sinkSum / plantedCount,
        sinkMax,
        minFootGap,
        nearGroundCount,
        loadsSolved: solveLoads,
        loadNormal: loads !== null ? loads.sumNormal : 0.0,
        loadRatio: loads !== null ? loads.loadRatio : 0.0,
        supportedLoads: loads !== null ? loads.supported : 0
    };
}

