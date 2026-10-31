// Тесты террамеханики: модель Беккера давление-просадка, формула сдвига
// Яноси–Ханамото, несущая способность Терцаги и классификация грунтов.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SOIL_MATERIALS,
    bekkerSinkage,
    bekkerPressure,
    computeUltimateBearingCapacity,
    janosiShearStress,
    janosiFrictionCoefficient,
    computeBulldozingResistance,
    classifySoilMaterial,
    getInterpolatedSandProperties
} from '../src/world/terramechanics.ts';

test('классификация грунтов различает сыпучий, уплотненный, плотный слой, камень и скалу', () => {
    const loose = classifySoilMaterial(0.1, 0.05, false, 0.1, 2.0);
    assert.equal(loose.id, 'loose_sand', 'малое уплотнение должно быть loose_sand');

    const compacted = classifySoilMaterial(0.5, 0.08, false, 0.1, 2.0);
    assert.equal(compacted.id, 'compacted_sand', 'среднее уплотнение должно быть compacted_sand');

    const dense = classifySoilMaterial(0.85, 0.25, false, 0.1, 2.0);
    assert.equal(dense.id, 'dense_layer', 'высокое уплотнение должно быть dense_layer');

    const stone = classifySoilMaterial(0.0, 0.0, true, 0.0, 0.0);
    assert.equal(stone.id, 'stone', 'твердый объект должен быть stone');

    const cliff = classifySoilMaterial(0.2, 0.05, false, 0.75, 12.0);
    assert.equal(cliff.id, 'bedrock', 'крутой склон или высота должна быть bedrock');
});

test('интерполяция свойств песка дает непрерывный переход характеристик', () => {
    const p0 = getInterpolatedSandProperties(0.0);
    const pMid = getInterpolatedSandProperties(0.5);
    const p1 = getInterpolatedSandProperties(1.0);

    assert.ok(pMid.cohesion > p0.cohesion, 'сцепление растет с уплотнением');
    assert.ok(p1.cohesion >= pMid.cohesion, 'сцепление достигает максимума');
    assert.ok(pMid.frictionAngleDeg >= p0.frictionAngleDeg, 'угол трения растет');
    assert.ok(pMid.bearingCapacityBase > p0.bearingCapacityBase, 'несущая способность растет');
});

test('давление-просадка по Беккеру монотонно возрастает с нагрузкой', () => {
    const mat = SOIL_MATERIALS.loose_sand;
    const width = 0.8;

    const z1 = bekkerSinkage(2000, width, mat);
    const z2 = bekkerSinkage(8000, width, mat);
    const z3 = bekkerSinkage(25000, width, mat);

    assert.ok(z1 > 0, 'просадка должна быть положительной');
    assert.ok(z2 > z1, 'просадка растет с давлением');
    assert.ok(z3 > z2, 'просадка растет дальше');
    assert.ok(z3 <= mat.maxSinkDepth, 'просадка не превышает предельный слой');

    // Проверка взаимности bekkerPressure и bekkerSinkage
    const pCalc = bekkerPressure(z1, width, mat);
    assert.ok(Math.abs(pCalc - 2000) < 50, `давление восстанавливается: ${pCalc} vs 2000`);
});

test('большая площадь подошвы существенно снижает просадку при равной нагрузке', () => {
    const mat = SOIL_MATERIALS.loose_sand;
    const load = 6000; // Ньютон
    const areaNarrow = 0.3 * 0.3;
    const areaWide = 0.8 * 0.8;

    const zNarrow = bekkerSinkage(load / areaNarrow, 0.3, mat);
    const zWide = bekkerSinkage(load / areaWide, 0.8, mat);

    assert.ok(zNarrow > zWide * 5.0, `узкая лапа тонет значительно глубже (${zNarrow.toFixed(3)} > ${zWide.toFixed(3)})`);
});

test('касательное напряжение Яноси-Ханамото стремится к tauMax с ростом сдвига', () => {
    const mat = SOIL_MATERIALS.compacted_sand;
    const p = 10000; // Па

    const tau0 = janosiShearStress(0, p, mat);
    const tauSmall = janosiShearStress(0.005, p, mat);
    const tauLarge = janosiShearStress(0.25, p, mat);

    assert.equal(tau0, 0, 'при нулевом сдвиге касательное напряжение равно 0');
    assert.ok(tauSmall > 0, 'малый сдвиг создает напряжение');
    assert.ok(tauLarge > tauSmall, 'больший сдвиг мобилизует больше сцепления');

    // При большом сдвиге e^(-j/K) ~ 0 => tau ~ c + p*tan(phi)
    const phiRad = mat.frictionAngleDeg * (Math.PI / 180);
    const tauTheoreticalMax = mat.cohesion + p * Math.tan(phiRad);
    assert.ok(Math.abs(tauLarge - tauTheoreticalMax) / tauTheoreticalMax < 0.05,
        `напряжение мобилизовано до максимума: ${tauLarge} vs ${tauTheoreticalMax}`);
});

test('сопротивление бульдозирования растет квадратично с глубиной погружения', () => {
    const mat = SOIL_MATERIALS.loose_sand;
    const width = 0.8;

    const f1 = computeBulldozingResistance(0.04, width, mat);
    const f2 = computeBulldozingResistance(0.12, width, mat);

    assert.ok(f1 > 0, 'сопротивление должно быть ненулевым');
    assert.ok(f2 > f1 * 2.5, 'сопротивление возрастает нелинейно с глубиной');
});

test('несущая способность по Терцаги выше для плотных грунтов', () => {
    const qLoose = computeUltimateBearingCapacity(SOIL_MATERIALS.loose_sand, 0.8);
    const qDense = computeUltimateBearingCapacity(SOIL_MATERIALS.dense_layer, 0.8);

    assert.ok(qDense > qLoose * 2.0, `плотный песок держит значительно больше (${qDense} vs ${qLoose})`);
});
