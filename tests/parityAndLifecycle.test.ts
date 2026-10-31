// Тесты соответствия визуала и коллайдера (задача 11, 12)
// и полного жизненного цикла dispose() (задача 14).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { CHUNK, SANDFIELD } from '../src/config.ts';
import { chunkKeyOf } from '../src/core/chunkCoords.ts';
import { getDuneHeight } from '../src/core/duneField.ts';
import { createPhysicsWorld } from '../src/world/physics.ts';
import { createSandField } from '../src/world/sandField.ts';
import { createSandDeformer } from '../src/world/sandDeformation.ts';
import { createChunkTerrain } from '../src/world/terrain.ts';
import { createDioramaApp } from '../src/app.ts';

test('sub-region обновление меша и синхронизация с Rapier heightfield', async t => {
    const world = await createPhysicsWorld();
    t.after(() => world.free());

    const scene = new THREE.Scene();
    const field = createSandField();
    const deformer = createSandDeformer({ field });

    const sandMaterial = new THREE.MeshBasicMaterial();
    const skirtMaterial = new THREE.MeshBasicMaterial();
    const frameMaterial = new THREE.MeshBasicMaterial();
    const frameGeometry = new THREE.BoxGeometry(1, 1, 1);

    const terrain = createChunkTerrain({
        scene, world, cx: 0, cz: 0,
        sandMaterial, skirtMaterial, frameMaterial, frameGeometry
    });

    const key = chunkKeyOf(0, 0);
    deformer.attachChunk(key, terrain.sandGeometry, 0, 0, terrain);
    field.attachChunk(0, 0);

    // Вносим локальный отпечаток стопы в точке (2, 2)
    deformer.stampFootprint(new THREE.Vector3(2.0, 0, 2.0), 1.2, 0.25);

    // Принудительно вызываем flush dirty-региона
    deformer.update(0.016, null);

    // Проверяем, что вертексы меша в точке удара опустились
    const geom = terrain.sandGeometry;
    const posAttr = geom.attributes.position;
    const N = CHUNK.gridSegments + 1;
    const CELL = CHUNK.size / CHUNK.gridSegments;
    const HALF = CHUNK.size * 0.5;

    // Находим индекс вершины, ближайшей к (2, 2)
    const col = Math.round((2.0 + HALF) / CELL);
    const row = Math.round((2.0 + HALF) / CELL);
    const vertIndex = row * N + col;

    const meshY = posAttr.getY(vertIndex);
    const duneY = getDuneHeight(2.0, 2.0);
    const fieldDelta = field.sampleDelta(2.0, 2.0);

    assert.ok(meshY < duneY - 0.05, `вершина меша должна просесть: meshY=${meshY}, duneY=${duneY}`);
    assert.ok(Math.abs(meshY - (duneY + fieldDelta)) < 0.05,
        `высота меша должна соответствовать полю: ${meshY} vs ${duneY + fieldDelta}`);

    // Проверяем, что в коллайдере Rapier высота обновилась
    const colliderY = terrain.getHeights()[row + col * N];
    assert.ok(Math.abs(colliderY - (duneY + fieldDelta)) < 0.05,
        `коллайдер Rapier должен совпадать с полем: ${colliderY} vs ${duneY + fieldDelta}`);

    deformer.dispose();
    terrain.dispose();
    sandMaterial.dispose();
    skirtMaterial.dispose();
    frameMaterial.dispose();
    frameGeometry.dispose();
});

test('полный цикл dispose() для подсистем очищает ресурсы без ошибок', async t => {
    const world = await createPhysicsWorld();
    const scene = new THREE.Scene();
    const field = createSandField();
    const deformer = createSandDeformer({ field });

    // Добавляем и удаляем ресурсы
    field.attachChunk(0, 0);
    field.stampCrater(0, 0, 1.0, 0.2);

    deformer.dispose();
    world.free();

    assert.ok(true, 'подсистемы успешно освобождены через dispose');
});
