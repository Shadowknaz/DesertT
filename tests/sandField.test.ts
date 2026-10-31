// Инварианты активного поля песка: сохранение массы, поток через шов,
// диапазон уплотнения, осыпь и воспроизводимость одинаковых шагов.
// Поле не зависит ни от three, ни от Rapier, поэтому проверяется прямо в Node.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK, SANDFIELD } from '../src/config.ts';
import { chunkKeyOf } from '../src/core/chunkCoords.ts';
import { getDuneHeight } from '../src/core/duneField.ts';
import { createSandField } from '../src/world/sandField.ts';

function volume(rec) {
    let total = 0.0;
    for (let i = 0; i < rec.delta.length; i++) total += rec.delta[i];
    return total;
}

function attach(field, cx, cz) {
    field.attachChunk(cx, cz);
    return field.getRecord(chunkKeyOf(cx, cz));
}

test('воронка сохраняет объём внутри чанка', () => {
    const field = createSandField();
    const rec = attach(field, 0, 0);

    const before = volume(rec);
    field.stampCrater(2.0, 2.0, 1.05, 0.22, 0.12);

    assert.ok(Math.abs(volume(rec) - before) < 1e-4, 'масса в чанке изменилась');
});

test('отпечаток на шве не теряет массу', () => {
    const field = createSandField();
    const left = attach(field, 0, 0);
    const right = attach(field, -1, 0);

    const before = volume(left) + volume(right);
    field.stampCrater(-CHUNK.size * 0.5, 0.0, 1.05, 0.28, 0.12);

    const after = volume(left) + volume(right);
    assert.ok(Math.abs(after - before) < 1e-3, `на шве потеряно ${before - after} м3`);
});

test('ветер переносит песок через шов, а не теряет его', () => {
    const field = createSandField();
    const left = attach(field, 0, 0);
    const right = attach(field, 1, 0);

    // Гребень у подветренной кромки: валик воронки ложится на границу
    field.stampCrater(13.6, 0.0, 1.05, 0.6, 0.2);
    const before = volume(left) + volume(right);

    for (let i = 0; i < 6; i++) {
        field.update(1.0, { windX: 8.0, windZ: 0.0, erosionRate: 0.5 });
    }

    const after = volume(left) + volume(right);
    assert.ok(volume(right) > 0.0, 'песок не дошел до соседнего чанка');
    assert.ok(Math.abs(after - before) < 1e-3, `через шов потеряно ${before - after} м3`);
});

test('уплотнение переносится вместе с песком и остается в диапазоне', () => {
    const field = createSandField();
    const left = attach(field, 0, 0);
    const right = attach(field, 1, 0);

    field.stampCrater(13.6, 0.0, 1.05, 0.6, 0.3);
    for (let i = 0; i < 6; i++) {
        field.update(1.0, { windX: 8.0, windZ: 0.0, erosionRate: 0.5 });
    }

    let packed = 0.0;
    for (const rec of [left, right]) {
        for (let i = 0; i < rec.packing.length; i++) {
            const value = rec.packing[i];
            assert.ok(value >= 0.0 && value <= 1.0, `уплотнение вышло из 0..1: ${value}`);
            if (value > packed) packed = value;
        }
    }
    assert.ok(packed > 0.0, 'уплотнение не перенеслось вместе с песком');
});

test('осыпь выравнивает гребень и сохраняет массу', () => {
    const field = createSandField();
    const rec = attach(field, 0, 0);

    // Несколько воронок в одну точку: валик вырастает выше угла откоса
    for (let i = 0; i < 4; i++) field.stampCrater(4.0, 4.0, 1.05, 0.4, 0.0);

    const before = volume(rec);
    const peakBefore = maxDeltaNear(rec);
    field.update(3.0, {});

    assert.ok(Math.abs(volume(rec) - before) < 1e-4, 'осыпь изменила массу чанка');
    assert.ok(maxDeltaNear(rec) < peakBefore, 'гребень не осыпался');
});

test('просадка лапы останавливается на предельной глубине', () => {
    const field = createSandField();
    attach(field, 0, 0);

    for (let i = 0; i < 600; i++) {
        field.contact(0.0, 0.0, 1.05, 6000.0, SANDFIELD.footArea, 1 / 60);
    }

    const sink = -field.sampleDelta(0.0, 0.0);
    assert.ok(sink > 0.1, 'лапа почти не просела');
    assert.ok(sink <= SANDFIELD.maxSinkDepth + 0.05, `лапа провалилась на ${sink} м`);
});

test('одинаковые шаги дают одинаковое поле', () => {
    const a = createSandField();
    const b = createSandField();
    attach(a, 0, 0);
    attach(b, 0, 0);

    for (const field of [a, b]) {
        field.stampCrater(1.0, -2.0, 1.05, 0.3, 0.2);
        field.stampCrater(-6.0, 3.0, 1.05, 0.24, 0.2);
        field.update(0.3, { windX: 4.0, windZ: 1.0, erosionRate: 0.45 });
    }

    const left = a.getRecord(chunkKeyOf(0, 0));
    const right = b.getRecord(chunkKeyOf(0, 0));
    assert.deepEqual(Array.from(left.delta), Array.from(right.delta));
    assert.deepEqual(Array.from(left.packing), Array.from(right.packing));
});

test('sampling missing records returns zero without creating chunks', () => {
    const field = createSandField();
    for (const [x, z] of [[0, 0], [-45, -75], [15, 15]]) {
        assert.equal(field.sampleDelta(x, z), 0);
        assert.equal(field.samplePacking(x, z), 0);
        assert.equal(field.sampleHeight(x, z), getDuneHeight(x, z));
    }
    assert.equal(field.getStats().chunks, 0);
});

test('channels interpolate fractional grid coordinates in negative chunks', () => {
    const field = createSandField();
    const rec = attach(field, -2, -1);
    const n = CHUNK.gridSegments + 1;
    const cell = CHUNK.size / CHUNK.gridSegments;
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            rec.delta[row * n + col] = (col + row * 2) / 256 - 0.25;
            rec.packing[row * n + col] = (col * 2 + row) / 256;
        }
    }

    for (const [col, row] of [[0, 0], [12.25, 21.75], [63.5, 63.5]]) {
        const x = rec.originX - CHUNK.size * 0.5 + col * cell;
        const z = rec.originZ - CHUNK.size * 0.5 + row * cell;
        assert.ok(Math.abs(field.sampleDelta(x, z) - ((col + row * 2) / 256 - 0.25)) < 1e-12);
        assert.ok(Math.abs(field.samplePacking(x, z) - (col * 2 + row) / 256) < 1e-12);
    }
});

test('sampling selects the correct record at positive and negative chunk boundaries', () => {
    const field = createSandField();
    for (const [cx, delta, packing] of [[-1, 0.25, 0.25], [0, 0.5, 0.5], [1, -0.25, 0.75]]) {
        const rec = attach(field, cx, 0);
        rec.delta.fill(delta);
        rec.packing.fill(packing);
    }
    const half = CHUNK.size * 0.5;
    for (const [x, delta, packing] of [
        [-half - 1e-6, 0.25, 0.25],
        [-half, 0.5, 0.5],
        [half - 1e-6, 0.5, 0.5],
        [half, -0.25, 0.75]
    ]) {
        assert.equal(field.sampleDelta(x, 0), delta);
        assert.equal(field.samplePacking(x, 0), packing);
    }
});

test('contact returns post-operation packing, height, actual sink rate and traction', () => {
    const field = createSandField();
    attach(field, 0, 0);
    const before = field.sampleDelta(0, 0);
    const packing = field.samplePacking(0, 0);
    const dt = 1 / 60;
    const result = field.contact(0, 0, 1.05, 6000, SANDFIELD.footArea, dt);
    const after = field.sampleDelta(0, 0);

    assert.ok(after < before);
    assert.equal(result.supportY, getDuneHeight(0, 0) + after);
    assert.equal(result.sink, Math.max(0, -after));
    assert.equal(result.packing, field.samplePacking(0, 0));
    assert.ok(result.packing > packing);
    assert.equal(result.sinkStep, before - after);
    assert.equal(result.sinkRate, (before - after) / dt);
    assert.equal(result.traction, (SANDFIELD.gripLoose
        + (SANDFIELD.gripPacked - SANDFIELD.gripLoose) * result.packing) * 6000);
});

const CELL = CHUNK.size / CHUNK.gridSegments;
const N = CHUNK.gridSegments + 1;
const CENTER = (N * N - 1) / 2;
function close(actual, expected, tolerance = 1e-7) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

for (const preexisting of [false, true]) {
    test(`zero load/time leaves every channel and metadata unchanged (dirty=${preexisting})`, () => {
        const field = createSandField();
        const rec = attach(field, 0, 0);
        rec.packing.fill(0.75);
        rec.slipX.fill(0.25);
        rec.slipZ.fill(-0.5);
        if (preexisting) field.stampCrater(0, 0, 1.05, 0.1);
        const before = structuredClone(rec);
        const stats = field.getStats();
        const cases = [
            [undefined, 1 / 60], [null, 1 / 60], [0, 1 / 60], [-1, 1 / 60],
            [SANDFIELD.loadEpsilon, 1 / 60], [SANDFIELD.loadEpsilon / 2, 1 / 60],
            [6000, 0], [6000, -1], [NaN, 1 / 60], [6000, NaN]
        ];
        for (const [load, dt] of cases) {
            for (const [x, z] of [[0, 0], [14.9, 14.9], [100, -100]]) {
                const delta = field.sampleDelta(x, z);
                const packing = field.samplePacking(x, z);
                const result = field.contact(x, z, 1.05, load, SANDFIELD.footArea, dt, { x: 0.02, y: 0, z: -0.01 },
                    () => assert.fail('a no-op must not attempt a groove'));
                assert.equal(result.sinkRate, 0);
                assert.equal(result.sinkStep, 0);
                assert.equal(result.displaced, 0);
                assert.equal(result.packing, packing);
                assert.equal(result.supportY, getDuneHeight(x, z) + delta);
                assert.deepEqual(rec, before, `mutation for load=${load}, dt=${dt}`);
                assert.deepEqual(field.getStats(), stats, 'no new cache/dirty state');
            }
        }
    });
}

test('pressure never decompacts previously dense sand, including patch edges', () => {
    const field = createSandField();
    const rec = attach(field, 0, 0);
    rec.packing.fill(0.9);
    const before = new Float32Array(rec.packing);
    for (let i = 0; i < 30; i++) {
        const result = field.contact(0, 0, 1.05, 100, SANDFIELD.footArea, 0.1);
        assert.equal(result.packing, before[CENTER]);
        assert.equal(result.sinkRate, 0);
    }
    assert.deepEqual(rec.packing, before);
    assert.equal(rec.touched, false);
    assert.equal(field.getStats().dirty, 0);
});

test('bearing pressure uses N/A without an area floor and compacts exactly once', () => {
    for (const [packing, pressure, dt] of [[0, 400, 0.1], [0, 740, 0.1], [0.5, 2040, 0.1], [0, 6000, 0.1]]) {
        const field = createSandField();
        const rec = attach(field, 0, 0);
        rec.packing.fill(packing);
        const area = 0.1;
        const result = field.contact(0, 0, 1.05, pressure * area, area, dt);
        const speed = Math.min(0.40, Math.max(0, pressure - (520 + 2600 * packing)) / 2200);
        close(result.pressure, pressure);
        close(result.sinkRate, speed, 1e-6);
        const target = Math.min(1, pressure / 3120);
        const expectedPacking = Math.fround(packing + Math.min(0.5, 0.30 * dt) * Math.max(0, target - packing));
        assert.equal(result.packing, expectedPacking);
    }
});

test('actual sink stops at the depth limit and accounts for descending raised sand', () => {
    for (const initial of [-SANDFIELD.maxSinkDepth, -SANDFIELD.maxSinkDepth + 0.001, 0.12]) {
        const field = createSandField();
        const rec = attach(field, 0, 0);
        rec.delta[CENTER] = initial;
        const before = field.sampleDelta(0, 0);
        const dt = 0.1;
        const result = field.contact(0, 0, 1.05, 6000, SANDFIELD.footArea, dt);
        const after = field.sampleDelta(0, 0);
        close(result.sinkStep, Math.min(Math.max(0, SANDFIELD.maxSinkDepth + before), dt * 0.40));
        assert.equal(result.sinkRate, Math.max(0, before - after) / dt);
        assert.equal(result.sink, Math.max(0, -after));
        assert.equal(result.packing, field.samplePacking(0, 0));
        assert.ok(after >= -SANDFIELD.maxSinkDepth - 1e-7);
        if (initial > 0) {
            assert.equal(result.sink, 0);
            assert.ok(result.sinkRate > 0, 'travel on a rim is still real downward travel');
        } else assert.ok(result.sinkRate < 0.02, 'must not report the requested 0.40 m/s');
    }
});

// This radius has one interior node and eight rim nodes: independent requests
// are easy to compute without using any production crater internals.
function limitedRim(field, mode) {
    const rec = attach(field, 0, 0);
    const radius = CELL / 0.75;
    const rim = [];
    for (let row = -1; row <= 1; row++) for (let col = -1; col <= 1; col++) {
        if (row === 0 && col === 0) continue;
        const index = CENTER + row * N + col;
        const dist = Math.hypot(row, col) * CELL / radius;
        const weight = Math.sin((dist - 0.72) / (1.18 - 0.72) * Math.PI);
        rec.delta[index] = SANDFIELD.maxDelta;
        rim.push({ index, weight });
    }
    if (mode === 'partial') {
        rec.delta[CENTER + 1] = SANDFIELD.maxDelta - 0.001;
        rec.delta[CENTER - 1] = 0;
    }
    return { rec, radius, rim };
}

test('saturated rim deposits clipped requests once and preserves displaced field volume', () => {
    const field = createSandField();
    const { rec, radius, rim } = limitedRim(field, 'partial');
    const before = new Float32Array(rec.delta);
    const requestedRemoval = 0.4;
    const weightSum = rim.reduce((sum, node) => sum + node.weight, 0);
    const deposits = rim.map(node => Math.min(requestedRemoval * node.weight / weightSum,
        Math.max(0, SANDFIELD.maxDelta - before[node.index])));
    const D = deposits.reduce((sum, amount) => sum + amount, 0);
    assert.ok(D > 0 && D < requestedRemoval * 0.5, 'fixture must severely limit capacity');
    const displaced = field.stampCrater(0, 0, radius, requestedRemoval, 0.1);
    rim.forEach((node, i) => close(rec.delta[node.index] - before[node.index], deposits[i]));
    close(before[CENTER] - rec.delta[CENTER], D);
    close(displaced, (before[CENTER] - rec.delta[CENTER]) * CELL * CELL);
    const netVolume = rec.delta.reduce((sum, value, i) => sum + (value - before[i]) * CELL * CELL, 0);
    close(netVolume, 0, 1e-8);
    assert.ok(rec.packing[CENTER] > 0, 'volume conservation does not assume fixed density');
    for (let i = 0; i < 40; i++) field.stampCrater(0, 0, radius, requestedRemoval);
    close(rec.delta.reduce((sum, value, i) => sum + (value - before[i]) * CELL * CELL, 0), 0, 2e-7);
});

for (const mode of ['full', 'partial']) {
    test(`contact reports actual movement with ${mode} rim capacity`, () => {
        const field = createSandField();
        const { rec, radius } = limitedRim(field, mode);
        const before = new Float32Array(rec.delta);
        const dt = 0.1;
        const result = field.contact(0, 0, radius, 6000, SANDFIELD.footArea, dt);
        const achieved = before[CENTER] - rec.delta[CENTER];
        close(result.sinkRate, achieved / dt);
        close(result.displaced, achieved * CELL * CELL);
        assert.ok(result.sinkRate < SANDFIELD.maxSinkRate * 0.2);
        assert.equal(result.packing, rec.packing[CENTER]);
        assert.ok(result.packing > 0, 'pressure may compact even when the rim cannot accept sand');
        if (mode === 'full') {
            assert.deepEqual(rec.delta, before);
            assert.equal(result.sinkRate, 0);
            assert.equal(field.getStats().dirty, 0);
        } else assert.ok(achieved > 0);
    });
}

test('off-grid contact reports interpolated movement, not requested crater depth', () => {
    const field = createSandField();
    attach(field, 0, 0);
    const x = CELL * 0.5;
    const z = CELL * 0.5;
    const before = field.sampleDelta(x, z);
    const dt = 0.1;
    const result = field.contact(x, z, 1.05, 6000, SANDFIELD.footArea, dt);
    const after = field.sampleDelta(x, z);
    assert.ok(result.sinkRate > 0 && result.sinkRate < 0.40 * 0.9);
    assert.equal(result.sinkRate, (before - after) / dt);
    assert.equal(result.packing, field.samplePacking(x, z));
    const weight = Math.cos((Math.hypot(x, z) / 1.05) * Math.PI / 2);
    close(result.packing, 0.30 * dt * weight);
});

test('zero removal and zero rim capacity do not mark a crater dirty', () => {
    for (const bottomFull of [false, true]) {
        const field = createSandField();
        const { rec, radius } = limitedRim(field, 'full');
        if (bottomFull) rec.delta[CENTER] = -SANDFIELD.maxDelta;
        const before = structuredClone(rec);
        assert.equal(field.stampCrater(0, 0, radius, 0.4, 0.2), 0);
        assert.deepEqual(rec, { ...before, used: rec.used });
        assert.equal(field.getStats().dirty, 0);
    }
});

test('groove and shear use the achieved 3D displacement on its actual segment', () => {
    const field = createSandField();
    const expected = createSandField();
    const rec = attach(field, 0, 0);
    const expectedRec = attach(expected, 0, 0);
    const x = 1.2, z = -2.3, dt = 1 / 60, radius = 1.05;
    const displacement = { x: 0.018, y: 0.004, z: -0.009 };
    const speed = Math.hypot(displacement.x, displacement.y, displacement.z) / dt;
    const depth = (speed - SANDFIELD.slipScourThreshold) * SANDFIELD.slipScourGain * dt;
    const visited = [];
    field.contact(x, z, radius, 100, SANDFIELD.footArea, dt, displacement,
        (px, pz) => { visited.push([px, pz]); return true; });
    expected.stampCrater(x - displacement.x * 0.5, z - displacement.z * 0.5, radius * 0.8, depth, 0);
    assert.deepEqual(rec.delta, expectedRec.delta, 'stamp lies midway along achieved movement, not ahead');
    assert.deepEqual(visited, [[x, z], [x - displacement.x / 2, z - displacement.z / 2],
        [x - displacement.x, z - displacement.z]]);
    const index = Math.round((z + CHUNK.size / 2) / CELL) * N + Math.round((x + CHUNK.size / 2) / CELL);
    close(rec.slipX[index], displacement.x / dt);
    close(rec.slipZ[index], displacement.z / dt);
    const after = new Float32Array(rec.delta);
    field.contact(x, z, radius, 100, SANDFIELD.footArea, dt);
    assert.deepEqual(rec.delta, after, 'no new displacement means no repeated groove');
    assert.equal(rec.slipX[index], 0);
    assert.equal(rec.slipZ[index], 0);
});

test('material veto and invalid/zero displacement cannot excavate a groove', () => {
    for (const displacement of [null, { x: 0, y: 0, z: 0 }, { x: NaN, y: 0, z: 0 }, { x: 0.02, y: 0, z: 0 }]) {
        const field = createSandField();
        const rec = attach(field, 0, 0);
        field.contact(0, 0, 1.05, 100, SANDFIELD.footArea, 1 / 60, displacement, () => false);
        assert.ok(rec.delta.every(value => value === 0));
        assert.equal(field.getStats().dirty, 0);
        assert.ok(rec.packing.some(value => value > 0), 'exposed stance pressure is independent of the groove');
    }
});

// Пик насыпного песка в чанке: именно он осыпается первым.
function maxDeltaNear(rec) {
    let peak = 0.0;
    for (let i = 0; i < rec.delta.length; i++) {
        if (rec.delta[i] > peak) peak = rec.delta[i];
    }
    return peak;
}
