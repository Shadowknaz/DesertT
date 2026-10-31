// Аналитическое поле высот пустыни: ветровые барханы поверх пологих холмов
// и равномерно разбросанных горных массивов. Одна и та же функция питает меш
// песка, физический heightfield, расстановку камней, частицы и резервный рельеф.
import * as THREE from 'three';
import { TERRAIN } from '../config.ts';
import { fbmSimplex, simplexNoise, smoothRidgedSimplex, smoothstep } from './noise.ts';

export interface BiomeWeights {
    erg: number;     // Песчаное море: гигантские барханы, минимум гор
    reg: number;     // Каменистая пустыня: приплюснутый рельеф, открытая порода
    mesa: number;    // Столовые горы: террасированные плато с уступами
    classic: number; // Классическая пустыня: сбалансированные дюны и холмы
}

// C1-непрерывное мягкое включение веса биома без заломов производной
function smoothThreshold(val: number, edge: number, width: number = 0.14): number {
    return smoothstep(edge - width, edge + width, val);
}

// Вычисление непрерывных весов биомов в мировых координатах (x, z)
export function getBiomeWeights(x: number, z: number): BiomeWeights {
    const scale = TERRAIN.biomeScale;
    const b1 = simplexNoise(x * scale + 101.3, z * scale - 73.1);
    const b2 = simplexNoise(x * scale - 219.7, z * scale + 341.5);

    // C1-гладкие переходы между биомами
    let erg = smoothThreshold(b1, 0.18);
    let reg = smoothThreshold(-b1, 0.12) * smoothThreshold(0.35 - b2, 0.0);
    let mesa = smoothThreshold(b2, 0.28);
    let classic = 0.40;

    const sum = (erg + reg + mesa + classic) || 1.0;
    erg /= sum;
    reg /= sum;
    mesa /= sum;
    classic /= sum;

    // В зоне спавна мир плавно сходится к классическому сбалансированному биому
    const distSq = x * x + z * z;
    const spawnR = 24.0;
    const spawnF = 42.0;
    const spawnWeight = 1.0 - smoothstep(spawnR * spawnR, spawnF * spawnF, distSq);
    if (spawnWeight > 0.0) {
        erg *= (1.0 - spawnWeight);
        reg *= (1.0 - spawnWeight);
        mesa *= (1.0 - spawnWeight);
        classic = classic * (1.0 - spawnWeight) + spawnWeight;
    }

    return { erg, reg, mesa, classic };
}

// Ступенчатое террасирование высоты для столовых гор (Мес), затухающее у подножия
function terraceHeight(
    h: number,
    step: number = TERRAIN.mesaTerraceStep,
    x: number = 0.0,
    z: number = 0.0
): number {
    if (h < 3.5) return h;
    // Сдвиг порогов небольшим гладким шумом убирает идеальную «линейку»
    // горизонтальных ступеней, сохраняя террасу как геологический мотив.
    const phaseJitter = simplexNoise(x * 0.045 + 14.0, z * 0.045 - 22.0) * 0.16;
    const u = h / step + phaseJitter;
    const uFloor = Math.floor(u);
    const f = u - uFloor;
    const s = smoothstep(0.22, 0.78, f);
    return (uFloor + s - phaseJitter) * step;
}

// Маска горных массивов в точке (x, z): 0 — равнина, 1 — гребень хребта.
export function getMountainMask(x: number, z: number): number {
    const biomes = getBiomeWeights(x, z);
    const regionalScale = TERRAIN.mountainScale * (
        biomes.classic * 1.00 + biomes.reg * 1.24 + biomes.mesa * 0.78 + biomes.erg * 0.90
    );
    const regionalWarp = TERRAIN.mountainWarpAmplitude * (
        0.78 + biomes.erg * 0.42 + biomes.reg * 0.10 + biomes.mesa * 0.18
    );
    const warpX = simplexNoise(x * 0.0032 + 17.0, z * 0.0032 - 29.0) * regionalWarp;
    const warpZ = simplexNoise(x * 0.0032 - 43.0, z * 0.0032 + 11.0) * regionalWarp;
    const ridge = smoothRidgedSimplex(
        (x + warpX) * regionalScale,
        (z + warpZ) * regionalScale,
        5,
        2.0,
        0.48
    );
    const mask = smoothstep(TERRAIN.mountainStart, TERRAIN.mountainFull, ridge);

    const inner = TERRAIN.spawnClearRadius;
    const outer = inner + TERRAIN.spawnClearFeather;
    const spawnClear = smoothstep(inner * inner, outer * outer, x * x + z * z);

    return mask * spawnClear;
}

// Неограниченная аналитическая высота. Публичная getDuneHeight ниже
// применяет общий вертикальный remap, чтобы высокие массивы не давали
// непроходимые стены и сохраняли единый профиль для меша и физики.
function getRawDuneHeight(x: number, z: number): number {
    const biomes = getBiomeWeights(x, z);

    // Непрерывный хребтовый каркас горной системы
    // Три октавы дают связный тектонический каркас: крупный хребет,
    // средние отроги и мелкие складки вместо набора одинаковых бугров.
    // Искривляем домен до сэмплирования, чтобы массивы не были конусами,
    // вырезанными из симметричной карты шума.
    const regionalMountainScale = TERRAIN.mountainScale * (
        biomes.classic * 1.00 + biomes.reg * 1.24 + biomes.mesa * 0.78 + biomes.erg * 0.90
    );
    const regionalWarpAmplitude = TERRAIN.mountainWarpAmplitude * (
        0.78 + biomes.erg * 0.42 + biomes.reg * 0.10 + biomes.mesa * 0.18
    );
    const mountainWarpX = simplexNoise(x * 0.0032 + 17.0, z * 0.0032 - 29.0) * regionalWarpAmplitude;
    const mountainWarpZ = simplexNoise(x * 0.0032 - 43.0, z * 0.0032 + 11.0) * regionalWarpAmplitude;
    const mountainX = x + mountainWarpX;
    const mountainZ = z + mountainWarpZ;
    const rawRidge = smoothRidgedSimplex(
        mountainX * regionalMountainScale,
        mountainZ * regionalMountainScale,
        5,
        2.0,
        0.48
    );
    const inner = TERRAIN.spawnClearRadius;
    const outer = inner + TERRAIN.spawnClearFeather;
    const spawnClear = smoothstep(inner * inner, outer * outer, x * x + z * z);

    // 1. Широкое подножие предгорий (Piedmont / Bajada): пологий подъем от равнины
    const foothillWeight = smoothstep(0.10, 0.62, rawRidge) * spawnClear * (1.0 - biomes.erg * 0.65);

    // 2. Основное тело хребтов (Cordillera Spine)
    const spineWeight = smoothstep(TERRAIN.mountainStart, TERRAIN.mountainFull, rawRidge) * spawnClear * (1.0 - biomes.erg * 0.75);

    // Межгорные долины и седловины (Saddles & Passes).
    // Низкочастотное поле сначала мягко снижает высоту хребта, а затем
    // отдельным вычитанием формирует широкие проходы между массивами.
    // Поворот и domain warp растягивают долины в связные проходы, вместо
    // изотропных пятен одинакового размера во всех направлениях.
    const valleyU = x * 0.82 + z * 0.57;
    const valleyV = -x * 0.57 + z * 0.82;
    const valleyWarp = simplexNoise(x * 0.005 + 71.4, z * 0.005 - 42.8) * TERRAIN.valleyWarpAmplitude;
    const valleyField = 0.5 + 0.5 * simplexNoise(
        (valleyU + valleyWarp) * TERRAIN.valleyScale * 0.8 + 55.1,
        (valleyV - valleyWarp) * TERRAIN.valleyScale * 1.8 - 33.7
    );
    const valleyWeight = smoothstep(0.54, 0.82, valleyField);
    const saddle = 1.0 - valleyWeight * 0.24;

    // Пологие холмы равнины
    const hillAmp = TERRAIN.hillAmplitude * (1.0 + biomes.erg * 0.25 - biomes.reg * 0.55 + biomes.mesa * 0.08);
    const regionalHillScale = TERRAIN.hillScale * (
        biomes.classic * 1.00 + biomes.reg * 1.28 + biomes.mesa * 0.82 + biomes.erg * 0.90
    );
    const hills = fbmSimplex(x * regionalHillScale, z * regionalHillScale, 5, 2.0, 0.50) * hillAmp;

    // Формирование связной горной системы
    let mountain = 0.0;
    if (foothillWeight > 0.001) {
        // Предгорья: широкая наклонная бахада, соединяющая равнину с телом гор
        const foothills = Math.pow(foothillWeight, 1.5) * TERRAIN.foothillBase;

        // Основной горный массив: высокий хребет, контрфорсы и вершинные скалы
        let mainBody = 0.0;
        let gullyMask = 0.0;
        if (spineWeight > 0.001) {
            const regionalMountainHeight = TERRAIN.mountainBase * (
                0.90 + biomes.classic * 0.08 + biomes.reg * 0.04 + biomes.mesa * 0.24 - biomes.erg * 0.20
            );
            const massifH = regionalMountainHeight +
                fbmSimplex(x * TERRAIN.massifScale, z * TERRAIN.massifScale, 2, 2.0, 0.5) * TERRAIN.mountainVariation;

            // Среднемасштабные контрфорсы (отроги, стекающие со склонов)
            const spurs = smoothRidgedSimplex(
                mountainX * TERRAIN.spurScale,
                mountainZ * TERRAIN.spurScale,
                5,
                2.0,
                0.46
            ) * TERRAIN.spurAmplitude;

            // Вершинные скалы и складки (проявляются только на верхних пиках)
            const crags = smoothRidgedSimplex(
                mountainX * TERRAIN.cragScale,
                mountainZ * TERRAIN.cragScale,
                4,
                2.0,
                0.44
            ) * TERRAIN.cragAmplitude;

            // Пять октав мелкого шума добавляют перегибы и осыпи, не меняя
            // силуэт макроформы. Амплитуда ограничена, чтобы детали не
            // превращались в новые острые вершины.
            const detailWarpX = simplexNoise(x * 0.008 + 93.0, z * 0.008 - 37.0) * 9.0;
            const detailWarpZ = simplexNoise(x * 0.008 - 47.0, z * 0.008 + 61.0) * 9.0;
            const detailX = mountainX + detailWarpX;
            const detailZ = mountainZ + detailWarpZ;
            const regionalDetail = TERRAIN.midDetailAmplitude * (
                0.78 + biomes.reg * 0.55 + biomes.mesa * 0.24 - biomes.erg * 0.28
            );
            const midDetail = fbmSimplex(
                detailX * 0.028 + 19.0,
                detailZ * 0.028 - 43.0,
                5,
                2.0,
                0.50
            ) * regionalDetail;
            const slopeDetail = fbmSimplex(
                detailX * 0.052 + 91.0,
                detailZ * 0.052 - 37.0,
                5,
                2.0,
                0.48
            ) * (0.9 + biomes.reg * 0.35);
            const gullyField = 0.5 + 0.5 * fbmSimplex(
                detailX * 0.070 - 31.0,
                detailZ * 0.070 + 19.0,
                4,
                2.0,
                0.52
            );
            gullyMask = smoothstep(0.58, 0.84, gullyField);

            // Сужаем тело к гребню и оставляем максимальную высоту только
            // на верхней части хребта, чтобы дальние горы не превращались
            // в сплошную горизонтальную стену.
            const spineProfile = Math.pow(spineWeight, TERRAIN.mountainProfilePower);
            const crestProfile = 0.72 + 0.28 * smoothstep(0.52, 0.92, rawRidge);
            mainBody = spineProfile * (massifH * crestProfile * saddle +
                (spurs + crags * crestProfile + midDetail + slopeDetail) * spineProfile);
        }

        const valleyCarve = valleyWeight * spineWeight * TERRAIN.valleyAmplitude;
        const gullyCarve = spineWeight * gullyMask * TERRAIN.gullyAmplitude * (
            0.72 + biomes.reg * 0.30 + biomes.mesa * 0.18
        );
        mountain = Math.max(0.0, foothills + mainBody - valleyCarve - gullyCarve);

        // В биоме Мес уступы террасируются в горизонтальные плато
        if (biomes.mesa > 0.001) {
            const terraced = terraceHeight(mountain, TERRAIN.mesaTerraceStep, x, z);
            mountain = mountain + (terraced - mountain) * (biomes.mesa * 0.70);
        }
    }

    // Барханы живут на равнинах и плавно затухают на предгорьях
    const mountainFade = Math.min(1.0, foothillWeight * 0.35 + spineWeight * 0.75);
    const duneFade = 1.0 - mountainFade * TERRAIN.duneFade;

    // Эрозионные ложбины режут склоны длинными мягкими потоками. Маска
    // ограничена предгорьями и горами, поэтому равнина остаётся песчаной.
    const erosionField = 0.5 + 0.5 * fbmSimplex(
        x * 0.028 + 17.0,
        z * 0.028 - 11.0,
        5,
        2.0,
        0.56
    );
    const erosionRill = 0.5 + 0.5 * fbmSimplex(
        x * 0.065 - 31.0,
        z * 0.065 + 19.0,
        3,
        2.15,
        0.52
    );
    const erosionCut = (
        smoothstep(0.56, 0.84, erosionField) * 0.82 +
        smoothstep(0.66, 0.90, erosionRill) * 0.28
    ) * mountainFade * 1.15;

    // Низкочастотное искривление координат (Domain Warping) для естественного
    // органичного изгиба цепей барханов
    const warpX = simplexNoise(x * 0.012 + 13.7, z * 0.012 + 29.3) * 6.0;
    const warpZ = simplexNoise(x * 0.012 - 47.1, z * 0.012 - 71.5) * 6.0;
    const qx = x + warpX;
    const qz = z + warpZ;

    // Острые гребни барханов с асимметричным профилем: пологий наветренный склон
    // (stoss) и крутой подветренный срез осыпания (slip-face)
    const duneAmp = 3.1 * (1.0 + biomes.erg * TERRAIN.ergDuneBoost - biomes.reg * TERRAIN.regDuneDamp);
    const duneScale = 0.08 * (1.0 - biomes.erg * 0.22);
    const nx = qx * duneScale;
    const nz = qz * duneScale;
    const phase = nx * 1.1 + Math.cos(nz * 0.85) * 1.6;
    const skewedWave = Math.sin(phase + 0.45 * Math.cos(phase));
    // Профиль без abs(): у старого варианта в каждой впадине появлялся
    // математический cusp, который после flat shading превращался в острый шов.
    const duneLobe = 0.5 + 0.5 * skewedWave;
    const d1 = Math.pow(duneLobe, 1.65) * duneAmp;

    // Вторичные волны через изотропный симплекс-шум
    let d2 = fbmSimplex(
        qx * 0.11 + 8.0,
        qz * 0.11 - 5.0,
        4,
        2.0,
        0.52
    ) * (0.38 * (1.0 - biomes.reg * 0.4));

    // Микрорельеф ветровой ряби на песке
    let ripple = Math.sin(qx * 2.6 + qz * 1.1 + Math.sin(qz * 0.5) * 2.0) * 0.075;

    const relief = hills + mountain - erosionCut + (d1 + d2 + ripple - 2.1) * duneFade;

    // Вертикальный remap работает относительно стартового уровня: низины
    // остаются на месте, а высокие массивы и крутые переходы становятся
    // более проходимыми без ступенчатого clamp-а по вершинам.
    const centeredRelief = relief - TERRAIN.spawnLevel;
    const compressedRelief = TERRAIN.spawnLevel + centeredRelief / (
        1.0 + TERRAIN.heightCompression * Math.abs(centeredRelief) / Math.max(1.0, TERRAIN.mountainBase)
    );

    // Стартовая площадка: ровный песчаный пятачок, плавно сливающийся с рельефом.
    const padInner = TERRAIN.spawnPadRadius;
    const padOuter = padInner + TERRAIN.spawnPadFeather;
    const padBlend = smoothstep(padInner * padInner, padOuter * padOuter, x * x + z * z);
    return TERRAIN.spawnLevel + (compressedRelief - TERRAIN.spawnLevel) * padBlend;
}

// Высота рельефа в мировых координатах (x, z). Все потребители — меш,
// Rapier, IK и пропсы — проходят через один и тот же ограниченный профиль.
export function getDuneHeight(x: number, z: number): number {
    return getRawDuneHeight(x, z);
}

// Нормаль поверхности — резервный путь, когда физический луч Rapier не нашел
// пересечения, а также базис для ориентации скал и пропсов.
export function getDuneNormal(x: number, z: number, eps: number = 0.25): THREE.Vector3 {
    const r2 = x * x + z * z;
    if (r2 <= TERRAIN.spawnPadRadius * TERRAIN.spawnPadRadius) {
        return new THREE.Vector3(0, 1, 0);
    }
    const hC = getDuneHeight(x, z);
    const hX = getDuneHeight(x + eps, z);
    const hZ = getDuneHeight(x, z + eps);
    return new THREE.Vector3(hC - hX, eps, hC - hZ).normalize();
}
