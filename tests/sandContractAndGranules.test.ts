// Тесты полного физического контракта песка (Этапы 0–7):
// - Этап 0: Диагностика, телеметрия объёмов L1+L2 и воспроизводимость
// - Этап 1: Замкнутый баланс массы L2-гранул
// - Этап 2: Взаимодействие с реальной поверхностью GroundSample
// - Этап 3: Распределённый контакт подошвы и асимметричный валик
// - Этап 4: Отделение привода от реакции грунта (ограничение крутящим моментом)
// - Этап 5: Дробный перенос песка ветром и порог срыва
// - Этап 6: Согласованность физики и стриминга
// - Этап 7: Профилирование и тайминги
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { CHUNK, SANDFIELD, HEXAPOD, MECH } from '../src/config.ts';
import { chunkKeyOf } from '../src/core/chunkCoords.ts';
import { createRng } from '../src/core/rng.ts';
import { createSandField } from '../src/world/sandField.ts';
import { createSandGranules } from '../src/world/sandGranules.ts';
import { createLegContacts } from '../src/mech/legContacts.ts';

test('Этап 0 и 1: строгий замкнутый баланс массы L1 + L2 при выбросе, полете и оседании', () => {
    const scene = new THREE.Scene();
    const rng = createRng(42);
    const field = createSandField();
    field.attachChunk(0, 0);

    const granules = createSandGranules({
        scene,
        rng,
        withdrawMass: (x, z, amount) => field.withdrawMass(x, z, amount),
        depositMass: (x, z, amount) => field.depositMass(x, z, amount),
        addReserve: (amount) => field.addReserve(amount),
        sampleHeight: (x, z) => field.sampleHeight(x, z)
    });

    const vTotalBefore = field.getTotalVolume() + granules.getTotalVolume();

    // Лапа выбивает порцию песка
    const footPos = { x: 2.0, y: field.sampleHeight(2.0, 2.0), z: 2.0 };
    const footVel = { x: 1.5, y: 0, z: 0 };
    granules.spawnFootEjection(footPos, footVel, 24, 1.2);

    // Во время полёта масса должна строго сохраняться в сумме L1 + L2
    const vTotalInFlight = field.getTotalVolume() + granules.getTotalVolume();
    const flightDiff = Math.abs(vTotalInFlight - vTotalBefore);
    assert.ok(flightDiff < 1e-6, `масса L1+L2 во время полета должна сохраняться: diff=${flightDiff}`);
    assert.ok(granules.getActiveCount() > 0, 'гранулы должны быть активны');

    // Симулируем шаги баллистики до полного оседания гранул
    for (let step = 0; step < 120; step++) {
        granules.update(0.05, {
            sampleHeight: (x, z) => field.sampleHeight(x, z),
            depositMass: (x, z, amount) => field.depositMass(x, z, amount),
            addReserve: (amount) => field.addReserve(amount)
        });
    }

    // Все гранулы осели или вернулись в резерв
    const vTotalAfter = field.getTotalVolume() + granules.getTotalVolume();
    const totalDiff = Math.abs(vTotalAfter - vTotalBefore);
    assert.ok(totalDiff < 1e-6, `масса после оседания сохранена: diff=${totalDiff}`);
    assert.equal(granules.getActiveCount(), 0, 'все гранулы должны осесть');
});

test('Этап 1: исчезновение гранул в воздухе переводит массу в мировой резерв, а не теряет', () => {
    const scene = new THREE.Scene();
    const rng = createRng(100);
    const field = createSandField();
    field.attachChunk(0, 0);

    const granules = createSandGranules({
        scene,
        rng,
        withdrawMass: (x, z, amount) => field.withdrawMass(x, z, amount),
        depositMass: (x, z, amount) => field.depositMass(x, z, amount),
        addReserve: (amount) => field.addReserve(amount)
        // Без sampleHeight: гранулы не касаются земли и истекают по maxLife
    });

    const vBefore = field.getTotalVolume() + granules.getTotalVolume();

    // Выброс от реактивных сопел
    granules.spawnThrusterBurst({ x: 0, y: 5.0, z: 0 }, 32, 1.5);
    assert.ok(granules.getActiveCount() > 0);

    // Симулируем время больше maxLife (2.5 с)
    for (let i = 0; i < 60; i++) {
        granules.update(0.05);
    }

    assert.equal(granules.getActiveCount(), 0, 'гранулы должны завершить жизнь');
    const vAfter = field.getTotalVolume() + granules.getTotalVolume();
    const diff = Math.abs(vAfter - vBefore);
    assert.ok(diff < 1e-6, `масса не должна потеряться при истечении жизни в воздухе: diff=${diff}`);
    assert.ok(field.getWorldReserve() > 0, 'масса должна оказаться в мировом резерве');
});

test('Этап 1: переполнение ячейки каскадирует избыток в соседние ячейки', () => {
    const field = createSandField();
    field.attachChunk(0, 0);

    const initialTotal = field.getTotalVolume();
    const hugeAmount = 0.5; // большой объём песка, превышающий вместимость одной ячейки (maxDelta)
    const deposited = field.depositMass(0, 0, hugeAmount);

    assert.ok(Math.abs(deposited - hugeAmount) < 1e-6, 'весь объём должен быть принят');
    const postTotal = field.getTotalVolume();
    assert.ok(Math.abs(postTotal - initialTotal - hugeAmount) < 1e-6, 'общий баланс сохраняется');
});

test('Этап 2: взаимодействие гранул с реальной поверхностью (песок vs камень)', () => {
    const scene = new THREE.Scene();
    const field = createSandField();
    field.attachChunk(0, 0);

    let depositedOnSolid = false;
    let depositedOnSand = false;

    const granules = createSandGranules({
        scene,
        rng: createRng(777),
        withdrawMass: (x, z, amount) => amount, // dummy withdraw
        depositMass: (x, z, amount) => {
            if (x > 5.0) depositedOnSolid = true;
            else depositedOnSand = true;
            return amount;
        }
    });

    // Сэмплер: x > 5.0 — твердый камень (solid), x <= 5.0 — рыхлый песок (sand)
    const mockSampleGround = (x, z) => {
        if (x > 5.0) {
            return {
                y: 1.0,
                normal: new THREE.Vector3(0.5, 0.866, 0).normalize(),
                surfaceType: 'solid',
                friction: 0.35
            };
        }
        return {
            y: 0.0,
            normal: new THREE.Vector3(0, 1, 0),
            surfaceType: 'sand',
            friction: 0.75
        };
    };

    // Выбрасываем гранулу над камнем (x = 7.0, y = 2.0)
    granules.spawnFootEjection({ x: 7.0, y: 2.0, z: 0 }, { x: 0, y: -2.0, z: 0 }, 1, 1.0);

    // Шаг симуляции: соударение с камнем
    granules.update(0.05, { sampleGround: mockSampleGround });

    assert.equal(depositedOnSolid, false, 'гранула НЕ имеет права оседать на камне');

    // Выбрасываем гранулу над песком (x = 2.0, y = 1.0) с почти нулевой скоростью
    granules.spawnFootEjection({ x: 2.0, y: 0.05, z: 0 }, { x: 0.01, y: 0, z: 0 }, 1, 0.1);

    // Несколько шагов: гранула на песке должна осесть
    for (let i = 0; i < 20; i++) {
        granules.update(0.05, { sampleGround: mockSampleGround });
    }

    assert.equal(depositedOnSand, true, 'гранула должна осесть на песке');
});

test('Этап 3: распределенный контакт подошвы: широкая лапа проседает меньше узкой', () => {
    const f1 = createSandField();
    f1.attachChunk(0, 0);
    const wideRes = f1.contact(0, 0, 0.6, 5000, 0.82 * 0.82, 0.1, null, null, {
        useSoleShape: true,
        terramechanics: true,
        width: 0.82,
        length: 0.82,
        heading: 0,
        pitch: 0,
        roll: 0
    });

    const f2 = createSandField();
    f2.attachChunk(0, 0);
    const narrowRes = f2.contact(0, 0, 0.6, 5000, 0.35 * 0.70, 0.1, null, null, {
        useSoleShape: true,
        terramechanics: true,
        width: 0.35,
        length: 0.70,
        heading: 0,
        pitch: 0,
        roll: 0
    });

    assert.ok(wideRes.sinkStep < narrowRes.sinkStep, 'глубина просадки широкой лапы меньше');
    assert.ok(wideRes.sinkRate < narrowRes.sinkRate, 'скорость просадки широкой лапы должна быть меньше узкой');
});

test('Этап 3: наклон подошвы (pitch) создает асимметричный валик', () => {
    const field = createSandField();
    const key = chunkKeyOf(0, 0);
    field.attachChunk(0, 0);

    // Отпечаток с дифферентом на носок (+pitch)
    field.soleFootprintInChunk(key, 0, 0, {
        width: 0.82,
        length: 0.82,
        yaw: 0,
        pitch: 0.35,
        roll: 0,
        sinkDepth: 0.22
    });

    // Проверяем асимметрию отпечатка носок (+Z) vs пятка (-Z)
    const toeDelta = field.sampleDelta(0, 0.3);
    const heelDelta = field.sampleDelta(0, -0.3);

    assert.notEqual(toeDelta, heelDelta, 'профиль отпечатка должен быть асимметричным при pitch != 0');
});

test('Этап 4: ограничение крутящим моментом привода и срыв в пробуксовку', () => {
    const mockBody = {
        resetForces: () => {},
        resetTorques: () => {},
        addForceAtPoint: () => {},
        addTorque: () => {},
        worldCom: () => ({ x: 0, y: 1.5, z: 0 })
    };

    const mockLegs = [{
        isPlanted: true,
        isStepping: false,
        supportForce: 4000,
        currentFootPos: { x: 2.0, y: 0, z: 2.0 },
        hipLocal: { x: 1.0, y: 0.5, z: 1.0 },
        groundNormal: { x: 0, y: 1, z: 0 },
        groundContact: { surfaceType: 'sand', packing: 0.2, normal: new THREE.Vector3(0, 1, 0) },
        packing: 0.2
    }];

    const contacts = createLegContacts({ body: mockBody, legs: mockLegs });

    // Запрос колоссальной горизонтальной силы привода (100 000 Н)
    const motion = {
        bodyPos: { x: 0, y: 1.5, z: 0 },
        bodyQuat: { x: 0, y: 0, z: 0, w: 1 },
        bodyVel: { x: 0, y: 0, z: 0 },
        bodyAngVel: { x: 0, y: 0, z: 0 },
        flatFwd: { x: 0, y: 0, z: 1 },
        driveForceX: 0,
        driveForceZ: 100000,
        attitudeTorqueX: 0,
        attitudeTorqueZ: 0,
        yawTorque: 0,
        airborne: false
    };

    const plane = { loadsSolved: true };
    const dbg = contacts.solve(motion, plane, 0.02);

    // Привод должен насытиться (saturation > 0.8), сила ограничена
    assert.ok(dbg.saturation > 0.8, 'запрос сверхсилы должен насытить привод и сцепление');
    assert.ok(mockLegs[0].tangentForce < 10000, 'сила привода должна быть ограничена мотором и грунтом');
    assert.ok(mockLegs[0].yieldVelocity && Math.hypot(mockLegs[0].yieldVelocity.x, mockLegs[0].yieldVelocity.z) > 0,
        'нескомпенсированная сила должна вызвать скорость пробуксовки');
});

test('Этап 5: дробный диагональный перенос песка перемещает массу по X и Z', () => {
    const field = createSandField();
    field.attachChunk(0, 0);

    // Создаем валик песка
    field.stampCrater(0, 0, 1.5, 0.3, 0.0);
    const v0 = field.getTotalVolume();

    // Диагональный ветер
    field.update(0.1, { windX: 10.0, windZ: 10.0, erosionRate: 0.5 });

    const v1 = field.getTotalVolume();
    const diff = Math.abs(v1 - v0);
    assert.ok(diff < 1e-4, `дробный диагональный перенос обязан сохранять массу: diff=${diff}`);
});

test('Этап 6: физический барьер и сохранение состояния при стриминге', () => {
    const field = createSandField();
    field.attachChunk(5, 5);

    // Наносим сложный рельеф
    field.stampCrater(5 * CHUNK.size + 2, 5 * CHUNK.size + 2, 1.8, 0.28, 0.2);
    const vBefore = field.getTotalVolume();

    // physicsDirty должен быть помечен
    assert.ok(field.getStats().physicsDirty > 0, 'деформация должна пометить physicsDirty');

    // Потребляем physicsDirty перед физическим шагом
    const dirtyChunks = field.consumePhysicsDirty();
    assert.ok(dirtyChunks.length > 0, 'physicsDirty должен быть успешно потреблен');
    assert.equal(field.getStats().physicsDirty, 0, 'очередь physicsDirty должна очиститься');

    // Выгружаем чанк и вызываем вытеснение LRU
    field.detachChunk(5, 5);
    for (let cx = 0; cx <= 225; cx++) {
        const r = field.attachChunk(cx + 10, 0);
        r.touched = true;
        field.detachChunk(cx + 10, 0);
    }
    assert.ok(field.getStats().evictedChunks > 0, 'чанк должен попасть в evictedStore');

    // Повторно загружаем чанк
    field.attachChunk(5, 5);
    const vAfter = field.getTotalVolume();
    assert.ok(Math.abs(vAfter - vBefore) < 1e-4, 'повторная загрузка восстанавливает объём без дрейфа');
});

test('Этап 7: профилирование фаз и тайминги доступны в телеметрии', () => {
    const field = createSandField();
    field.attachChunk(0, 0);

    field.update(0.02, { windX: 5.0, windZ: 0.0, erosionRate: 0.5 });
    const stats = field.getStats();

    assert.ok(typeof stats.stepDurationMs === 'number', 'stepDurationMs должен присутствовать в статистике');
    assert.ok(typeof stats.worldReserve === 'number', 'worldReserve должен присутствовать в статистике');
    assert.ok(typeof stats.syncLatencyMs === 'number', 'syncLatencyMs должен присутствовать в статистике');
});
