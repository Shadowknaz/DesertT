// Знак выравнивания корпуса и гейт склонов. Ошибка знака крена валила мех
// вниз по боковому склону вместо упора в него, поэтому здесь проверяется
// не «примерно вертикально», а конкретное направление наклона.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { MECH, PHYSICS } from '../src/config.ts';
import { createLocomotion } from '../src/mech/locomotion.ts';
import { RAPIER, createPhysicsWorld } from '../src/world/physics.ts';

const FIXED_DT = 1 / 60;

function makeSupport(overrides = {}) {
    return {
        supportY: 0.0,
        pitchSlope: 0.0,
        rollSlope: 0.0,
        slope: 0.0,
        normal: new THREE.Vector3(0, 1, 0),
        plantedCount: 6,
        supportArea: 6.0,
        stability: 1.0,
        tippingMargin: 1.2,
        edgeDirX: 0.0,
        edgeDirZ: 0.0,
        traction: 0.0,
        sink: 0.0,
        sinkMax: 0.0,
        ...overrides
    };
}

function makeCommand(overrides = {}) {
    return {
        throttle: 0.0,
        turnInput: 0.0,
        desiredYawRate: 0.0,
        yawError: 0.0,
        isManual: true,
        stompHeld: false,
        ...overrides
    };
}

// Тело висит в воздухе без гравитации: проверяется только момент рыскания
// и выравнивания, позиция и опора здесь ни при чем.
async function attitudeAfter(support, command = makeCommand(), steps = 150, yaw = 0.0) {
    const world = await createPhysicsWorld();
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0.0, 10.0, 0.0)
            .setRotation({ x: yawQuat.x, y: yawQuat.y, z: yawQuat.z, w: yawQuat.w })
            .setAngularDamping(1.2)
            .setCanSleep(false)
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(2.0, 0.85, 1.85).setMass(MECH.mass),
        body
    );
    body.setGravityScale(0.0, true);

    const locomotion = createLocomotion({ body });

    for (let i = 0; i < steps; i++) {
        const state = locomotion.readBodyState();
        const motion = locomotion.update(FIXED_DT, support, command, state, null);

        // Rapier копит пользовательские моменты до явного сброса
        body.resetTorques(true);
        body.addTorque({
            x: motion.attitudeTorqueX,
            y: motion.yawTorque,
            z: motion.attitudeTorqueZ
        }, true);
        world.step();
    }

    const r = body.rotation();
    const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    return {
        up: new THREE.Vector3(0, 1, 0).applyQuaternion(quat),
        debug: locomotion.getDebug()
    };
}

test('на боковом склоне корпус ложится по нормали, а не зеркально', async () => {
    // Склон поднимается к +x: b = dy/dx = 0.25, нормаль (-0.25, 1, 0)
    const { up } = await attitudeAfter(makeSupport({
        rollSlope: 0.25,
        slope: 0.25,
        normal: new THREE.Vector3(-0.25, 1, 0).normalize()
    }));

    assert.ok(up.y > 0.9, `корпус почти лежит: up.y=${up.y.toFixed(3)}`);
    assert.ok(up.x < -0.05, `крен вниз по склону вместо упора: up.x=${up.x.toFixed(3)}`);
    assert.ok(Math.abs(up.z) < 0.05, `появился паразитный тангаж: up.z=${up.z.toFixed(3)}`);
});

test('на подъеме корпус задирает нос вверх по склону', async () => {
    // Склон поднимается к +z: c = dy/dz = 0.18, нормаль (0, 1, -0.18)
    const { up } = await attitudeAfter(makeSupport({
        pitchSlope: 0.18,
        slope: 0.18,
        normal: new THREE.Vector3(0, 1, -0.18).normalize()
    }));

    assert.ok(up.y > 0.9, `корпус почти лежит: up.y=${up.y.toFixed(3)}`);
    assert.ok(up.z < -0.05, `тангаж не в ту сторону: up.z=${up.z.toFixed(3)}`);
});

test('на диагональном склоне наклон идет по обеим осям', async () => {
    const { up } = await attitudeAfter(makeSupport({
        pitchSlope: 0.18,
        rollSlope: 0.25,
        slope: Math.hypot(0.18, 0.25),
        normal: new THREE.Vector3(-0.25, 1, -0.18).normalize()
    }));

    assert.ok(up.x < -0.05, `крен неверный: up.x=${up.x.toFixed(3)}`);
    assert.ok(up.z < -0.05, `тангаж неверный: up.z=${up.z.toFixed(3)}`);
});

test('после разворота мировой уклон становится локальным тангажом', async () => {
    // Склон поднимается к +x: в мире это боковой уклон. Мех развернут на +x,
    // то есть стоит лицом в гору, и должен задирать нос, а не валиться на
    // бок вокруг неправильной оси.
    const { up } = await attitudeAfter(makeSupport({
        rollSlope: 0.25,
        slope: 0.25,
        normal: new THREE.Vector3(-0.25, 1, 0).normalize()
    }), makeCommand(), 150, Math.PI * 0.5);

    assert.ok(up.y > 0.9, `корпус почти лежит: up.y=${up.y.toFixed(3)}`);
    assert.ok(up.x < -0.05, `уклон применен не по той оси: up.x=${up.x.toFixed(3)}`);
    assert.ok(Math.abs(up.z) < 0.05, `появился паразитный крен: up.z=${up.z.toFixed(3)}`);
});

test('стоя на склоне, привод сразу держит вес, а не ждет ошибки скорости', async () => {
    const world = await createPhysicsWorld();
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(false));
    world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.85, 1.85).setMass(MECH.mass), body);
    body.setGravityScale(0.0, true);

    const locomotion = createLocomotion({ body });
    const state = locomotion.readBodyState();

    // Склон поднимается к +z: удержание должно тянуть в +z, к вершине.
    const slope = 0.4;
    const support = makeSupport({
        slope,
        pitchSlope: slope,
        normal: new THREE.Vector3(0, 1, -slope).normalize()
    });

    const motion = locomotion.update(
        FIXED_DT, support, makeCommand({ throttle: 0 }), state, null
    );

    // Контактный слой проецирует привод на плоскость, поэтому команда
    // задается как mg·tanθ: после проекции останется ровно mg·sinθ вдоль
    // склона.
    const holdForce = MECH.mass * Math.abs(PHYSICS.gravity) * slope;

    assert.ok(motion.driveForceZ > holdForce * 0.9,
        `нет удержания на склоне: Fz=${motion.driveForceZ.toFixed(0)} Н`);
    assert.ok(Math.abs(motion.driveForceZ - holdForce) < 1.0,
        `удержание не равно скатывающей силе: Fz=${motion.driveForceZ.toFixed(0)} ` +
        `вместо ${holdForce.toFixed(0)}`);
    assert.ok(Math.abs(motion.driveForceX) < 10, 'появилась боковая сила на продольном склоне');
});

test('static holding may use the full engine budget, but cannot exceed it', async t => {
    const world = await createPhysicsWorld();
    t.after(() => world.free());
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(false));
    world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.85, 1.85).setMass(MECH.mass), body);
    const locomotion = createLocomotion({ body });
    const state = locomotion.readBodyState();
    const cap = MECH.mass * MECH.driveAccelLimit;
    for (const slope of [0.6, 1.5]) {
        const support = makeSupport({ slope, pitchSlope: slope,
            normal: new THREE.Vector3(0, 1, -slope).normalize() });
        const motion = locomotion.plan(FIXED_DT, support, makeCommand(), state);
        const expected = Math.min(MECH.mass * Math.abs(PHYSICS.gravity) * slope, cap);
        assert.ok(Math.abs(motion.driveForceZ - expected) < 1e-8);
        assert.ok(motion.driveForceZ > cap * 0.75, 'no mandatory 25% reserve');
        assert.ok(Math.abs(motion.driveForceX) < 1e-8);
        assert.equal(motion.velocityGain, MECH.velGainGround);
    }
});

test('engine clamps the vector sum, preserving cross-slope demand and cancellation', async t => {
    const world = await createPhysicsWorld();
    t.after(() => world.free());
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
    world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.85, 1.85).setMass(MECH.mass), body);
    const locomotion = createLocomotion({ body });
    const state = locomotion.readBodyState();
    const slope = 0.6;
    const support = makeSupport({ slope, pitchSlope: slope,
        normal: new THREE.Vector3(0, 1, -slope).normalize() });
    const hold = MECH.mass * Math.abs(PHYSICS.gravity) * slope;
    const mk = MECH.mass * MECH.velGainGround;
    for (const [vx, vz] of [[0, hold / mk], [0, (hold + 200) / mk], [-2, 0], [3, -3]]) {
        const motion = locomotion.plan(FIXED_DT, support, makeCommand(), {
            ...state, bodyVel: new THREE.Vector3(vx, 0, vz)
        });
        const expected = new THREE.Vector2(-mk * vx, hold - mk * vz);
        expected.clampLength(0, MECH.mass * MECH.driveAccelLimit);
        assert.ok(Math.abs(motion.driveForceX - expected.x) < 1e-8);
        assert.ok(Math.abs(motion.driveForceZ - expected.y) < 1e-8);
        assert.ok(Math.hypot(motion.driveForceX, motion.driveForceZ) <= MECH.mass * MECH.driveAccelLimit + 1e-8);
    }
});

test('финал считает запас по CoP', async () => {
    const world = await createPhysicsWorld();
    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(0.0, 10.0, 0.0).setCanSleep(false)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(2.0, 0.85, 1.85).setMass(MECH.mass), body);
    body.setGravityScale(0.0, true);

    const locomotion = createLocomotion({ body });
    const state = locomotion.readBodyState();

    // CoP смещен на 0.3 м к ребру, стойки несут половину веса.
    const support = makeSupport({
        tippingMargin: 1.0,
        edgeDirX: 1.0,
        edgeDirZ: 0.0,
        copValid: true,
        copX: state.bodyPos.x + 0.3,
        copZ: state.bodyPos.z,
        loadRatio: 0.5
    });

    const planned = locomotion.plan(FIXED_DT, support, makeCommand(), state, null);
    const motion = locomotion.finalize(support, planned, null);

    assert.ok(Math.abs(motion.tippingMargin - 0.7) < 1e-6,
        `запас не учел CoP: ${motion.tippingMargin.toFixed(3)}`);
    assert.equal(support.loadRatio, 0.5, 'загрузка стоек потерялась из опоры');
});

test('крутой склон режет ход, предельный — запрещает шаг', async () => {
    const world = await createPhysicsWorld();
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(false));
    world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.85, 1.85).setMass(MECH.mass), body);
    body.setGravityScale(0.0, true);

    const locomotion = createLocomotion({ body });
    const state = locomotion.readBodyState();

    const atSlope = (slope) => locomotion.update(
        FIXED_DT,
        makeSupport({ slope, pitchSlope: 0.62, rollSlope: 0.62 }),
        makeCommand({ throttle: 1 }),
        state,
        null
    );

    const flat = atSlope(0.0);
    const walkEdge = atSlope(MECH.slopeWalkMax);
    const crawlEdge = atSlope(MECH.slopeCrawlMax);
    const limitEdge = atSlope(MECH.slopeLimit);
    const cliff = atSlope(0.95);

    assert.ok(Math.abs(flat.signedWalkSpeed) > 2.0, 'на ровном месте скорость потерялась');
    assert.ok(walkEdge.slopeFactor > 0.99, 'до 22° скорость режется');
    assert.ok(Math.abs(crawlEdge.slopeFactor - MECH.slopeCrawlSpeed) < 0.02, 'на 30° нет осторожного шага');
    assert.ok(Math.abs(limitEdge.slopeFactor - MECH.slopeMinSpeed) < 0.02, 'на 35° нет ползучей скорости');
    assert.equal(cliff.slopeFactor, 0.0, 'на предельном склоне шаг не запрещен');
    assert.ok(Math.abs(crawlEdge.signedWalkSpeed) < Math.abs(flat.signedWalkSpeed) * 0.6,
        'на 30° скорость почти не урезана');
});
