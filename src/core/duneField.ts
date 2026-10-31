// Многоуровневая процедурная генерация пустынного мира:
// 1. Macro terrain — крупные геологические формы (песчаные бассейны, региональные уклоны, плато).
// 2. Terrain type map — непрерывные веса типов местности (sand sea, dune regions,
//    calm plains, rocky hills, canyon regions) с широкими переходными зонами.
// 3. Regional terrain — специализированные природные формы для каждого региона:
//    океанические песчаные поля, вытянутые ветровые гряды дюн с междюнными коридорами,
//    широкие пологие пустынные холмы и связные протяжённые каньоны/разломы.
// 4. Local variation — слабая вторичная детализация выветривания без мелкого шума.
// 5. Post-processing — селективное сглаживание по маскам регионов, ограничение
//    локальных перепадов (slope limiting) и быстрая аппроксимация эрозии.
import * as THREE from 'three';
import { TERRAIN } from '../config.ts';
import { fbmSimplex, simplexNoise, smoothRidgedSimplex, smoothstep } from './noise.ts';
import { createRng } from './rng.ts';

export interface TerrainTypeWeights {
    sandWeight: number;   // Sand sea / Ergs (40–55%): огромные открытые песчаные моря
    duneWeight: number;   // Dune regions (15–25%): длинные направленные ветровые гряды дюн
    plainWeight: number;  // Calm desert plains (10–20%): спокойные пустынные равнины
    rockWeight: number;   // Rocky hills (10–15%): широкие пологие каменистые холмы
    canyonWeight: number; // Canyon regions (5–10%): протяжённые каньоны, русла и разломы
}

export interface BiomeWeights extends TerrainTypeWeights {
    erg: number;     // Песчаное море и поля дюн (совместимость со слоями окраски и пропсов)
    reg: number;     // Каменистая пустыня и холмы
    mesa: number;    // Каньонные плато и стратифицированные уступы
    classic: number; // Спокойная пустынная равнина
}

export interface MacroTerrainSample {
    elevation: number;  // Доминирующая крупномасштабная высота основы мира
    basinMask: number;  // 0..1 маска широких песчаных низин
    uplandMask: number; // 0..1 маска возвышенных плато и каменистых массивов
    canyonCorridor: number; // 0..1 близость к крупному геологическому разлому
}

interface SeedDerivedOffsets {
    seed: number;
    macroX: number;
    macroZ: number;
    tiltX: number;
    tiltZ: number;
    warpX: number;
    warpZ: number;
    biome1X: number;
    biome1Z: number;
    biome2X: number;
    biome2Z: number;
    biome3X: number;
    biome3Z: number;
    windAngle: number;
    windCos: number;
    windSin: number;
    windX: number;
    windZ: number;
    duneX: number;
    duneZ: number;
    hillX: number;
    hillZ: number;
    massifX: number;
    massifZ: number;
    canyonX: number;
    canyonZ: number;
    canyonBranchX: number;
    canyonBranchZ: number;
    canyonCos: number;
    canyonSin: number;
    detailX: number;
    detailZ: number;
}

function buildSeedOffsets(seed: number): SeedDerivedOffsets {
    const cleanSeed = Number.isFinite(seed) ? (seed | 0) : TERRAIN.defaultSeed;
    const rng = createRng(cleanSeed ^ 0x5deece66d);
    const span = 4096.0;
    const nextOffset = () => (rng.next() - 0.5) * span;

    // Базовое направление господствующего ветра зависит от seed
    const windAngle = 0.58 + (rng.next() - 0.5) * 1.4;
    const canyonAngle = windAngle + 0.95 + (rng.next() - 0.5) * 0.6;

    return {
        seed: cleanSeed,
        macroX: nextOffset(),
        macroZ: nextOffset(),
        tiltX: nextOffset(),
        tiltZ: nextOffset(),
        warpX: nextOffset(),
        warpZ: nextOffset(),
        biome1X: nextOffset(),
        biome1Z: nextOffset(),
        biome2X: nextOffset(),
        biome2Z: nextOffset(),
        biome3X: nextOffset(),
        biome3Z: nextOffset(),
        windAngle,
        windCos: Math.cos(windAngle),
        windSin: Math.sin(windAngle),
        windX: nextOffset(),
        windZ: nextOffset(),
        duneX: nextOffset(),
        duneZ: nextOffset(),
        hillX: nextOffset(),
        hillZ: nextOffset(),
        massifX: nextOffset(),
        massifZ: nextOffset(),
        canyonX: nextOffset(),
        canyonZ: nextOffset(),
        canyonBranchX: nextOffset(),
        canyonBranchZ: nextOffset(),
        canyonCos: Math.cos(canyonAngle),
        canyonSin: Math.sin(canyonAngle),
        detailX: nextOffset(),
        detailZ: nextOffset()
    };
}

let activeOffsets: SeedDerivedOffsets = buildSeedOffsets(TERRAIN.defaultSeed);

// Установка и чтение seed генерации мира (полный детерминизм всех слоёв)
export function setTerrainSeed(seed: number): void {
    activeOffsets = buildSeedOffsets(seed);
}

export function getTerrainSeed(): number {
    return activeOffsets.seed;
}

// C1-непрерывное мягкое включение веса региона
function smoothBand(val: number, edge: number, width: number = TERRAIN.transitionWidth): number {
    return smoothstep(edge - width, edge + width, val);
}

// Очень осторожный низкочастотный domain warp для макро- и региональных форм:
// не ломает крупные формы и не создаёт «расплавленного» шума.
function getMacroWarpedCoords(
    x: number,
    z: number,
    out: { wx: number; wz: number } = { wx: 0, wz: 0 }
): { wx: number; wz: number } {
    const s = TERRAIN.macroWarpScale;
    const amp = TERRAIN.macroWarpAmplitude;
    const dx = simplexNoise(x * s + activeOffsets.warpX, z * s + activeOffsets.warpZ) * amp;
    const dz = simplexNoise(x * s - activeOffsets.warpZ, z * s + activeOffsets.warpX) * amp;
    out.wx = x + dx;
    out.wz = z + dz;
    return out;
}

const _warpScratch = { wx: 0, wz: 0 };
const _macroScratch: MacroTerrainSample = {
    elevation: 0,
    basinMask: 0,
    uplandMask: 0,
    canyonCorridor: 0
};
const _typesScratch: TerrainTypeWeights = {
    sandWeight: 0,
    duneWeight: 0,
    plainWeight: 0,
    rockWeight: 0,
    canyonWeight: 0
};
const _centerTypesScratch: TerrainTypeWeights = {
    sandWeight: 0,
    duneWeight: 0,
    plainWeight: 0,
    rockWeight: 0,
    canyonWeight: 0
};
const _orientScratch = { cos: 1, sin: 0, angle: 0 };

// ---------------------------------------------------------------------------
// 1. MACRO TERRAIN — крупные геологические формы мира
// ---------------------------------------------------------------------------
export function getMacroTerrain(
    x: number,
    z: number,
    out?: MacroTerrainSample,
    precomputedWx?: number,
    precomputedWz?: number
): MacroTerrainSample {
    let wx: number;
    let wz: number;
    if (precomputedWx !== undefined && precomputedWz !== undefined) {
        wx = precomputedWx;
        wz = precomputedWz;
    } else {
        getMacroWarpedCoords(x, z, _warpScratch);
        wx = _warpScratch.wx;
        wz = _warpScratch.wz;
    }

    // Очень низкочастотный fbm (всего 2 октавы, малый gain) задаёт географию:
    // широкие песчаные бассейны против возвышенных сухих плато.
    const macroWave = fbmSimplex(
        wx * TERRAIN.macroScale + activeOffsets.macroX,
        wz * TERRAIN.macroScale + activeOffsets.macroZ,
        2,
        2.0,
        0.34
    );

    // Плавный региональный уклон горизонта на сверхдлинной волне
    const regionalTilt = simplexNoise(
        x * TERRAIN.macroTiltScale + activeOffsets.tiltX,
        z * TERRAIN.macroTiltScale + activeOffsets.tiltZ
    ) * TERRAIN.macroTiltAmplitude;

    // Непрерывная линия главного каньона/разлома в макро-масштабе
    const cWarp = simplexNoise(
        x * TERRAIN.canyonWarpScale + activeOffsets.canyonX * 0.5,
        z * TERRAIN.canyonWarpScale + activeOffsets.canyonZ * 0.5
    ) * TERRAIN.canyonWarpAmplitude;
    const cxRot = (x + cWarp) * activeOffsets.canyonCos - (z - cWarp) * activeOffsets.canyonSin;
    const czRot = (x + cWarp) * activeOffsets.canyonSin + (z - cWarp) * activeOffsets.canyonCos;
    const canyonLine = Math.abs(simplexNoise(
        cxRot * TERRAIN.canyonScale + activeOffsets.canyonX,
        czRot * (TERRAIN.canyonScale * 0.55) + activeOffsets.canyonZ
    ));
    const canyonCorridor = 1.0 - smoothstep(0.0, TERRAIN.canyonWidth * 2.1, canyonLine);

    let basinMask = smoothstep(0.15, -0.40, macroWave);
    let uplandMask = smoothstep(0.16, 0.68, macroWave);

    // В радиусе 180 м формируем просторный открытый песчаный бассейн в направлении
    // главного обзора (-X, -Z), чтобы горизонт был низким, протяжённым и воздушным,
    // а высокие массивы располагались редкими крупными акцентами на флангах и вдали (+X, +Z).
    const dist = Math.hypot(x, z);
    const vistaMask = smoothstep(28.0, 52.0, dist) * (1.0 - smoothstep(150.0, 240.0, dist));
    if (vistaMask > 0.001) {
        // Коридор открытого песчаного моря и спокойной равнины вдоль (-X, -Z)
        const dirAngle = Math.atan2(z, x);
        // -2.30 рад (~ -132°) — направление взгляда стартовой камеры
        const openSeaAlign = Math.max(0.0, Math.cos(dirAngle + 2.30));
        const openSeaCorridor = Math.pow(openSeaAlign, 1.4) * vistaMask;

        basinMask = Math.min(1.0, basinMask + openSeaCorridor * 0.85);
        uplandMask *= (1.0 - openSeaCorridor * 0.92);

        // Крупный дальний массив на противоположном горизонте (+X, +Z)
        const farUplandAlign = Math.max(0.0, Math.cos(dirAngle - 0.78));
        const farUplandBoost = Math.pow(farUplandAlign, 2.0) * smoothstep(62.0, 96.0, dist) * vistaMask;
        uplandMask = Math.min(1.0, uplandMask + farUplandBoost * 0.85);
    }

    // Спокойная зона вокруг старта переходит в выразительные макроформы к горизонту
    const r2 = x * x + z * z;
    const inner = TERRAIN.spawnClearRadius;
    const outer = inner + TERRAIN.spawnClearFeather;
    const spawnClear = smoothstep(inner * inner, outer * outer, r2);

    const rawElevation =
        regionalTilt * 0.45 -
        basinMask * (TERRAIN.macroBasinDepth * 0.65) +
        Math.pow(uplandMask, 1.35) * TERRAIN.macroUplandHeight;

    const target = out || { elevation: 0, basinMask: 0, uplandMask: 0, canyonCorridor: 0 };
    target.elevation = TERRAIN.spawnLevel + rawElevation * spawnClear;
    target.basinMask = basinMask * spawnClear + (1.0 - spawnClear) * 0.75;
    target.uplandMask = uplandMask * spawnClear;
    target.canyonCorridor = canyonCorridor * spawnClear;
    return target;
}

// ---------------------------------------------------------------------------
// 2. TERRAIN TYPE MAP — непрерывная карта типов пустынной местности
// ---------------------------------------------------------------------------
export function getTerrainTypeMap(
    x: number,
    z: number,
    out?: TerrainTypeWeights,
    precomputedMacro?: MacroTerrainSample,
    precomputedWx?: number,
    precomputedWz?: number
): TerrainTypeWeights {
    const scale = TERRAIN.biomeScale;
    let wx: number;
    let wz: number;
    if (precomputedWx !== undefined && precomputedWz !== undefined) {
        wx = precomputedWx;
        wz = precomputedWz;
    } else {
        getMacroWarpedCoords(x, z, _warpScratch);
        wx = _warpScratch.wx;
        wz = _warpScratch.wz;
    }

    // Три низкочастотных поля для распределения 5 типов пустынных регионов
    const n1 = simplexNoise(wx * scale + activeOffsets.biome1X, wz * scale + activeOffsets.biome1Z);
    const n2 = simplexNoise(wx * (scale * 0.85) + activeOffsets.biome2X, wz * (scale * 0.85) + activeOffsets.biome2Z);
    const n3 = simplexNoise(wx * (scale * 1.15) + activeOffsets.biome3X, wz * (scale * 1.15) + activeOffsets.biome3Z);

    const macro = precomputedMacro || getMacroTerrain(x, z, _macroScratch, wx, wz);

    // 1. Sand sea / Ergs (цель ~40–55% мира): широкие песчаные моря в низинах и открытых бассейнах
    let sandWeight = 0.44 + 0.42 * smoothBand(n1, -0.16, 0.32) * (0.65 + 0.35 * macro.basinMask);

    // 2. Dune regions (цель ~15–25% мира): поля длинных ветровых дюн и барханов
    let duneWeight = 0.06 + 0.56 * smoothBand(n2, 0.06, 0.28) * (1.0 - macro.uplandMask * 0.40);

    // 3. Calm desert plains (цель ~10–20% мира): спокойные открытые равнины с ровным горизонтом
    let plainWeight = 0.08 + 0.46 * smoothBand(-n2, 0.04, 0.30) * (0.45 + 0.55 * smoothBand(-n3, -0.10, 0.32));

    // 4. Rocky hills (цель ~10–15% мира): широкие пологие каменистые возвышенности
    let rockWeight = 0.03 + 0.58 * smoothBand(n1, 0.16, 0.26) * (0.45 + 0.55 * macro.uplandMask);

    // 5. Canyon regions (цель ~5–10% мира): протяжённые каньоны и разломы
    let canyonWeight = 0.02 + 0.52 * macro.canyonCorridor * (0.45 + 0.55 * smoothBand(n3, -0.12, 0.32));

    // На средних и дальних планах вокруг стартовой долины обеспечиваем читаемую
    // геологическую композицию:
    // широкое песчаное море по центру -> длинные ветровые дюны слева ->
    // разлом каньона и пологие каменистые холмы справа/вдали.
    const dist = Math.hypot(x, z);
    const ringWeight = smoothstep(32.0, 54.0, dist) * (1.0 - smoothstep(145.0, 220.0, dist));
    if (ringWeight > 0.001) {
        const angle = Math.atan2(z, x);
        // Центр обзора (-2.30 рад): спокойное песчаное море и открытая равнина
        const seaSector = Math.max(0.0, Math.cos(angle + 2.30));
        // Левый фланг обзора (-2.85 рад): протяжённые ветровые гряды дюн
        const duneSector = Math.max(0.0, Math.cos(angle + 2.88));
        // Правый фланг обзора (-1.65 рад): пологие каменистые холмы, разрезанные каньоном
        const canyonRightSector = Math.max(0.0, Math.cos(angle + 1.62));
        // Дальний массив (+0.78 рад): высокие каменистые возвышенности и глубокий каньон
        const farMassifSector = Math.max(0.0, Math.cos(angle - 0.78));
        const farCanyonSector = Math.max(0.0, Math.cos(angle + 0.35));

        sandWeight += ringWeight * Math.pow(seaSector, 1.5) * 0.85;
        plainWeight += ringWeight * Math.pow(seaSector, 2.2) * 0.45;
        duneWeight += ringWeight * Math.pow(duneSector, 1.8) * 0.95;
        canyonWeight += ringWeight * smoothstep(46.0, 72.0, dist) * (
            Math.pow(canyonRightSector, 3.0) * 0.85 + Math.pow(farCanyonSector, 2.4) * 0.95
        );
        rockWeight += ringWeight * smoothstep(54.0, 84.0, dist) * (
            Math.pow(canyonRightSector, 2.2) * 0.45 + Math.pow(farMassifSector, 1.8) * 1.15
        );
    }

    // В зоне спавна мир плавно открывается в спокойное песчаное море и равнину
    const distSq = x * x + z * z;
    const spawnR = TERRAIN.spawnClearRadius;
    const spawnF = spawnR + TERRAIN.spawnClearFeather;
    const spawnCalm = 1.0 - smoothstep(spawnR * spawnR, spawnF * spawnF, distSq);
    if (spawnCalm > 0.0) {
        sandWeight = sandWeight * (1.0 - spawnCalm) + 0.68 * spawnCalm;
        plainWeight = plainWeight * (1.0 - spawnCalm) + 0.24 * spawnCalm;
        duneWeight = duneWeight * (1.0 - spawnCalm) + 0.08 * spawnCalm;
        rockWeight *= (1.0 - spawnCalm);
        canyonWeight *= (1.0 - spawnCalm);
    }

    const sum = (sandWeight + duneWeight + plainWeight + rockWeight + canyonWeight) || 1.0;
    sandWeight /= sum;
    duneWeight /= sum;
    plainWeight /= sum;
    rockWeight /= sum;
    canyonWeight /= sum;

    if (out) {
        out.sandWeight = sandWeight;
        out.duneWeight = duneWeight;
        out.plainWeight = plainWeight;
        out.rockWeight = rockWeight;
        out.canyonWeight = canyonWeight;
        return out;
    }
    return { sandWeight, duneWeight, plainWeight, rockWeight, canyonWeight };
}

// Вычисление непрерывных весов биомов в мировых координатах (x, z)
// Сохраняет обратную совместимость (erg, reg, mesa, classic) и включает 5 весов регионов.
export function getBiomeWeights(x: number, z: number, out?: BiomeWeights): BiomeWeights {
    const types = getTerrainTypeMap(x, z, _typesScratch);

    let erg = types.sandWeight * 0.75 + types.duneWeight * 0.95;
    let reg = types.rockWeight * 0.82 + types.plainWeight * 0.30;
    let mesa = types.canyonWeight * 0.90 + types.rockWeight * 0.18;
    let classic = types.plainWeight * 0.70 + types.sandWeight * 0.25 + types.duneWeight * 0.05;

    const legacySum = (erg + reg + mesa + classic) || 1.0;
    erg /= legacySum;
    reg /= legacySum;
    mesa /= legacySum;
    classic /= legacySum;

    if (out) {
        out.sandWeight = types.sandWeight;
        out.duneWeight = types.duneWeight;
        out.plainWeight = types.plainWeight;
        out.rockWeight = types.rockWeight;
        out.canyonWeight = types.canyonWeight;
        out.erg = erg;
        out.reg = reg;
        out.mesa = mesa;
        out.classic = classic;
        return out;
    }

    return {
        sandWeight: types.sandWeight,
        duneWeight: types.duneWeight,
        plainWeight: types.plainWeight,
        rockWeight: types.rockWeight,
        canyonWeight: types.canyonWeight,
        erg,
        reg,
        mesa,
        classic
    };
}

// Направление ветровых гряд дюн в точке (x, z): плавно меняется от региона к региону
export function getDuneOrientation(
    x: number,
    z: number,
    out?: { cos: number; sin: number; angle: number }
): { cos: number; sin: number; angle: number } {
    const drift = simplexNoise(
        x * 0.00085 + activeOffsets.windX,
        z * 0.00085 + activeOffsets.windZ
    ) * 0.28;
    const angle = activeOffsets.windAngle + drift;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    if (out) {
        out.cos = cos;
        out.sin = sin;
        out.angle = angle;
        return out;
    }
    return { cos, sin, angle };
}

// Ступенчатое террасирование высоты для каньонов и столовых возвышенностей (Мес)
function terraceHeight(
    h: number,
    step: number = TERRAIN.mesaTerraceStep,
    x: number = 0.0,
    z: number = 0.0
): number {
    const phaseJitter = simplexNoise(
        x * 0.012 + activeOffsets.canyonX * 0.1,
        z * 0.012 + activeOffsets.canyonZ * 0.1
    ) * 0.12;
    const u = h / step + phaseJitter;
    const uFloor = Math.floor(u);
    const f = u - uFloor;
    // Мягкая ступенька: крутой уступ и широкая пологая полка
    const s = smoothstep(0.18, 0.72, f);
    return (uFloor + s - phaseJitter) * step;
}

// Маска каменистых массивов и холмов в точке (x, z): 0 — песчаная равнина, 1 — вершина холма
export function getMountainMask(x: number, z: number): number {
    getMacroWarpedCoords(x, z, _warpScratch);
    const wx = _warpScratch.wx;
    const wz = _warpScratch.wz;
    const macro = getMacroTerrain(x, z, _macroScratch, wx, wz);
    const types = getTerrainTypeMap(x, z, _typesScratch, macro, wx, wz);
    const hillField = 0.5 + 0.5 * fbmSimplex(
        x * TERRAIN.mountainScale + activeOffsets.hillX,
        z * TERRAIN.mountainScale + activeOffsets.hillZ,
        2,
        2.0,
        0.35
    );
    const rawMask = smoothstep(TERRAIN.mountainStart, TERRAIN.mountainFull, hillField);
    const regionalWeight = Math.min(1.0, types.rockWeight * 1.45 + types.canyonWeight * 0.55 + macro.uplandMask * 0.45);

    const inner = TERRAIN.spawnClearRadius;
    const outer = inner + TERRAIN.spawnClearFeather;
    const spawnClear = smoothstep(inner * inner, outer * outer, x * x + z * z);

    return rawMask * regionalWeight * spawnClear;
}

// ---------------------------------------------------------------------------
// 3. REGIONAL TERRAIN — средние природные формы по типам местности
// ---------------------------------------------------------------------------

// 3a. Sand sea / Ergs & Calm Desert Plains: огромные открытые песчаные пространства
function computeSandSeaAndPlains(
    x: number,
    z: number,
    types: TerrainTypeWeights,
    dir: { cos: number; sin: number }
): number {
    // Очень длинные, мягкие океанические волны песка (всего 2 октавы с низким gain)
    const seaSwell = fbmSimplex(
        x * TERRAIN.sandSeaScale + activeOffsets.macroX * 0.3,
        z * TERRAIN.sandSeaScale + activeOffsets.macroZ * 0.3,
        2,
        2.0,
        0.26
    ) * (TERRAIN.sandSeaAmplitude * 0.72);

    // Редкие протяжённые песчаные гряды на открытом море песка
    const u = x * dir.cos + z * dir.sin;
    const v = -x * dir.sin + z * dir.cos;
    const longWave = Math.sin(u * 0.022 + simplexNoise(u * 0.0025, v * 0.0012) * 0.9);
    const gentleSwell = Math.pow(smoothstep(0.25, 0.95, 0.5 + 0.5 * longWave), 1.6) * 0.55;

    // Спокойная пустынная равнина с почти ровным горизонтом
    const plainUndulation = simplexNoise(
        x * TERRAIN.plainWaveScale + activeOffsets.tiltX * 0.5,
        z * TERRAIN.plainWaveScale + activeOffsets.tiltZ * 0.5
    ) * (TERRAIN.plainAmplitude * 0.75);

    return (seaSwell + gentleSwell) * types.sandWeight + plainUndulation * types.plainWeight;
}

// 3b. Dune regions: длинные направленные ветровые дюны и барханы с широкими междюнными промежутками
function computeDuneRegion(
    x: number,
    z: number,
    types: TerrainTypeWeights,
    dir: { cos: number; sin: number }
): number {
    const activeDunePresence = types.duneWeight + types.sandWeight * 0.16;
    if (activeDunePresence <= 0.001) return 0.0;

    // u — поперёк ветровых гряд (направление ветра), v — вдоль длинного гребня дюны
    const u = x * dir.cos + z * dir.sin;
    const v = -x * dir.sin + z * dir.cos;

    // Слабый низкочастотный изгиб линий дюн без эффекта «плавления»
    const warpU = simplexNoise(
        u * TERRAIN.duneWarpScale + activeOffsets.duneX,
        v * (TERRAIN.duneWarpScale * 0.35) + activeOffsets.duneZ
    ) * (TERRAIN.duneWarpAmplitude * 0.75);

    // Растянутые координаты вдоль гребня (анизотропия 1 : 5.2) создают длинные ветровые гряды
    const stretchedU = (u + warpU) * TERRAIN.duneScale;
    const stretchedV = v * (TERRAIN.duneScale * TERRAIN.duneStretch * 0.85);

    // Медленная модуляция шага и высоты гряд от цепочки к цепочке
    const chainPhase = simplexNoise(stretchedU * 0.10 + 31.4, stretchedV * 0.28 - 17.8) * 0.85;
    const phase = stretchedU * 2.45 + chainPhase;

    // Асимметричный ветровой профиль: пологий наветренный склон и более крутой подветренный срез
    const asymmetricWave = 0.5 + 0.5 * Math.sin(phase + 0.44 * Math.cos(phase));

    // Ключевая особенность пустынных дюн: широкие пониженные песчаные коридоры между грядами!
    // Отсекаем нижнюю часть волны через smoothstep(0.32, 0.96), чтобы между дюнами
    // оставались просторные спокойные междюнные промежутки, а гряды читались чётко издалека.
    const ridgeCrest = smoothstep(0.32, 0.96, asymmetricWave);
    const primaryDune = Math.pow(ridgeCrest, 1.32);

    // Продольная огибающая делает гряды длинными серпами/цепями
    const alongEnvelope = 0.65 + 0.35 * simplexNoise(
        stretchedU * 0.12 - 53.0,
        stretchedV * 0.36 + 27.0
    );

    const amp = TERRAIN.duneAmplitude * (types.duneWeight * (1.0 + TERRAIN.ergDuneBoost * 0.35) + types.sandWeight * 0.16);
    return primaryDune * alongEnvelope * amp;
}

// 3c. Rocky hills: широкие, пологие, геологически цельные пустынные возвышенности
function computeRockyHills(x: number, z: number, types: TerrainTypeWeights, macro: MacroTerrainSample): number {
    const hillWeight = types.rockWeight + macro.uplandMask * 0.45;
    if (hillWeight <= 0.001) return 0.0;

    // Слабый макро-warp для естественного силуэта массива
    const warpX = simplexNoise(x * 0.0018 + activeOffsets.hillX, z * 0.0018 - activeOffsets.hillZ) * TERRAIN.mountainWarpAmplitude;
    const warpZ = simplexNoise(x * 0.0018 - activeOffsets.hillZ, z * 0.0018 + activeOffsets.hillX) * TERRAIN.mountainWarpAmplitude;
    const hx = x + warpX;
    const hz = z + warpZ;

    // 1. Широкие пологие холмы (всего 2 октавы, гладкий профиль)
    const broadHills = (0.5 + 0.5 * fbmSimplex(
        hx * TERRAIN.hillScale + activeOffsets.hillX,
        hz * TERRAIN.hillScale + activeOffsets.hillZ,
        2,
        2.0,
        0.35
    )) * TERRAIN.hillAmplitude;

    // 2. Крупные куполообразные пустынные массивы (2 октавы smoothRidgedSimplex без мелких пиков)
    const massifRidge = smoothRidgedSimplex(
        hx * TERRAIN.mountainScale + activeOffsets.massifX,
        hz * TERRAIN.mountainScale + activeOffsets.massifZ,
        2,
        2.0,
        0.34
    );

    // Широкое пологое подножие (бахада) и сглаженный верхний силуэт
    const piedmont = smoothstep(0.14, 0.62, massifRidge) * TERRAIN.foothillBase;
    const domeMask = Math.pow(smoothstep(0.26, 0.78, massifRidge), TERRAIN.mountainProfilePower);

    // Широкие седловины и проходы между холмами
    const passField = 0.5 + 0.5 * simplexNoise(
        hx * TERRAIN.valleyScale - activeOffsets.hillZ * 0.5,
        hz * TERRAIN.valleyScale + activeOffsets.hillX * 0.5
    );
    const saddleFactor = 1.0 - smoothstep(0.58, 0.90, passField) * 0.28;

    // Мягкие плечи/отроги (2 октавы)
    const spurs = smoothRidgedSimplex(
        hx * TERRAIN.spurScale + 41.0,
        hz * TERRAIN.spurScale - 29.0,
        2,
        2.0,
        0.32
    ) * TERRAIN.spurAmplitude;

    let elevation = broadHills + piedmont + domeMask * (TERRAIN.mountainBase * saddleFactor + spurs);

    // Лёгкое выветренное ступенчатое строение на высоких каменистых склонах
    if (elevation > 4.5) {
        const terraced = terraceHeight(elevation, TERRAIN.mesaTerraceStep, x, z);
        elevation = elevation + (terraced - elevation) * 0.32;
    }

    const presence = Math.min(1.0, types.rockWeight * 1.45 + macro.uplandMask * 0.72);
    return elevation * presence;
}

// 3d. Canyon regions: связные протяжённые геологические разрезы, сухие долины и разломы
function computeCanyonRegion(x: number, z: number, types: TerrainTypeWeights): number {
    if (types.canyonWeight <= 0.001) return 0.0;

    // Плавный изгиб главного русла каньона
    const cWarpX = simplexNoise(
        x * TERRAIN.canyonWarpScale + activeOffsets.canyonX,
        z * TERRAIN.canyonWarpScale + activeOffsets.canyonZ
    ) * TERRAIN.canyonWarpAmplitude;
    const cWarpZ = simplexNoise(
        x * TERRAIN.canyonWarpScale - activeOffsets.canyonZ,
        z * TERRAIN.canyonWarpScale + activeOffsets.canyonX
    ) * TERRAIN.canyonWarpAmplitude;

    const rx = (x + cWarpX) * activeOffsets.canyonCos - (z + cWarpZ) * activeOffsets.canyonSin;
    const rz = (x + cWarpX) * activeOffsets.canyonSin + (z + cWarpZ) * activeOffsets.canyonCos;

    // Главное русло каньона — нулевая изолиния низкочастотного симплекс-поля
    const mainChannel = Math.abs(simplexNoise(
        rx * TERRAIN.canyonScale + activeOffsets.canyonX,
        rz * (TERRAIN.canyonScale * 0.55) + activeOffsets.canyonZ
    ));

    // Боковое ущелье-приток, плавно сливающееся с главным каньоном
    const branchChannel = Math.abs(simplexNoise(
        rx * (TERRAIN.canyonBranchScale * 0.65) + activeOffsets.canyonBranchX,
        rz * TERRAIN.canyonBranchScale + activeOffsets.canyonBranchZ
    ));

    // Вращательно-симметричное радиальное ущелье в секторе каньона,
    // чтобы геологический разрез гарантированно врезался в видимую область
    const angle = Math.atan2(z, x);
    const radialGorge = Math.min(
        Math.abs(Math.sin(angle + 1.62)),
        Math.abs(Math.sin(angle + 0.35))
    ) * 0.35;

    // Связная сеть каньона: главное русло + приток
    const dChannel = Math.min(mainChannel, branchChannel * 1.25 + 0.02, radialGorge);

    const floorW = TERRAIN.canyonFloorWidth;
    const rimW = TERRAIN.canyonWidth;

    // Нормализованный профиль от плоского песчаного дна (0) к верхней кромке плато (1)
    const wallT = smoothstep(floorW, rimW, dChannel);

    // Ступенчатый геологический профиль стенки каньона:
    // нижний обрыв -> промежуточная терраса (полка) -> верхний уступ кромки
    const lowerCliff = smoothstep(0.0, 0.46, wallT);
    const upperCliff = smoothstep(0.56, 1.0, wallT);
    const steppedWall = lowerCliff * 0.58 + upperCliff * 0.42;

    // Глубокий врез внутри русла (1 на дне каньона, 0 за пределами кромки)
    const carveFactor = 1.0 - steppedWall;

    // Вдоль кромки каньона порода слегка приподнята в столовое плато,
    // чтобы разрез читался рельефно даже со стороны равнины
    const rimShoulder = smoothstep(rimW * 2.2, rimW * 0.75, dChannel) * steppedWall;

    // Глубина каньона плавно варьируется вдоль русла
    const depthMod = 0.88 + 0.28 * (0.5 + 0.5 * simplexNoise(
        rx * 0.0035 - 19.0,
        rz * 0.0035 + 47.0
    ));

    const rimElevation = rimShoulder * TERRAIN.canyonRimLift;
    const canyonCut = carveFactor * TERRAIN.canyonDepth * depthMod;

    // Вес каньона усиливается вдоль самого русла
    const effectiveWeight = Math.min(1.0, types.canyonWeight * 1.65);
    return (rimElevation - canyonCut) * effectiveWeight;
}

// ---------------------------------------------------------------------------
// 4. LOCAL VARIATION — слабая вторичная детализация поверхности
// ---------------------------------------------------------------------------
function computeLocalDetail(x: number, z: number, types: TerrainTypeWeights): number {
    // Всего 1 октава среднего масштаба: лёгкая выветренность на холмах и стенах каньонов,
    // почти нулевая на песчаных полях, чтобы поверхность никогда не превращалась в «кашу».
    const n = simplexNoise(
        x * TERRAIN.localDetailScale + activeOffsets.detailX,
        z * TERRAIN.localDetailScale + activeOffsets.detailZ
    );
    const regionalAmp = TERRAIN.localDetailAmplitude * (
        types.sandWeight * 0.35 +
        types.plainWeight * 0.25 +
        types.duneWeight * 0.65 +
        types.rockWeight * 2.10 +
        types.canyonWeight * 1.80
    );
    return n * regionalAmp;
}

// Композиция всех 4 геологических слоёв до постобработки
function getRawDesertHeight(x: number, z: number, outTypes?: TerrainTypeWeights): number {
    const r2 = x * x + z * z;
    const padInner = TERRAIN.spawnPadRadius;
    if (r2 <= padInner * padInner) {
        if (outTypes) {
            getTerrainTypeMap(x, z, outTypes);
        }
        return TERRAIN.spawnLevel;
    }

    getMacroWarpedCoords(x, z, _warpScratch);
    const wx = _warpScratch.wx;
    const wz = _warpScratch.wz;
    const macro = getMacroTerrain(x, z, _macroScratch, wx, wz);
    const types = getTerrainTypeMap(x, z, outTypes || _typesScratch, macro, wx, wz);
    const dir = getDuneOrientation(x, z, _orientScratch);

    const sandAndPlain = computeSandSeaAndPlains(x, z, types, dir);
    const dunes = computeDuneRegion(x, z, types, dir);
    const rockyHills = computeRockyHills(x, z, types, macro);
    const canyons = computeCanyonRegion(x, z, types);
    const localDetail = computeLocalDetail(x, z, types);

    // В зоне спавна региональные формы мягко затухают к спокойному песчаному полю
    const clearInner = TERRAIN.spawnClearRadius;
    const clearOuter = clearInner + TERRAIN.spawnClearFeather;
    const regionalFade = smoothstep(clearInner * clearInner, clearOuter * clearOuter, r2);
    const nearSandFade = smoothstep(padInner * padInner, clearInner * clearInner, r2);

    const combined =
        macro.elevation +
        sandAndPlain * nearSandFade +
        (dunes + rockyHills + canyons + localDetail) * regionalFade;

    // Мягкая компрессия экстремальных пиков без ступенчатого clamp-а
    const deltaFromSpawn = combined - TERRAIN.spawnLevel;
    const compressed = TERRAIN.spawnLevel + deltaFromSpawn / (
        1.0 + TERRAIN.heightCompression * Math.abs(deltaFromSpawn) / Math.max(1.0, TERRAIN.mountainBase)
    );

    const padOuter = padInner + TERRAIN.spawnPadFeather;
    const padBlend = smoothstep(padInner * padInner, padOuter * padOuter, r2);
    return TERRAIN.spawnLevel + (compressed - TERRAIN.spawnLevel) * padBlend;
}

// ---------------------------------------------------------------------------
// 5. POST-PROCESSING — селективное сглаживание, ограничение уклонов и эрозия
// ---------------------------------------------------------------------------
function getPostProcessedDesertHeight(x: number, z: number): number {
    const r2 = x * x + z * z;
    if (r2 <= TERRAIN.spawnPadRadius * TERRAIN.spawnPadRadius) {
        return TERRAIN.spawnLevel;
    }

    const h0 = getRawDesertHeight(x, z, _centerTypesScratch);
    const types = _centerTypesScratch;

    const eps = TERRAIN.smoothingRadius;
    const hE = getRawDesertHeight(x + eps, z);
    const hW = getRawDesertHeight(x - eps, z);
    const hN = getRawDesertHeight(x, z + eps);
    const hS = getRawDesertHeight(x, z - eps);

    const avg = 0.25 * (hE + hW + hN + hS);
    const diff = h0 - avg;

    // 1. Имитация ветровой и тепловой эрозии:
    // Находим слишком резкие выступы (diff > 0) и бугры, слегка срезаем их
    // и перераспределяем высоту к среднему уровню соседей; мелкие случайные ямки
    // на песчаных полях мягко засыпаются ветровым песком.
    let erodedH = h0;
    if (diff > 0.0) {
        const protrusionWeight = smoothstep(0.02, 0.35, diff);
        const erosionFactor = TERRAIN.erosionStrength * (1.0 - types.canyonWeight * 0.45);
        erodedH -= diff * protrusionWeight * erosionFactor;
    } else {
        const pitFillWeight = smoothstep(0.02, 0.30, -diff) * (types.sandWeight + types.plainWeight * 0.8);
        erodedH -= diff * pitFillWeight * (TERRAIN.erosionStrength * 0.65);
    }

    // 2. Селективное сглаживание по маскам типов местности:
    // - для песчаных полей и равнин — сильнее;
    // - для дюн — умеренно;
    // - для каменистых холмов — слабее;
    // - для каньонов — аккуратно (сохраняя выраженные стенки и кромки).
    const smoothWeight =
        types.sandWeight * TERRAIN.smoothingSand +
        types.plainWeight * TERRAIN.smoothingSand +
        types.duneWeight * TERRAIN.smoothingDune +
        types.rockWeight * TERRAIN.smoothingHill +
        types.canyonWeight * TERRAIN.smoothingCanyon;

    let smoothedH = erodedH + (avg - erodedH) * smoothWeight;

    // 3. Ограничение локальных перепадов (slope-aware clamp):
    // Крутые склоны допустимы в каньонах и на краях плато; в остальных местах
    // ландшафт остаётся пологим и естественным.
    const maxSlope =
        types.sandWeight * TERRAIN.maxSlopeSand +
        types.plainWeight * TERRAIN.maxSlopeSand +
        types.duneWeight * TERRAIN.maxSlopeDune +
        types.rockWeight * TERRAIN.maxSlopeHill +
        types.canyonWeight * TERRAIN.maxSlopeCanyon;

    const maxDelta = maxSlope * eps;
    const clampedDiff = Math.max(-maxDelta, Math.min(maxDelta, smoothedH - avg));
    smoothedH = avg + clampedDiff;

    // Повторное мягкое сопряжение со стартовой площадкой
    const padInner = TERRAIN.spawnPadRadius;
    const padOuter = padInner + TERRAIN.spawnPadFeather;
    const padBlend = smoothstep(padInner * padInner, padOuter * padOuter, r2);
    return TERRAIN.spawnLevel + (smoothedH - TERRAIN.spawnLevel) * padBlend;
}

let _erodeScratch = new Float32Array(0);
let _erodePeakBlend = new Float32Array(0);
let _erodeValleyBlend = new Float32Array(0);

// Сеточный проход селективного сглаживания и эрозии по карте высот чанка (CPU heightmap pass).
// Использует мировые высоты за кромкой чанка, поэтому соседние чанки стыкуются без швов,
// а локальная пупырчатость и резкие скачки между соседними вершинами дополнительно смягчаются.
export function smoothAndErodeHeightmap(
    heights: Float32Array,
    segments: number,
    originX: number,
    originZ: number,
    size: number,
    passes: number = 2
): void {
    if (passes <= 0) return;
    const n = segments + 1;
    const len = heights.length;
    const step = size / segments;
    const half = size * 0.5;
    const padR2 = (TERRAIN.spawnPadRadius + 2.0) * (TERRAIN.spawnPadRadius + 2.0);

    if (_erodeScratch.length < len) {
        _erodeScratch = new Float32Array(len);
        _erodePeakBlend = new Float32Array(len);
        _erodeValleyBlend = new Float32Array(len);
    }
    const scratch = _erodeScratch.subarray(0, len);

    // Предвычисляем региональные коэффициенты эрозии один раз для всех проходов
    for (let col = 1; col < segments; col++) {
        const worldX = originX + col * step - half;
        const colOffset = col * n;
        for (let row = 1; row < segments; row++) {
            const worldZ = originZ + row * step - half;
            const r2 = worldX * worldX + worldZ * worldZ;
            const idx = row + colOffset;
            if (r2 <= padR2) {
                _erodePeakBlend[idx] = 0;
                _erodeValleyBlend[idx] = 0;
                continue;
            }
            const types = getTerrainTypeMap(worldX, worldZ, _typesScratch);
            _erodePeakBlend[idx] = 0.22 * (1.0 - types.canyonWeight * 0.5);
            _erodeValleyBlend[idx] = 0.14 * (types.sandWeight + types.plainWeight + types.duneWeight * 0.5);
        }
    }

    for (let pass = 0; pass < passes; pass++) {
        scratch.set(heights);
        for (let col = 1; col < segments; col++) {
            const colOffset = col * n;
            const leftOffset = (col - 1) * n;
            const rightOffset = (col + 1) * n;
            for (let row = 1; row < segments; row++) {
                const idx = row + colOffset;
                const peakB = _erodePeakBlend[idx];
                if (peakB === 0 && _erodeValleyBlend[idx] === 0) continue;

                const hC = scratch[idx];
                const hL = scratch[row + leftOffset];
                const hR = scratch[row + rightOffset];
                const hD = scratch[(row - 1) + colOffset];
                const hU = scratch[(row + 1) + colOffset];
                const avg = 0.25 * (hL + hR + hD + hU);
                const diff = hC - avg;

                // Эрозионное смягчение локальных пиков с перераспределением высоты
                const erosionBlend = diff > 0.005 ? peakB : _erodeValleyBlend[idx];
                heights[idx] = hC - diff * erosionBlend;
            }
        }
    }
}

// Высота рельефа в мировых координатах (x, z). Все потребители — меш,
// Rapier, IK и пропсы — проходят через один и тот же профиль.
export function getDuneHeight(x: number, z: number): number {
    return getPostProcessedDesertHeight(x, z);
}

// Нормаль поверхности — резервный путь, когда физический луч Rapier не нашел
// пересечения, а также базис для ориентации скал и пропсов.
export function getDuneNormal(
    x: number,
    z: number,
    eps: number = 0.35,
    out?: THREE.Vector3
): THREE.Vector3 {
    const r2 = x * x + z * z;
    if (r2 <= TERRAIN.spawnPadRadius * TERRAIN.spawnPadRadius) {
        return out ? out.set(0, 1, 0) : new THREE.Vector3(0, 1, 0);
    }
    const hXPos = getDuneHeight(x + eps, z);
    const hXNeg = getDuneHeight(x - eps, z);
    const hZPos = getDuneHeight(x, z + eps);
    const hZNeg = getDuneHeight(x, z - eps);
    if (out) {
        return out.set(hXNeg - hXPos, 2.0 * eps, hZNeg - hZPos).normalize();
    }
    return new THREE.Vector3(hXNeg - hXPos, 2.0 * eps, hZNeg - hZPos).normalize();
}
