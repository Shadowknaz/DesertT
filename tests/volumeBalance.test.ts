// Тесты сохранения объёма песка при переносе через швы,
// выгрузке чанков и LRU-вытеснении (задача 4).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK, SANDFIELD } from '../src/config.ts';
import { chunkKeyOf } from '../src/core/chunkCoords.ts';
import { createSandField } from '../src/world/sandField.ts';

test('сохранение массы при деформации подошвой (soleFootprint)', () => {
    const field = createSandField();
    const key = chunkKeyOf(0, 0);
    field.attachChunk(0, 0);

    const initialVolume = field.getTotalVolume();

    // Отпечаток стопы под углом с креном/тангажом
    field.soleFootprintInChunk(key, 2.0, 2.0, {
        width: 0.8,
        length: 0.8,
        yaw: 0.785,
        sinkDepth: 0.12,
        pitch: 0.05,
        roll: -0.05
    });

    const postVolume = field.getTotalVolume();
    const drift = Math.abs(postVolume - initialVolume);

    assert.ok(drift < 1e-4, `объём должен сохраняться: drift=${drift}`);
});

test('сохранение массы при переносе через швы между соседними чанками', () => {
    const field = createSandField();
    field.attachChunk(0, 0);
    field.attachChunk(1, 0);

    // Создаем кратер, пересекающий шов между (0,0) и (1,0) (шов на x = 12.0)
    const seamX = 12.0;
    const initialVolume = field.getTotalVolume();

    field.stampCrater(seamX, 2.0, 2.5, 0.2);

    // Обновляем физику и осыпь/швы
    field.update(0.1, { windX: 5.0, windZ: 0.0, erosionRate: 0.5 });

    const postVolume = field.getTotalVolume();
    const drift = Math.abs(postVolume - initialVolume);

    assert.ok(drift < 1e-4, `перенос шва не теряет объём: drift=${drift}`);
});

test('сохранение состояния при detachChunk и LRU-вытеснении в evictedStore', () => {
    const field = createSandField();
    const key = chunkKeyOf(2, 3);
    const originX = 2 * CHUNK.size;
    const originZ = 3 * CHUNK.size;

    field.attachChunk(2, 3);

    // Вносим деформацию кратером
    field.stampCrater(originX + 2, originZ + 2, 1.5, 0.25);
    const initialVolume = field.getTotalVolume();

    // Читаем деформацию до выгрузки
    const recBefore = field.getRecord(key);
    let nonZeroCount = 0;
    for (let i = 0; i < recBefore.delta.length; i++) {
        if (Math.abs(recBefore.delta[i]) > 1e-5) nonZeroCount++;
    }
    assert.ok(nonZeroCount > 0, 'деформация должна быть записана');

    // Выгружаем чанк
    field.detachChunk(2, 3);

    // Принудительно вытесняем все кэшированные чанки через переполнение LRU
    // (кэш вмещает maxCachedChunks = 16)
    for (let cx = 10; cx < 35; cx++) {
        field.attachChunk(cx, 0);
        field.detachChunk(cx, 0);
    }

    // Повторно загружаем исходный чанк
    field.attachChunk(2, 3);
    const recRestored = field.getRecord(key);

    let restoredCount = 0;
    for (let i = 0; i < recRestored.delta.length; i++) {
        if (Math.abs(recRestored.delta[i]) > 1e-5) restoredCount++;
    }

    assert.equal(restoredCount, nonZeroCount, 'все измененные ячейки восстановлены из evictedStore');
    const restoredVolume = field.getTotalVolume();
    assert.ok(Math.abs(restoredVolume - initialVolume) < 1e-4, 'общий объём сохранен после вытеснения');
});

test('баланс объёма сохраняется при многократном ветровом транспорте', () => {
    const field = createSandField();
    field.attachChunk(0, 0);

    // Создаем начальный рельеф деформации
    field.stampCrater(2, 2, 2.0, 0.2);
    const initialVolume = field.getTotalVolume();

    const weather = { windX: 12.0, windZ: 7.0, erosionRate: 0.8 };

    // Симулируем шаги переноса песка ветром
    for (let step = 0; step < 6; step++) {
        field.update(1.0, weather);
    }

    const finalVolume = field.getTotalVolume();
    const drift = Math.abs(finalVolume - initialVolume);

    assert.ok(drift < 1e-4, `ветровой перенос сохраняет массу: drift=${drift}`);
});
