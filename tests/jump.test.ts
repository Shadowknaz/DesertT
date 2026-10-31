// Реактивный прыжок: разовый импульс сопел, баллистический полет и касание.
// Проверяется на настоящем Rapier, чтобы импульс действительно разгонял
// корпус, а не только выставлял флаг в состоянии.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { MECH, PHYSICS } from '../src/config.ts';
import { getDuneHeight } from '../src/core/duneField.ts';
import { createLocomotion } from '../src/mech/locomotion.ts';
import { RAPIER, createPhysicsWorld } from '../src/world/physics.ts';

const FIXED_DT = PHYSICS.fixedDt;

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
        jumpHeld: false,
        ...overrides
    };
}

// Стойки держат корпус на посадочной высоте, но контактов в этом мире нет:
// проверяется только баллистика прыжка и его состояние.
async function makeMech() {
    const world = await createPhysicsWorld();
    const groundY = getDuneHeight(0.0, 0.0);
    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0.0, groundY + MECH.rideHeight, 0.0)
            .setCanSleep(false)
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(2.0, 0.85, 1.85).setMass(MECH.mass),
        body
    );

    const locomotion = createLocomotion({ body });
    return { world, body, locomotion, groundY };
}

test('Shift подбрасывает корпус и возвращает его на песок', async () => {
    const { world, locomotion, groundY } = await makeMech();
    const support = makeSupport({ supportY: groundY });
    const command = makeCommand({ jumpHeld: true });

    let launches = 0;
    let airFrames = 0;
    let landingFrames = 0;
    let peakY = -Infinity;
    let peakVy = 0.0;

    for (let i = 0; i < 240; i++) {
        const state = locomotion.readBodyState();
        const motion = locomotion.update(FIXED_DT, support, command, state, null);

        if (motion.launched) launches++;
        if (motion.airborne) {
            airFrames++;
            peakY = Math.max(peakY, state.bodyPos.y);
            peakVy = Math.max(peakVy, state.bodyVel.y);
        }
        if (motion.landed) landingFrames++;

        world.step();
        if (landingFrames > 0) break;
    }

    const climb = peakY - (groundY + MECH.rideHeight);
    assert.equal(launches, 1, 'прыжок сработал не один раз');
    assert.equal(landingFrames, 1, 'касание не зафиксировано ровно один раз');
    assert.ok(peakVy > 5.0, `импульс сопел слишком слабый: vy=${peakVy.toFixed(2)} м/с`);
    assert.ok(climb > 0.8, `корпус поднялся всего на ${climb.toFixed(2)} м`);
    assert.ok(airFrames > 15, `полет слишком короткий: ${airFrames} подшагов`);

    const state = locomotion.readBodyState();
    const restGap = state.bodyPos.y - MECH.rideHeight - groundY;
    assert.ok(restGap < MECH.jumpLandTolerance,
        `касание объявлено слишком высоко: зазор ${restGap.toFixed(2)} м`);
});

test('без опоры сопла не толкают корпус', async () => {
    const { world, body, locomotion } = await makeMech();
    const support = makeSupport({ supportY: 0.0, plantedCount: 2 });
    const command = makeCommand({ jumpHeld: true });

    let launched = false;
    for (let i = 0; i < 20; i++) {
        const state = locomotion.readBodyState();
        const motion = locomotion.update(FIXED_DT, support, command, state, null);
        if (motion.launched || motion.airborne) launched = true;
        world.step();
    }

    const v = body.linvel();
    assert.equal(launched, false, 'мех прыгнул без опоры');
    assert.ok(v.y < -1.0, 'корпус не падает: импульс все-таки сработал');
});

test('в полете сопла выравнивают корпус, но не меняют курс', async () => {
    const { world, body, locomotion, groundY } = await makeMech();
    const support = makeSupport({ supportY: groundY });

    // Крен задается до прыжка: сопла должны его погасить без разворота
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.0, 0.0, 0.25, 'YXZ'));
    body.setRotation({ x: tilt.x, y: tilt.y, z: tilt.z, w: tilt.w }, true);
    const yawBefore = locomotion.readBodyState().currentYaw;

    let flew = false;
    for (let i = 0; i < 30; i++) {
        const state = locomotion.readBodyState();
        const motion = locomotion.update(
            FIXED_DT, support, makeCommand({ jumpHeld: i === 0 }), state, null
        );
        if (motion.airborne) flew = true;
        world.step();
    }

    assert.ok(flew, 'прыжок не начался');
    const r = body.rotation();
    const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    const yawAfter = locomotion.readBodyState().currentYaw;

    assert.ok(up.y > 0.97, `сопла не выровняли корпус: up.y=${up.y.toFixed(3)}`);
    assert.ok(Math.abs(yawAfter - yawBefore) < 0.05, 'сопла развернули корпус по курсу');
});
