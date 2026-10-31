import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getDuneHeight,
    getDuneNormal,
    getMacroTerrain,
    getTerrainTypeMap,
    getBiomeWeights,
    getDuneOrientation,
    setTerrainSeed,
    getTerrainSeed,
    smoothAndErodeHeightmap
} from '../src/core/duneField.ts';
import { TERRAIN } from '../src/config.ts';

test('macro terrain stays finite and continuous across the desert world', () => {
    setTerrainSeed(TERRAIN.defaultSeed);
    let maxHalfStepDelta = 0;
    let minHeight = Number.POSITIVE_INFINITY;
    let maxHeight = Number.NEGATIVE_INFINITY;

    for (let x = -120; x <= 120; x += 2) {
        for (let z = -120; z <= 120; z += 2) {
            const h = getDuneHeight(x, z);
            const hx = getDuneHeight(x + 0.5, z);
            const hz = getDuneHeight(x, z + 0.5);

            assert.ok(Number.isFinite(h), `height must be finite at (${x}, ${z})`);
            minHeight = Math.min(minHeight, h);
            maxHeight = Math.max(maxHeight, h);
            maxHalfStepDelta = Math.max(maxHalfStepDelta, Math.abs(hx - h), Math.abs(hz - h));
        }
    }

    assert.ok(maxHeight - minHeight > 20, `terrain must contain both deep canyon/basin lowlands and broad upland relief, got range ${maxHeight - minHeight}`);
    assert.ok(maxHalfStepDelta < 6, `half-unit height changes must remain bounded, got ${maxHalfStepDelta}`);
});

test('terrain normals remain valid and normalized across all desert regions', () => {
    setTerrainSeed(TERRAIN.defaultSeed);
    for (const point of [[48, 26], [72, -38], [-64, 54], [96, 12], [-80, -70], [0, 0]]) {
        const normal = getDuneNormal(point[0], point[1]);
        assert.ok(Number.isFinite(normal.x) && Number.isFinite(normal.y) && Number.isFinite(normal.z));
        assert.ok(Math.abs(normal.length() - 1) < 1e-5, `normal must be normalized at ${point}`);
        assert.ok(normal.y > 0.35, `normal must point upward at ${point}, got y=${normal.y}`);
    }
});

test('terrain type map produces continuous normalized weights matching desert biome distribution', () => {
    setTerrainSeed(TERRAIN.defaultSeed);
    let sumSand = 0;
    let sumDune = 0;
    let sumPlain = 0;
    let sumRock = 0;
    let sumCanyon = 0;
    let count = 0;

    for (let x = -600; x <= 600; x += 30) {
        for (let z = -600; z <= 600; z += 30) {
            const types = getTerrainTypeMap(x, z);
            const biomes = getBiomeWeights(x, z);

            const total = types.sandWeight + types.duneWeight + types.plainWeight + types.rockWeight + types.canyonWeight;
            assert.ok(Math.abs(total - 1.0) < 1e-5, `terrain type weights must sum to 1, got ${total}`);

            const legacyTotal = biomes.erg + biomes.reg + biomes.mesa + biomes.classic;
            assert.ok(Math.abs(legacyTotal - 1.0) < 1e-5, `legacy biome weights must sum to 1, got ${legacyTotal}`);

            sumSand += types.sandWeight;
            sumDune += types.duneWeight;
            sumPlain += types.plainWeight;
            sumRock += types.rockWeight;
            sumCanyon += types.canyonWeight;
            count++;
        }
    }

    const avgSand = sumSand / count;
    const avgDune = sumDune / count;
    const avgPlain = sumPlain / count;
    const avgRock = sumRock / count;
    const avgCanyon = sumCanyon / count;

    // Песчаные моря — основа мира, далее регионы дюн, равнины, холмы и редкие каньоны
    assert.ok(avgSand > 0.32 && avgSand < 0.62, `sand sea share should dominate (~35-58%), got ${(avgSand * 100).toFixed(1)}%`);
    assert.ok(avgDune > 0.12 && avgDune < 0.32, `dune region share should be ~15-25%, got ${(avgDune * 100).toFixed(1)}%`);
    assert.ok(avgPlain > 0.08 && avgPlain < 0.26, `calm plain share should be ~10-20%, got ${(avgPlain * 100).toFixed(1)}%`);
    assert.ok(avgRock > 0.06 && avgRock < 0.22, `rocky hills share should be ~10-15%, got ${(avgRock * 100).toFixed(1)}%`);
    assert.ok(avgCanyon > 0.02 && avgCanyon < 0.14, `canyon share should be ~5-10%, got ${(avgCanyon * 100).toFixed(1)}%`);
});

test('seed determinism: same seed yields identical terrain, different seeds change geography and wind', () => {
    setTerrainSeed(4242);
    assert.equal(getTerrainSeed(), 4242);
    const sampleA = [
        getDuneHeight(85, -65),
        getDuneHeight(-110, 90),
        getMacroTerrain(120, -140).elevation,
        getTerrainTypeMap(90, 75).canyonWeight,
        getDuneOrientation(50, 50).angle
    ];

    setTerrainSeed(9876);
    const sampleB = [
        getDuneHeight(85, -65),
        getDuneHeight(-110, 90),
        getMacroTerrain(120, -140).elevation,
        getTerrainTypeMap(90, 75).canyonWeight,
        getDuneOrientation(50, 50).angle
    ];

    setTerrainSeed(4242);
    const sampleA2 = [
        getDuneHeight(85, -65),
        getDuneHeight(-110, 90),
        getMacroTerrain(120, -140).elevation,
        getTerrainTypeMap(90, 75).canyonWeight,
        getDuneOrientation(50, 50).angle
    ];

    assert.deepEqual(sampleA, sampleA2, 'identical seed must reproduce identical desert world');
    assert.notDeepEqual(sampleA, sampleB, 'different seed must generate different world geography');

    // Restore default seed for subsequent tests
    setTerrainSeed(TERRAIN.defaultSeed);
});

test('smoothAndErodeHeightmap softens interior spikes while preserving chunk boundary seams', () => {
    const segments = 16;
    const n = segments + 1;
    const heights = new Float32Array(n * n);
    heights.fill(2.0);

    // Искусственный острый пик внутри чанка и значение на кромке
    const centerIdx = 8 + 8 * n;
    const edgeIdx = 0 + 8 * n;
    heights[centerIdx] = 5.0;
    heights[edgeIdx] = 3.5;

    smoothAndErodeHeightmap(heights, segments, 60, 60, 30, 2);

    assert.equal(heights[edgeIdx], 3.5, 'chunk boundary vertices must remain unchanged to prevent seams');
    assert.ok(heights[centerIdx] < 5.0, 'interior spike must be softened by erosion pass');
    assert.ok(heights[centerIdx] > 2.0, 'feature height must not be flattened completely');
});

test('computeSoilWeightsAt produces bounded, spatially varied sand, reg gravel, takyr hardpan, and bedrock masks', async () => {
    const { computeSoilWeightsAt } = await import('../src/world/terrain.ts');
    setTerrainSeed(TERRAIN.defaultSeed);

    let maxBare = 0;
    let maxGravel = 0;
    let maxHardpan = 0;

    for (let x = -150; x <= 150; x += 15) {
        for (let z = -150; z <= 150; z += 15) {
            const h = getDuneHeight(x, z);
            const n = getDuneNormal(x, z);
            const slope = Math.hypot(n.x, n.z);
            const soil = computeSoilWeightsAt(x, z, h, slope, 0.04);

            assert.ok(soil.bareRock >= 0 && soil.bareRock <= 1, `bareRock out of range: ${soil.bareRock}`);
            assert.ok(soil.gravelReg >= 0 && soil.gravelReg <= 1, `gravelReg out of range: ${soil.gravelReg}`);
            assert.ok(soil.hardpanPlain >= 0 && soil.hardpanPlain <= 1, `hardpanPlain out of range: ${soil.hardpanPlain}`);

            maxBare = Math.max(maxBare, soil.bareRock);
            maxGravel = Math.max(maxGravel, soil.gravelReg);
            maxHardpan = Math.max(maxHardpan, soil.hardpanPlain);
        }
    }

    // Steep slope + high elevation must expose bare rock
    const cliffSoil = computeSoilWeightsAt(80, 80, 18.0, 0.92, 0.0);
    assert.ok(cliffSoil.bareRock > 0.5, `steep cliff must expose bare rock, got ${cliffSoil.bareRock}`);
    assert.ok(maxGravel > 0.35, `desert world must include stony gravel reg patches, got max ${maxGravel}`);
    assert.ok(maxHardpan > 0.20, `desert world must include cracked hardpan plains, got max ${maxHardpan}`);
});

