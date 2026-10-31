import test from 'node:test';
import assert from 'node:assert/strict';
import { getDuneHeight, getDuneNormal } from '../src/core/duneField.ts';

test('macro terrain stays finite and continuous across the mountain field', () => {
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

    assert.ok(maxHeight - minHeight > 20, 'terrain must contain both broad lowlands and high mountain relief');
    assert.ok(maxHalfStepDelta < 6, `half-unit height changes must remain bounded, got ${maxHalfStepDelta}`);
});

test('terrain normals remain valid on mountain slopes', () => {
    for (const point of [[48, 26], [72, -38], [-64, 54], [96, 12]]) {
        const normal = getDuneNormal(point[0], point[1]);
        assert.ok(Number.isFinite(normal.x) && Number.isFinite(normal.y) && Number.isFinite(normal.z));
        assert.ok(Math.abs(normal.length() - 1) < 1e-5, `normal must be normalized at ${point}`);
    }
});
