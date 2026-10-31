// Тесты воспроизводимости симуляции через seeded RNG (задача 13).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createRng } from '../src/core/rng.ts';
import { createWeather } from '../src/world/weather.ts';
import { createDustSystem } from '../src/world/dustParticles.ts';
import { createSandGranules } from '../src/world/sandGranules.ts';

test('createRng дает строго детерминированную последовательность чисел для одинакового сида', () => {
    const rng1 = createRng(42);
    const rng2 = createRng(42);

    for (let i = 0; i < 50; i++) {
        assert.equal(rng1.next(), rng2.next(), `число на шаге ${i} должно совпадать`);
    }
});

test('разные сиды дают расходящиеся псевдослучайные последовательности', () => {
    const rngA = createRng(100);
    const rngB = createRng(200);

    let differences = 0;
    for (let i = 0; i < 20; i++) {
        if (rngA.next() !== rngB.next()) differences++;
    }
    assert.ok(differences >= 18, 'последовательности должны существенно отличаться');
});

test('система погоды с одинаковым сидом генерирует идентичный ветер и порывы', () => {
    const scene1 = new THREE.Scene();
    const scene2 = new THREE.Scene();

    const w1 = createWeather({ scene: scene1, seed: 777 });
    const w2 = createWeather({ scene: scene2, seed: 777 });

    const pos = new THREE.Vector3(10, 0, 10);
    const dayMock = { sunDir: new THREE.Vector3(0, 1, 0) };

    for (let step = 0; step < 30; step++) {
        const s1 = w1.update(0.1, pos, null);
        const s2 = w2.update(0.1, pos, null);

        assert.equal(s1.windX, s2.windX, `windX на шаге ${step} не совпал`);
        assert.equal(s1.windZ, s2.windZ, `windZ на шаге ${step} не совпал`);
        assert.equal(s1.gust, s2.gust, `gust на шаге ${step} не совпал`);
        assert.equal(s1.intensity, s2.intensity, `intensity на шаге ${step} не совпал`);
    }

    w1.dispose();
    w2.dispose();
});

test('гранулы песка (L2) с одинаковым сидом порождают идентичные траектории частиц', () => {
    const scene1 = new THREE.Scene();
    const scene2 = new THREE.Scene();
    const rng1 = createRng(12345);
    const rng2 = createRng(12345);

    const g1 = createSandGranules({ scene: scene1, rng: rng1 });
    const g2 = createSandGranules({ scene: scene2, rng: rng2 });

    const origin = { x: 5, y: 1, z: 5 };
    const heading = { x: 1, z: 0 };
    g1.spawnFootEjection(origin, heading, 10, 2.0, 1.0);
    g2.spawnFootEjection(origin, heading, 10, 2.0, 1.0);

    const m1 = scene1.children.find(c => c.isInstancedMesh);
    const m2 = scene2.children.find(c => c.isInstancedMesh);

    const mat1 = new THREE.Matrix4();
    const mat2 = new THREE.Matrix4();

    for (let i = 0; i < 10; i++) {
        m1.getMatrixAt(i, mat1);
        m2.getMatrixAt(i, mat2);
        assert.deepEqual(mat1.elements, mat2.elements, `матрица инстанса ${i} должна совпадать`);
    }

    // Симулируем несколько кадров
    for (let frame = 0; frame < 5; frame++) {
        g1.update(0.016, null);
        g2.update(0.016, null);
    }

    for (let i = 0; i < 10; i++) {
        m1.getMatrixAt(i, mat1);
        m2.getMatrixAt(i, mat2);
        for (let e = 0; e < 16; e++) {
            assert.ok(Math.abs(mat1.elements[e] - mat2.elements[e]) < 1e-5,
                `инстанс ${i} эл ${e} после движения: ${mat1.elements[e]} vs ${mat2.elements[e]}`);
        }
    }

    g1.dispose();
    g2.dispose();
});

test('weather экспортирует rng и сиды влияют на воспроизводимость', () => {
    const sceneA = new THREE.Scene();
    const sceneB = new THREE.Scene();
    const sceneC = new THREE.Scene();

    const wA = createWeather({ scene: sceneA, seed: 1234 });
    const wB = createWeather({ scene: sceneB, seed: 1234 });
    const wC = createWeather({ scene: sceneC, seed: 9999 });

    assert.ok(wA.rng, 'weather.rng должен быть экспортирован');
    assert.equal(typeof wA.rng.next, 'function');
    assert.equal(typeof wA.rng.between, 'function');

    // Одинаковый сид дает одинаковые значения
    const valA = wA.rng.next();
    const valB = wB.rng.next();
    const valC = wC.rng.next();

    assert.equal(valA, valB, 'одинаковый сид должен давать идентичные числа из rng');
    assert.notEqual(valA, valC, 'разные сиды должны давать разные числа');

    wA.dispose();
    wB.dispose();
    wC.dispose();
});

test('гранулы песка переносят массу обратно в L1 при оседании и сдуваются ветром', () => {
    const scene = new THREE.Scene();
    let depositedTotal = 0;
    const deposits = [];

    const groundLevel = 0.5;
    const sampleHeight = (x, z) => groundLevel;
    const depositMass = (x, z, amount) => {
        depositedTotal += amount;
        deposits.push({ x, z, amount });
    };

    const granules = createSandGranules({
        scene,
        sampleHeight,
        depositMass
    });

    // Спавним частицы в воздухе над грунтом
    const origin = { x: 0, y: 2.0, z: 0 };
    const heading = { x: 0, z: 0 };
    granules.spawnFootEjection(origin, heading, 8, 0.5);

    assert.equal(granules.getActiveCount(), 8);

    // Ветер дует строго в +X (20 м/с)
    const env = {
        windX: 20.0,
        windZ: 0.0,
        sampleHeight,
        depositMass
    };

    // Симулируем падение гранул до грунта (2 секунды)
    for (let f = 0; f < 120; f++) {
        granules.update(0.016, env);
    }

    // Проверяем, что гранулы осели на грунт и вернули массу через depositMass
    assert.ok(depositedTotal > 0, `масса должна быть возвращена в L1: depositedTotal=${depositedTotal}`);
    assert.ok(deposits.length > 0, 'должен быть хотя бы один вызов depositMass');

    // Из-за ветра +X точка оседания должна сместиться вправо (x > 0)
    for (const d of deposits) {
        assert.ok(d.x > 0, `гранула должна быть снесена по ветру в +X, но x=${d.x}`);
    }

    granules.dispose();
});

test('гранулы поддерживают вызов update(dt, samplerFn) с сохранением ветра и L1-коллбеков', () => {
    const scene = new THREE.Scene();
    let depositedTotal = 0;

    const sampleHeight = (x, z) => 0.0;
    const depositMass = (x, z, amount) => {
        depositedTotal += amount;
    };

    // Задаем сэмплер ветра как функцию (как передавалось в weather.sampleWindInto)
    const windSampler = (out, x, z) => {
        out.set(15.0, 0, 5.0);
    };

    const granules = createSandGranules({
        scene,
        sampleHeight,
        depositMass
    });

    granules.spawnFootEjection({ x: 0, y: 1.0, z: 0 }, { x: 0, z: 0 }, 4, 0.5);

    for (let f = 0; f < 80; f++) {
        granules.update(0.016, windSampler);
    }

    assert.ok(depositedTotal > 0, 'масса должна осесть даже при передаче samplerFn в update');
    granules.dispose();
});
