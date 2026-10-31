import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CHUNK, DUST } from '../src/config.ts';
import { getDuneHeight } from '../src/core/duneField.ts';
import { createDustSystem } from '../src/world/dustParticles.ts';

function createDustHarness(t, windAt = null) {
    const scene = new THREE.Scene();
    const system = createDustSystem({ scene, windAt });
    const mesh = scene.children.find(child => child.isInstancedMesh);
    t.after(() => {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
    });
    return { system, mesh };
}

function instance(mesh, index) {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    mesh.getMatrixAt(index, matrix);
    matrix.decompose(position, new THREE.Quaternion(), scale);
    return { position, scale };
}

function visibleCount(mesh) {
    let count = 0;
    for (let i = 0; i < mesh.count; i++) {
        if (instance(mesh, i).position.y !== -100) count++;
    }
    return count;
}

function ambientRate(weather = null) {
    const a = DUST.ambient;
    return a.baseRate + a.intensityRate * (weather ? weather.intensity : a.fallbackIntensity)
        + a.gustRate * (weather ? weather.gust : 0);
}

function near(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`);
}

test('ambient dust preserves its fallback profile and fractional emission budget', t => {
    const { system, mesh } = createDustHarness(t);
    const random = t.mock.method(Math, 'random', () => 0.5);
    const focus = new THREE.Vector3(2, 0, -3);
    const a = DUST.ambient;
    const dt = 0.55 / ambientRate();

    system.updateAmbient(focus, dt, null);
    system.update(0);
    assert.equal(visibleCount(mesh), 0);
    assert.equal(random.mock.callCount(), 0);
    system.updateAmbient(focus, dt, null);
    system.update(0);
    assert.equal(visibleCount(mesh), 1);
    assert.equal(random.mock.callCount(), 5);

    const first = instance(mesh, 0);
    near(first.position.x, focus.x, 'x');
    near(first.position.z, focus.z, 'z');
    near(first.position.y, getDuneHeight(focus.x, focus.z) + a.minLift
        + Math.pow(0.5, a.liftBias) * (a.liftCalm + a.fallbackIntensity * a.liftStorm), 'y');
    near(first.scale.x, a.scaleBase + a.fallbackIntensity * a.scaleIntensity + 0.5 * a.scaleSpread, 'scale');
});

test('ambient dust preserves random sampling order and wind coupling', t => {
    const windAt = t.mock.fn((out) => out.set(2, 0, -3));
    const { system, mesh } = createDustHarness(t, windAt);
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    let draws = 0;
    t.mock.method(Math, 'random', () => values[draws++]);
    const focus = new THREE.Vector3(10, 0, 20);
    const weather = { intensity: 0.6, gust: 0.4 };
    const a = DUST.ambient;
    const x = focus.x + (values[0] - 0.5) * CHUNK.size * a.spread;
    const z = focus.z + (values[1] - 0.5) * CHUNK.size * a.spread;
    const y = getDuneHeight(x, z) + a.minLift
        + Math.pow(values[2], a.liftBias) * (a.liftCalm + weather.intensity * a.liftStorm);
    const scale = a.scaleBase + weather.intensity * a.scaleIntensity + values[4] * a.scaleSpread;
    const maxLife = a.minLife + values[3] * a.lifeSpread;

    system.updateAmbient(focus, 1.1 / ambientRate(weather), weather);
    assert.equal(draws, 6);
    assert.equal(windAt.mock.callCount(), 1);
    assert.deepEqual(windAt.mock.calls[0].arguments.slice(1), [x, z]);
    system.update(0);
    const first = instance(mesh, 0);
    near(first.position.x, x, 'x');
    near(first.position.y, y, 'y');
    near(first.position.z, z, 'z');
    near(first.scale.x, scale, 'scale');

    const dt = 0.01;
    system.update(dt);
    const moved = instance(mesh, 0);
    const drag = Math.min(1, dt * DUST.dragPerSecond);
    near(moved.position.x, x + (2 * a.windCoupling + (2 - 2 * a.windCoupling) * drag) * dt, 'wind x');
    near(moved.position.z, z + (-3 * a.windCoupling + (-3 + 3 * a.windCoupling) * drag) * dt, 'wind z');
    near(moved.position.y, y + (a.riseCalm + values[5] * a.riseSpread - DUST.gravity * dt) * dt, 'rise');
    near(moved.scale.x, scale * (1 - dt / maxLife), 'lifetime scale');
    assert.equal(draws, 6);
});

test('ambient emission is capped by the queue and frame budget', t => {
    const { system, mesh } = createDustHarness(t);
    const random = t.mock.method(Math, 'random', () => 0.5);
    system.updateAmbient(new THREE.Vector3(), 100, { intensity: 1, gust: 1 });
    system.update(0);
    const expected = Math.min(Math.floor(DUST.ambient.maxQueued), DUST.ambient.budgetPerFrame);
    assert.equal(visibleCount(mesh), expected);
    assert.equal(random.mock.callCount(), expected * 5);
});

test('a full pool consumes emission attempts and reuses the first expired slot', t => {
    const { system, mesh } = createDustHarness(t);
    const random = t.mock.method(Math, 'random', () => 0.5);
    const focus = new THREE.Vector3();
    system.spawnSplash(focus, DUST.maxParticles, 1);
    system.update(0);
    assert.equal(visibleCount(mesh), DUST.maxParticles);
    random.mock.resetCalls();

    system.updateAmbient(focus, 1.1 / ambientRate(), null);
    assert.equal(random.mock.callCount(), 0);
    system.update(DUST.splash.minLife + DUST.splash.lifeSpread);
    assert.equal(visibleCount(mesh), 0);
    system.updateAmbient(focus, 0, null);
    system.update(0);
    assert.equal(visibleCount(mesh), 0, 'failed emission must not accumulate a backlog');

    system.updateAmbient(focus, 1 / ambientRate(), null);
    system.update(0);
    assert.equal(visibleCount(mesh), 1);
    assert.notEqual(instance(mesh, 0).position.y, -100);
    assert.equal(instance(mesh, 1).position.y, -100);
    assert.equal(random.mock.callCount(), 5);
});
