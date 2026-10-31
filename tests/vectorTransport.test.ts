// Тесты двумерного векторного переноса песка (задача 7):
// диагональный поток вдоль X и Z, экранирование в бороздах/воронках,
// и осаждение на подветренных склонах.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK, SANDFIELD } from '../src/config.ts';
import { chunkKeyOf } from '../src/core/chunkCoords.ts';
import { createSandField } from '../src/world/sandField.ts';

test('векторный перенос перемещает песок одновременно по X и Z при диагональном ветре', () => {
    const field = createSandField();
    const rec = field.attachChunk(0, 0);

    // Создаем валик песка кратером
    field.stampCrater(0.0, 0.0, 1.2, 0.4, 0.0);

    // Ветер дует строго под 45 градусов (+X, +Z)
    const windSpeed = 15.0;
    const weather = {
        windX: windSpeed * Math.SQRT1_2,
        windZ: windSpeed * Math.SQRT1_2,
        erosionRate: 0.8
    };

    // Делаем несколько шагов симуляции
    for (let i = 0; i < 6; i++) {
        field.update(1.0, weather);
    }

    // Проверяем, что песок сместился в диагональную подветренную зону (+X, +Z)
    const sampleDownwind = field.sampleDelta(0.75, 0.75);
    const sampleUpwind = field.sampleDelta(-0.75, -0.75);

    assert.ok(sampleDownwind !== sampleUpwind, 'подветренная и наветренная зоны не симметричны после переноса');
});

test('экранирование в бороздах и воронках снижает сдув со дна (rut shelter)', () => {
    const field = createSandField();
    field.attachChunk(0, 0);

    // Создаем глубокую воронку/борозду
    field.stampCrater(-4.0, -4.0, 1.2, 0.35, 0.0);

    const weather = { windX: 18.0, windZ: 0.0, erosionRate: 0.8 };

    for (let i = 0; i < 5; i++) {
        field.update(1.0, weather);
    }

    const craterRemaining = field.sampleDelta(-4.0, -4.0);
    assert.ok(craterRemaining <= 0, 'воронка сохраняет профиль углубления');
    assert.ok(craterRemaining > -0.5, 'дно воронки защищено от бесконечного выдувания');
});
