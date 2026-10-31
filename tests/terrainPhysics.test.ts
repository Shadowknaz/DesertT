// Физический рельеф чанка обязан следовать за локальной деформацией песка:
// виртуальные лапы и меш уже видят воронку, а корпус и обломки до сих пор
// сталкивались со старым heightfield.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { CHUNK, SANDFIELD } from '../src/config.ts';
import { getDuneNormal } from '../src/core/duneField.ts';
import { createPhysicsWorld, RAPIER } from '../src/world/physics.ts';
import { createChunkTerrain } from '../src/world/terrain.ts';
import { chunkKeyOf } from '../src/core/chunkCoords.ts';
import { createSandField } from '../src/world/sandField.ts';
import { copyGroundSample, createGroundSampler } from '../src/world/groundSampler.ts';
import { createSandDeformer } from '../src/world/sandDeformation.ts';

async function makeChunk() {
    const world = await createPhysicsWorld();
    const scene = new THREE.Scene();
    const material = new THREE.MeshBasicMaterial();
    const terrain = createChunkTerrain({
        scene,
        world,
        cx: 0,
        cz: 0,
        sandMaterial: material,
        skirtMaterial: material,
        frameMaterial: material,
        frameGeometry: new THREE.BoxGeometry(1, 1, 1)
    });

    // Broad-phase строится на шаге мира: до него лучи не видят коллайдеры.
    world.step();
    return { world, terrain };
}

function attachTrackedChunk(t, field, deformer, cx, cz, calls = []) {
    const key = chunkKeyOf(cx, cz);
    const geometry = new THREE.PlaneGeometry(CHUNK.size, CHUNK.size, CHUNK.gridSegments, CHUNK.gridSegments);
    geometry.rotateX(-Math.PI * 0.5);
    t.after(() => geometry.dispose());
    const syncPhysics = t.mock.fn(delta => calls.push({ key, delta }));
    deformer.attachChunk(key, geometry, cx * CHUNK.size, cz * CHUNK.size, { syncPhysics });
    syncPhysics.mock.resetCalls();
    return { key, syncPhysics, record: field.getRecord(key) };
}

test('explicit synchronization updates physics before the visual mesh flush', async t => {
    const { world, terrain } = await makeChunk();
    t.after(() => {
        terrain.dispose();
        world.free();
    });
    const field = createSandField();
    const deformer = createSandDeformer({ field });
    deformer.attachChunk(chunkKeyOf(0, 0), terrain.sandGeometry, 0, 0, terrain);
    const before = groundAt(world, 3, -2);
    const vertices = new Float32Array(terrain.positionAttribute.array);

    field.stampCrater(3, -2, 1.05, 0.35);
    deformer.syncPhysicsAt(3, -2);
    world.step();
    const after = groundAt(world, 3, -2);
    assert.notEqual(before, null);
    assert.notEqual(after, null);
    assert.ok(after < before - 0.1);
    assert.deepEqual(terrain.positionAttribute.array, vertices);
});

test('synchronization visits neighboring chunks in the same order at a negative corner', t => {
    const field = createSandField();
    const deformer = createSandDeformer({ field });
    const calls = [];
    const records = [[-1, -1], [-1, 0], [0, -1], [0, 0], [1, 0]].map(([cx, cz]) =>
        attachTrackedChunk(t, field, deformer, cx, cz, calls));
    for (let i = 0; i < records.length; i++) records[i].record.delta.fill((i + 1) * 0.1);
    calls.length = 0;

    const half = CHUNK.size * 0.5;
    deformer.syncPhysicsAt(-half, -half, 1.2);
    assert.deepEqual(calls.map(call => call.key), records.slice(0, 4).map(rec => rec.key));
    for (let i = 0; i < 4; i++) {
        assert.equal(calls[i].delta, records[i].record.delta);
        assert.equal(records[i].syncPhysics.mock.callCount(), 1);
    }
    assert.equal(records[4].syncPhysics.mock.callCount(), 0);
});

test('synchronization keeps the default radius and accepts an explicit zero radius', t => {
    const field = createSandField();
    const deformer = createSandDeformer({ field });
    const left = attachTrackedChunk(t, field, deformer, 0, 0);
    const right = attachTrackedChunk(t, field, deformer, 1, 0);
    const x = CHUNK.size * 0.5 + 0.5;

    deformer.syncPhysicsAt(x, 0);
    assert.equal(left.syncPhysics.mock.callCount(), 1);
    assert.equal(right.syncPhysics.mock.callCount(), 1);
    left.syncPhysics.mock.resetCalls();
    right.syncPhysics.mock.resetCalls();
    deformer.syncPhysicsAt(x, 0, 0);
    assert.equal(left.syncPhysics.mock.callCount(), 0);
    assert.equal(right.syncPhysics.mock.callCount(), 1);
});

test('synchronization skips detached chunks even when their sand record is cached', t => {
    const field = createSandField();
    const deformer = createSandDeformer({ field });
    const detached = attachTrackedChunk(t, field, deformer, 0, 0);
    const attached = attachTrackedChunk(t, field, deformer, 1, 0);
    detached.record.touched = true;
    deformer.detachChunk(detached.key);
    assert.equal(field.getRecord(detached.key), detached.record);

    deformer.syncPhysicsAt(CHUNK.size * 0.5, 0);
    assert.equal(detached.syncPhysics.mock.callCount(), 0);
    assert.equal(attached.syncPhysics.mock.callCount(), 1);
});

test('real upper colliders own material and friction across sand/solid transitions', async t => {
    const { world, terrain } = await makeChunk();
    t.after(() => { terrain.dispose(); world.free(); });
    const field = createSandField();
    const deformer = createSandDeformer({ field });
    deformer.attachChunk(chunkKeyOf(0, 0), terrain.sandGeometry, 0, 0, terrain);
    const rec = field.getRecord(chunkKeyOf(0, 0));
    rec.packing.fill(0.75);
    const sampler = createGroundSampler({ world, sandField: field });
    const shared = sampler.sample(0, 0);
    const sand = copyGroundSample(shared);
    assert.equal(sand.surfaceType, 'sand');
    assert.notEqual(sand.colliderHandle, null, 'must select the real heightfield');
    assert.equal(sand.packing, 0.75);
    assert.equal(sand.friction, SANDFIELD.gripLoose + (SANDFIELD.gripPacked - SANDFIELD.gripLoose) * 0.75);
    assert.notEqual(sand.normal, shared.normal);

    // Same solid shapes and coefficients as props.js, with no invented tags.
    const stone = world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 1)
        .setTranslation(0, sand.y + 1, 0).setFriction(0.9));
    const debrisBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, sand.y + 3, 0));
    const debris = world.createCollider(RAPIER.ColliderDesc.ball(0.4)
        .setMass(1.8).setFriction(0.95), debrisBody);
    world.step();
    const top = copyGroundSample(sampler.sample(0, 0));
    assert.equal(top.surfaceType, 'solid');
    assert.equal(top.colliderHandle, debris.handle, 'uppermost solid wins');
    assert.equal(top.friction, debris.friction());
    assert.equal(top.packing, 0);
    assert.equal(top.sink, 0);
    assert.ok(top.y > sand.y + 2);

    world.removeRigidBody(debrisBody);
    world.step();
    const rock = copyGroundSample(sampler.sample(0, 0));
    assert.equal(rock.colliderHandle, stone.handle);
    assert.equal(rock.surfaceType, 'solid');
    assert.equal(rock.friction, stone.friction());
    // Underlying sand may change independently, but not the selected material.
    field.stampCrater(0, 0, 1.05, 0.2, 0.2);
    deformer.syncPhysicsAt(0, 0);
    world.step();
    assert.deepEqual(copyGroundSample(sampler.sample(0, 0)), rock);
    stone.setFriction(0.37);
    assert.equal(sampler.sample(0, 0).friction, stone.friction(), 'read live collider friction');

    world.removeCollider(stone, true);
    world.step();
    const restored = copyGroundSample(sampler.sample(0, 0));
    assert.equal(restored.surfaceType, 'sand');
    assert.equal(restored.colliderHandle, sand.colliderHandle, 'shape sync preserves collider identity');
    assert.equal(restored.y, field.sampleHeight(0, 0));
    assert.equal(restored.packing, field.samplePacking(0, 0));
    assert.ok(restored.sink > 0);
    assert.equal(restored.friction, SANDFIELD.gripLoose
        + (SANDFIELD.gripPacked - SANDFIELD.gripLoose) * restored.packing);

    const outside = sampler.sample(CHUNK.size * 10, CHUNK.size * 10);
    assert.equal(outside, shared, 'sampler intentionally reuses its output');
    assert.equal(outside.surfaceType, 'sand');
    assert.equal(outside.colliderHandle, null);
    assert.equal(outside.packing, 0);
    assert.equal(outside.friction, SANDFIELD.gripLoose);
    assert.equal(sand.packing, 0.75, 'retained full snapshot must not follow later samples');
    assert.equal(rock.friction, Math.fround(0.9));
    assert.equal(top.colliderHandle, debris.handle);
    const saved = copyGroundSample(restored);
    copyGroundSample(outside, restored);
    assert.notEqual(saved.normal, restored.normal);
    assert.ok(saved.sink > 0);
    assert.equal(restored.sink, 0);
});

for (const physical of [false, true]) {
    test(`deformation gradient affects the normal at delta zero (heightfield=${physical})`, async t => {
        const { world, terrain } = physical ? await makeChunk() : { world: await createPhysicsWorld() };
        t.after(() => { if (terrain) terrain.dispose(); world.free(); });
        const field = createSandField();
        const rec = field.attachChunk(0, 0);
        const cell = CHUNK.size / CHUNK.gridSegments;
        const n = CHUNK.gridSegments + 1;
        for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
            const x = col * cell - CHUNK.size / 2;
            const z = row * cell - CHUNK.size / 2;
            rec.delta[row * n + col] = 0.02 * x - 0.01 * z;
        }
        if (terrain) { terrain.syncPhysics(rec.delta); world.step(); }
        const sampler = createGroundSampler({ world, sandField: field });
        const base = getDuneNormal(0, 0).clone();
        const expected = new THREE.Vector3(-(-base.x / base.y + 0.02), 1,
            -(-base.z / base.y - 0.01)).normalize();
        assert.equal(field.sampleDelta(0, 0), 0);
        const sample = sampler.sample(0, 0);
        assert.equal(sample.surfaceType, 'sand');
        assert.equal(sample.colliderHandle === null, !physical);
        assert.ok(sample.normal.distanceTo(expected) < 1e-7);
        assert.ok(sample.normal.distanceTo(base) > 0.01, 'zero delta must not discard a nonzero gradient');
    });
}

function groundAt(world, x, z) {
    const ray = new RAPIER.Ray({ x, y: 40.0, z }, { x: 0.0, y: -1.0, z: 0.0 });
    const hit = world.castRay(ray, 80.0, true);
    return hit ? 40.0 - hit.toi : null;
}

test('деформация песка переносится в физический heightfield', async () => {
    const { world, terrain } = await makeChunk();
    const before = groundAt(world, 2.3, -1.7);
    assert.ok(before !== null, 'луч не попал в рельеф');

    const count = terrain.positionAttribute.count;
    const delta = new Float32Array(count);
    delta.fill(0.5);
    assert.equal(terrain.syncPhysics(delta), true);

    const after = groundAt(world, 2.3, -1.7);
    assert.ok(Math.abs(after - before - 0.5) < 1e-3,
        `высотное поле не поднялось: ${before.toFixed(2)} -> ${after.toFixed(2)}`);

    // Возврат к нулевому смещению должен вернуть исходный рельеф.
    terrain.syncPhysics(new Float32Array(count));
    const restored = groundAt(world, 2.3, -1.7);
    assert.ok(Math.abs(restored - before) < 1e-3,
        `высотное поле не вернулось: ${restored.toFixed(2)} вместо ${before.toFixed(2)}`);
});

test('синхронизированный heightfield не удваивает воронку в пробе грунта', async () => {
    const { world, terrain } = await makeChunk();
    const field = createSandField();
    field.attachChunk(0, 0);
    field.stampCrater(2.0, 2.0, 1.05, 0.3, 0.14);

    const sampler = createGroundSampler({
        world,
        mechBodies: [],
        ignoredBodyHandles: new Set(),
        sandField: field
    });

    const before = sampler.sample(2.0, 2.0).y;

    // Теперь тот же сдвиг уходит в физический heightfield.
    const record = field.getRecord(chunkKeyOf(0, 0));
    assert.equal(terrain.syncPhysics(record.delta), true);
    world.step();

    const after = sampler.sample(2.0, 2.0).y;
    assert.ok(Math.abs(after - before) < 1e-6,
        `воронка учтена дважды: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
});

test('отпечаток лапы доходит до heightfield через deformer', async () => {
    const { world, terrain } = await makeChunk();
    const field = createSandField();
    const deformer = createSandDeformer({ field });
    deformer.attachChunk(chunkKeyOf(0, 0), terrain.sandGeometry, 0, 0, terrain);

    const before = groundAt(world, 3.0, -2.0);
    assert.ok(before !== null, 'луч не попал в рельеф');

    deformer.stampFootprint({ x: 3.0, z: -2.0 }, 1.05, 0.35);
    // Коллайдер обновляется отпечатком сразу, без бюджета мешей.
    world.step();

    const after = groundAt(world, 3.0, -2.0);
    assert.ok(after !== null, 'луч не попал в рельеф');
    assert.ok(after < before - 0.1,
        `воронка не дошла до коллайдера: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
});

test('наклон смещения идет по той же оси, что и у меша', async () => {
    const { world, terrain } = await makeChunk();
    const count = terrain.positionAttribute.count;
    const delta = new Float32Array(count);

    // Наклон вдоль локального X: он должен поднять восточную кромку,
    // а не северную. Перепутанная транспонировка дала бы наклон по Z.
    const position = terrain.positionAttribute;
    for (let i = 0; i < count; i++) {
        delta[i] = position.getX(i) * 0.02;
    }
    terrain.syncPhysics(delta);

    const east = groundAt(world, 5.0, 0.0);
    const north = groundAt(world, 0.0, 5.0);
    assert.ok(east !== null && north !== null, 'луч не попал в рельеф');

    // Аналитический рельеф на этих точках разный, поэтому проверяем
    // именно разницу смещений через повторный ноль.
    terrain.syncPhysics(new Float32Array(count));
    const eastZero = groundAt(world, 5.0, 0.0);
    const northZero = groundAt(world, 0.0, 5.0);

    assert.ok(Math.abs((east - eastZero) - 0.1) < 0.02,
        `восточная кромка поднялась на ${(east - eastZero).toFixed(3)} м`);
    assert.ok(Math.abs(north - northZero) < 0.02,
        `северная кромка поднялась на ${(north - northZero).toFixed(3)} м`);
});
