// Опорная геометрия: единый набор опорных стоп, центр давления и пересчет
// мирового уклона в систему курса. Ошибки здесь валили мех на склоне,
// поэтому проверяется не «примерно стоит», а конкретные точки и оси.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { MECH } from '../src/config.ts';
import { computeFootSupport, slopesInHeading } from '../src/mech/legSupport.ts';

const IDENTITY = new THREE.Quaternion();
const RIDE_Y = MECH.rideHeight;

function leg(x, y, z, overrides = {}) {
    return {
        currentFootPos: { x, y, z },
        isPlanted: true,
        isStepping: false,
        groundGap: 0.0,
        groundNormal: { x: 0.0, y: 1.0, z: 0.0 },
        normalLoad: 0.0,
        sink: 0.0,
        traction: 0.0,
        ...overrides
    };
}

function pose(y = RIDE_Y, quat = IDENTITY, landingGear = false) {
    return { y, quat, landingGear };
}

test('плоскость и полигон берут только подтвержденные стопы', () => {
    // Три лапы стоят на высоте 0.5, три висят над песком на высоте 0.
    // Если висящие попадут в плоскость, supportY уедет вниз, а наклон
    // станет ненулевым.
    const legs = [
        leg(-2.0, 0.5, 0.0),
        leg(2.0, 0.5, 0.0),
        leg(0.0, 0.5, -2.0),
        leg(-2.0, 0.0, 2.0, { groundGap: 0.6 }),
        leg(2.0, 0.0, 2.0, { groundGap: 0.6 }),
        leg(0.0, 0.0, 3.0, { groundGap: 0.6 })
    ];

    const support = computeFootSupport(legs, 0.0, 0.0);

    assert.equal(support.plantedCount, 3, 'висящие лапы попали в опору');
    assert.ok(Math.abs(support.supportY - 0.5) < 1e-6, `supportY=${support.supportY}`);
    assert.ok(Math.abs(support.pitchSlope) < 1e-6, 'появился наклон от висящих лап');
    assert.ok(Math.abs(support.rollSlope) < 1e-6, 'появился крен от висящих лап');
});

test('стопа на грани порога наклоняет плоскость пропорционально весу', () => {
    // Четвертая стопа выше остальных: при полном касании она сильно
    // задирает плоскость, при весе чуть выше порога — только частично.
    // Так переход через порог не дает полного скачка наклона опоры.
    const base = [
        leg(-2.0, 0.0, 0.0),
        leg(2.0, 0.0, 0.0),
        leg(0.0, 0.0, -2.0)
    ];
    const full = [...base.map((item) => ({ ...item })), leg(0.0, 0.5, 2.0)];
    // Зазор 0.12 м при полном 0.04 и нуле 0.22 дает вес ≈0.56.
    const partial = [...base.map((item) => ({ ...item })),
        leg(0.0, 0.5, 2.0, { groundGap: 0.12 })];

    const fullSupport = computeFootSupport(full, 0.0, 0.0);
    const partialSupport = computeFootSupport(partial, 0.0, 0.0);

    const fullTilt = Math.abs(fullSupport.pitchSlope) + Math.abs(fullSupport.rollSlope);
    const partialTilt = Math.abs(partialSupport.pitchSlope)
        + Math.abs(partialSupport.rollSlope);

    assert.equal(fullSupport.plantedCount, 4);
    assert.equal(partialSupport.plantedCount, 4, 'стопа на грани порога выпала из опоры');
    assert.ok(fullTilt > 0.02, `полное касание не дало наклона: ${fullTilt}`);
    assert.ok(partialTilt > 0.0, 'частичное касание не учтено совсем');
    // Скачок не исчезает полностью: новая точка меняет и полигон. Но
    // наклон растет не на полный вес стопы, а пропорционально касанию.
    assert.ok(partialTilt < fullTilt * 0.9,
        `скачок наклона: ${partialTilt.toFixed(3)} vs ${fullTilt.toFixed(3)}`);
});

test('мировой уклон пересчитывается в курс корпуса', () => {
    // Склон поднимается к +x: b = 0.25, нормаль (-0.25, 1, 0).
    const normal = new THREE.Vector3(-0.25, 1.0, 0.0).normalize();

    const straight = slopesInHeading(normal, 0.0);
    assert.ok(Math.abs(straight.rollSlope - 0.25) < 1e-6, `roll=${straight.rollSlope}`);
    assert.ok(Math.abs(straight.pitchSlope) < 1e-6, `pitch=${straight.pitchSlope}`);

    // После разворота на +x тот же склон становится подъемом впереди:
    // мировой уклон по x обязан перейти в локальный тангаж, а не в крен.
    const turned = slopesInHeading(normal, Math.PI * 0.5);
    assert.ok(Math.abs(turned.pitchSlope - 0.25) < 1e-6, `pitch=${turned.pitchSlope}`);
    assert.ok(Math.abs(turned.rollSlope) < 1e-6, `roll=${turned.rollSlope}`);
});

test('центр давления лежит на наклонной плоскости', () => {
    // Опора — плоскость y = 0.5x, все реакции вдоль её нормали. При такой
    // геометрии центр давления обязан совпасть с взвешенным по силам
    // центром стоп. Старая проекция на горизонталь под корпусом давала
    // сдвиг порядка уклона × смещение.
    const slope = 0.5;
    const normal = new THREE.Vector3(-slope, 1.0, 0.0).normalize();
    const groundNormal = { x: normal.x, y: normal.y, z: normal.z };
    const legs = [
        leg(-1.0, -0.5, -1.0, { groundNormal }),
        leg(-1.0, -0.5, 2.0, { groundNormal }),
        leg(1.0, 0.5, -1.0, { groundNormal }),
        leg(1.0, 0.5, 2.0, { groundNormal })
    ];

    const bodyX = 0.6;
    const bodyZ = 0.3;
    const support = computeFootSupport(legs, bodyX, bodyZ, pose(slope * bodyX + RIDE_Y));

    assert.ok(Math.abs(support.rollSlope - slope) < 1e-6, `roll=${support.rollSlope}`);
    assert.ok(Math.abs(support.pitchSlope) < 1e-6, `pitch=${support.pitchSlope}`);
    assert.ok(support.copValid);

    let sum = 0.0;
    let sx = 0.0;
    let sz = 0.0;
    for (const item of legs) {
        const force = item.supportForce;
        sum += force;
        sx += item.currentFootPos.x * force;
        sz += item.currentFootPos.z * force;
    }
    assert.ok(sum > 0.0);
    const expectedX = sx / sum;
    const expectedZ = sz / sum;
    assert.ok(Math.abs(support.copX - expectedX) < 1e-6,
        `copX=${support.copX} вместо ${expectedX}`);
    assert.ok(Math.abs(support.copZ - expectedZ) < 1e-6,
        `copZ=${support.copZ} вместо ${expectedZ}`);
});

test('вес распределяется из равновесия моментов', () => {
    // Несимметричная стойка: равномерное деление дало бы момент, поэтому
    // нагрузки обязаны перераспределиться, а центр давления встать под COM.
    const legs = [
        leg(-2.0, 0.0, 0.0),
        leg(2.0, 0.0, 0.0),
        leg(0.0, 0.0, -2.0),
        leg(-1.0, 0.0, 2.0),
        leg(1.0, 0.0, 2.0)
    ];

    const support = computeFootSupport(legs, 0.0, 0.0, pose());

    const bodyWeight = MECH.mass * Math.abs(-18.0);
    let total = 0.0;
    let lowest = Infinity;
    let highest = -Infinity;
    for (const item of legs) {
        total += item.supportForce;
        if (item.supportForce < lowest) lowest = item.supportForce;
        if (item.supportForce > highest) highest = item.supportForce;
    }

    assert.ok(support.copValid, 'центр давления не определен');
    assert.ok(Math.abs(total - bodyWeight) < 1.0, `суммарная опора ${total.toFixed(0)} Н`);
    assert.ok(Math.abs(support.copX) < 0.01 && Math.abs(support.copZ) < 0.01,
        `центр давления уехал от COM: ${support.copX.toFixed(2)}, ${support.copZ.toFixed(2)}`);
    assert.ok(highest - lowest > 50.0, 'нагрузка осталась равномерной');
});

test('центр давления следует за наклоном корпуса', () => {
    // Крен +0.1 опускает левые бедра: их стойки сжимаются, и
    // равнодействующая уходит влево.
    const limbs = () => [
        leg(-3.0, 0.0, 0.0, { hipLocal: { x: -2.0, y: 0.0, z: 0.0 } }),
        leg(3.0, 0.0, 0.0, { hipLocal: { x: 2.0, y: 0.0, z: 0.0 } }),
        leg(0.0, 0.0, -2.0, { hipLocal: { x: 0.0, y: 0.0, z: 0.0 } }),
        leg(0.0, 0.0, 2.0, { hipLocal: { x: 0.0, y: 0.0, z: 0.0 } })
    ];

    const rolled = (roll) => {
        const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.0, 0.0, roll, 'YXZ'));
        return computeFootSupport(limbs(), 0.0, 0.0, pose(RIDE_Y, quat));
    };

    const left = rolled(0.1);
    const right = rolled(-0.1);

    assert.ok(left.copValid && right.copValid, 'центр давления не определен');
    assert.ok(left.copX < -0.2, `крен влево не сдвинул CoP: ${left.copX.toFixed(2)}`);
    assert.ok(right.copX > 0.2, `крен вправо не сдвинул CoP: ${right.copX.toFixed(2)}`);
});

test('без опорных стоп центр давления не выдумывается', () => {
    const legs = [
        leg(-2.0, 0.0, 0.0, { isPlanted: false }),
        leg(2.0, 0.0, 0.0, { isPlanted: false }),
        leg(0.0, 0.0, -2.0, { isPlanted: false })
    ];

    const support = computeFootSupport(legs, 0.3, -0.2, pose());
    assert.equal(support.copValid, false, 'центр давления посчитан без опоры');
    assert.equal(support.plantedCount, 0);
});

test('перерастянутая лапа не строит плоскость и не получает силу', () => {
    // Четвертая стопа далеко в стороне: цель IK за пределом длины ноги,
    // поэтому она не должна попасть ни в полигон, ни в нагрузку.
    const legs = [
        leg(-2.0, 0.5, 0.0),
        leg(2.0, 0.5, 0.0),
        leg(0.0, 0.5, -2.0),
        leg(8.0, 0.5, 8.0, { hipLocal: { x: 0.0, y: 0.0, z: 0.0 } })
    ];

    const support = computeFootSupport(legs, 0.0, 0.0, pose(0.5 + RIDE_Y));

    assert.equal(support.plantedCount, 3, 'перерастянутая лапа попала в опору');
    assert.equal(legs[3].supportForce, 0.0, 'перерастянутая лапа получила силу');
});

test('смена трипода сохраняет равнодействующую', () => {
    // Шесть лап по кольцу и тот же трипод после подъема половины опоры:
    // суммарная вертикаль и момент относительно COM не должны меняться,
    // иначе каждый шаг давал бы короткий крен корпуса.
    const ring = () => {
        const result = [];
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6.0) * Math.PI * 2.0;
            result.push(leg(Math.cos(angle) * 2.5, 0.0, Math.sin(angle) * 2.5));
        }
        return result;
    };

    const bodyWeight = MECH.mass * Math.abs(-18.0);
    const check = (legs) => {
        computeFootSupport(legs, 0.0, 0.0, pose());
        let total = 0.0;
        let mx = 0.0;
        let mz = 0.0;
        for (const item of legs) {
            const f = item.supportForce;
            total += f;
            mx += item.currentFootPos.z * f;
            mz += item.currentFootPos.x * f;
        }
        assert.ok(Math.abs(total - bodyWeight) < 1.0, `вертикаль ${total.toFixed(0)} Н`);
        assert.ok(Math.abs(mz) < 1.0, `момент вокруг Z ${mz.toFixed(1)} Н·м`);
        assert.ok(Math.abs(mx) < 1.0, `момент вокруг X ${mx.toFixed(1)} Н·м`);
    };

    check(ring());
    check(ring().filter((_, index) => index % 2 === 0));
});

test('дробный вес контакта входит в равновесие', () => {
    // Одна лапа касается частично: ее вес 0.7 должен участвовать в решении
    // равновесия, а не применяться после него. Иначе вертикаль и момент
    // разъезжаются на величину этого веса.
    const gap = MECH.contactGapFull
        + (MECH.contactGapRelease - MECH.contactGapFull) * 0.3;
    const legs = [
        leg(-2.0, 0.0, -2.0),
        leg(2.0, 0.0, -2.0),
        leg(-2.0, 0.0, 2.0),
        leg(2.0, 0.0, 2.0, { groundGap: gap })
    ];

    const support = computeFootSupport(legs, 0.0, 0.0, pose());

    const bodyWeight = MECH.mass * Math.abs(-18.0);
    let total = 0.0;
    let mx = 0.0;
    let mz = 0.0;
    for (const item of legs) {
        const f = item.supportForce;
        total += f;
        mx += item.currentFootPos.z * f;
        mz += item.currentFootPos.x * f;
    }

    assert.ok(support.copValid, 'центр давления не определен');
    assert.ok(Math.abs(total - bodyWeight) < 1.0, `вертикаль ${total.toFixed(0)} Н`);
    assert.ok(Math.abs(mz) < 1.0, `момент вокруг Z ${mz.toFixed(1)} Н·м`);
    assert.ok(Math.abs(mx) < 1.0, `момент вокруг X ${mx.toFixed(1)} Н·м`);
    assert.ok(Math.abs(support.copX) < 0.01 && Math.abs(support.copZ) < 0.01,
        `CoP уехал: ${support.copX.toFixed(2)}, ${support.copZ.toFixed(2)}`);
});

test('почти висящая лапа не строит плоскость, но получает долю силы', () => {
    const legs = [
        leg(-2.0, 0.0, 0.0),
        leg(2.0, 0.0, 0.0),
        leg(0.0, 0.0, -2.0),
        leg(0.0, 0.0, 2.0, { groundGap: 0.15 })
    ];

    const support = computeFootSupport(legs, 0.0, 0.0, pose());

    assert.equal(support.plantedCount, 3, 'затухающая лапа попала в опору');
    assert.ok(Math.abs(support.rollSlope) < 1e-6 && Math.abs(support.pitchSlope) < 1e-6,
        `плоскость наклонилась: b=${support.rollSlope}, c=${support.pitchSlope}`);
    assert.ok(legs[3].supportForce > 0.0, 'частичный контакт не получил силу');
});

test('предел посадки одинаков для опоры и контактов', () => {
    const bodyWeight = MECH.mass * Math.abs(-18.0);
    const press = (landingGear) => {
        const legs = [
            leg(-2.0, 0.0, 0.0),
            leg(2.0, 0.0, 0.0),
            leg(0.0, 0.0, -2.0)
        ];
        const support = computeFootSupport(legs, 0.0, 0.0, {
            y: MECH.rideHeight - 0.3,
            quat: IDENTITY,
            landingGear
        });
        return support.loadNormal;
    };

    const normal = press(false);
    const landing = press(true);

    assert.ok(Math.abs(normal - bodyWeight * MECH.normalForceLimit) < 10.0,
        `обычный предел ${normal.toFixed(0)} Н`);
    assert.ok(Math.abs(landing - bodyWeight * MECH.landingForceLimit) < 10.0,
        `предел посадки ${landing.toFixed(0)} Н`);
});

test('опорный решатель не трогает приложенную нагрузку', () => {
    // supportForce — предсказание опорной геометрии, normalLoad — сила,
    // реально поданная контактным слоем. Первый не должен переписывать второй.
    const legs = [
        leg(-2.0, 0.0, 0.0, { normalLoad: 123.0 }),
        leg(2.0, 0.0, 0.0, { normalLoad: 123.0 }),
        leg(0.0, 0.0, -2.0, { normalLoad: 123.0 })
    ];

    computeFootSupport(legs, 0.0, 0.0, pose());

    assert.equal(legs[0].normalLoad, 123.0, 'решатель переписал приложенную силу');
    assert.ok(legs[0].supportForce > 0.0, 'предсказание силы не записано');
});

test('гистерезис не дает опорной геометрии мигать', () => {
    const legs = [
        leg(-2.0, 0.0, -2.0),
        leg(2.0, 0.0, -2.0),
        leg(-2.0, 0.0, 2.0),
        leg(2.0, 0.0, 2.0)
    ];
    const gapFor = (weight) => MECH.contactGapFull
        + (MECH.contactGapRelease - MECH.contactGapFull) * (1.0 - weight);

    // Входит в опору полным контактом.
    computeFootSupport(legs, 0.0, 0.0, { ...pose(), commitSupport: true });
    assert.equal(computeFootSupport(legs, 0.0, 0.0, pose()).plantedCount, 4);

    // Вес падает ниже порога входа, но выше порога удержания.
    legs[3].groundGap = gapFor(0.5);
    assert.equal(
        computeFootSupport(legs, 0.0, 0.0, { ...pose(), commitSupport: true }).plantedCount,
        4,
        'лапа выпала из опоры на первом же подшаге'
    );

    // Совсем зависла — теперь исключается.
    legs[3].groundGap = gapFor(0.1);
    assert.equal(
        computeFootSupport(legs, 0.0, 0.0, { ...pose(), commitSupport: true }).plantedCount,
        3,
        'почти висящая лапа осталась в опоре'
    );
});

test('при недостаточной вертикали центр давления не определен', () => {
    const legs = [
        leg(-2.0, 0.0, 0.0),
        leg(2.0, 0.0, 0.0),
        leg(0.0, 0.0, -2.0)
    ];

    // Корпус выше посадочной высоты: пружины разгружены, опоры нет.
    const support = computeFootSupport(legs, 0.0, 0.0, pose(RIDE_Y + 0.4));

    assert.equal(support.copValid, false, 'CoP посчитан по почти нулевой вертикали');
    assert.ok(support.loadRatio < MECH.copMinRatio, `loadRatio=${support.loadRatio}`);
});

test('на двух опорах нагрузка делится равномерно', () => {
    // Два контакта не могут решить три уравнения равновесия: вместо
    // вырожденной коррекции вес делится поровну, а момент опрокидывает
    // корпус физически.
    const legs = [
        leg(-2.0, 0.0, 0.0),
        leg(2.0, 0.0, -3.0)
    ];

    computeFootSupport(legs, 0.0, 0.0, pose());

    const bodyWeight = MECH.mass * Math.abs(-18.0);
    assert.ok(Math.abs(legs[0].supportForce - bodyWeight * 0.5) < 1.0,
        `левая опора ${legs[0].supportForce.toFixed(0)} Н`);
    assert.ok(Math.abs(legs[1].supportForce - bodyWeight * 0.5) < 1.0,
        `правая опора ${legs[1].supportForce.toFixed(0)} Н`);
});

test('зазор до песка считается для готовности посадки', () => {
    const legs = [
        leg(-2.0, 0.0, 0.0, { groundGap: 0.05 }),
        leg(2.0, 0.0, 0.0, { groundGap: 0.12 }),
        leg(0.0, 0.0, -2.0, { groundGap: 0.5, isPlanted: false }),
        leg(0.0, 0.0, 2.0, { groundGap: Infinity, isPlanted: false })
    ];

    const support = computeFootSupport(legs, 0.0, 0.0, pose());
    assert.equal(support.nearGroundCount, 2, 'число лап у песка неверное');
    assert.ok(Math.abs(support.minFootGap - 0.05) < 1e-6, `minFootGap=${support.minFootGap}`);
});
