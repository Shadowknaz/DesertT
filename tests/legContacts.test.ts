// Инварианты силовых контактов лап: опора держит корпус, без опоры привода
// нет, а трение песка ограничивает разгон эллипсом сцепления.
// Проверяется на настоящем Rapier: те же силы, что и в игре.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from 'three';
import { MECH, PHYSICS, SANDFIELD } from '../src/config.ts';
import { createLegContacts } from '../src/mech/legContacts.ts';
import { RAPIER, createPhysicsWorld } from '../src/world/physics.ts';

// Плоскость опоры для синтетического трипода: ровная, на высоте земли.
const PLANE = {
    supportY: 0.0,
    pitchSlope: 0.0,
    rollSlope: 0.0,
    slope: 0.0,
    plantedCount: 3,
    tippingMargin: 1.2
};

async function makeRig(spots = [
    // Трипод, симметричный относительно центра масс: центр полигона
    // совпадает с проекцией COM, и корпус не клюет носом сам по себе.
    { x: -1.6, z: 0.9 },
    { x: 1.6, z: 0.9 },
    { x: 0.0, z: -1.8 }
]) {
    const world = await createPhysicsWorld();

    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0.0, MECH.rideHeight, 0.0)
            .setLinearDamping(0.05)
            .setAngularDamping(1.2)
            .setCanSleep(false)
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(2.0, 0.85, 1.85)
            .setTranslation(0.0, 0.35, 0.0)
            .setMass(MECH.mass),
        body
    );

    const legs = spots.map(spot => ({
        currentFootPos: { x: spot.x, y: 0.0, z: spot.z },
        isPlanted: true,
        isStepping: false,
        groundNormal: { x: 0.0, y: 1.0, z: 0.0 },
        packing: 0.0,
        normalLoad: 0.0
    }));

    const contacts = createLegContacts({ body, legs });
    return { world, body, legs, contacts };
}

function motionOf(body, driveZ = 0.0) {
    const t = body.translation();
    const v = body.linvel();
    const av = body.angvel();
    return {
        bodyPos: { x: t.x, y: t.y, z: t.z },
        bodyVel: { x: v.x, y: v.y, z: v.z },
        bodyAngVel: { x: av.x, y: av.y, z: av.z },
        flatFwd: { x: 0.0, y: 0.0, z: 1.0 },
        flatRight: { x: 1.0, y: 0.0, z: 0.0 },
        driveForceX: 0.0,
        driveForceZ: driveZ,
        attitudeTorqueX: 0.0,
        attitudeTorqueZ: 0.0,
        yawTorque: 0.0
    };
}

test('стоящие лапы держат корпус на посадочной высоте', async () => {
    const { world, body, contacts } = await makeRig();

    for (let i = 0; i < 180; i++) {
        contacts.solve(motionOf(body), PLANE);
        world.step();
    }

    const t = body.translation();
    const v = body.linvel();

    assert.ok(Number.isFinite(t.y), 'высота корпуса стала NaN');
    assert.ok(Math.abs(t.y - MECH.rideHeight) < 0.12, `корпус ушел на ${t.y.toFixed(3)}`);
    assert.ok(Math.abs(v.y) < 0.35, `корпус не успокоился: vy=${v.y.toFixed(3)}`);
});

test('без опоры привода нет: мех не едет и падает', async () => {
    const { world, body, legs, contacts } = await makeRig();
    for (const leg of legs) leg.isPlanted = false;

    for (let i = 0; i < 30; i++) {
        contacts.solve(motionOf(body, MECH.mass * 100.0), PLANE);
        world.step();
    }

    const v = body.linvel();
    assert.ok(Math.abs(v.z) < 1e-6, 'корпус разогнался без опоры');
    assert.ok(v.y < -5.0, 'корпус не падает без опоры');
});

test('в полете стопы не держат корпус и не дают тяги', async () => {
    const { world, body, contacts } = await makeRig();

    for (let i = 0; i < 20; i++) {
        // Лапы формально стоят, но тело в воздухе: контакты должны молчать
        const motion = { ...motionOf(body, MECH.mass * 100.0), airborne: true };
        contacts.solve(motion, PLANE);
        world.step();
    }

    const v = body.linvel();
    assert.ok(Math.abs(v.z) < 1e-6, 'в полете появилась тяга');
    assert.ok(v.y < -3.0, `в полете опора держит корпус: vy=${v.y.toFixed(2)}`);
});

test('эллипс сцепления ограничивает разгон рыхлым песком', async () => {
    const { world, body, contacts } = await makeRig();

    contacts.solve(motionOf(body, MECH.mass * 100.0), PLANE);
    world.step();

    const v = body.linvel();
    const debug = contacts.getDebug();

    // Предел рыхлого песка: mu * g = 0.5 * 18 = 9 м/с^2 за один шаг
    assert.ok(v.z > 0.0, 'корпус не получил тягу');
    assert.ok(v.z < 0.2, `песок не ограничил тягу: vz=${v.z.toFixed(3)}`);
    assert.ok(debug.saturation > 0.5, 'force-request saturation must be reported');
    assert.equal(debug.slip, 0, 'saturation alone is not accepted anchor motion');
    assert.ok(debug.normal > MECH.mass * 9.0, 'нормальная сила опоры слишком мала');
});

test('стоящая, но повисшая лапа не держит корпус', async () => {
    const { world, body, legs, contacts } = await makeRig();

    // Флаг фазы шага стоит, но стопа висит над песком: опоры нет.
    for (const leg of legs) leg.groundGap = 0.5;

    for (let i = 0; i < 30; i++) {
        contacts.solve(motionOf(body), PLANE);
        world.step();
    }

    const v = body.linvel();
    assert.equal(contacts.getDebug().normal, 0.0, 'повисшие лапы создали опору');
    assert.ok(v.y < -2.0, `корпус не падает: vy=${v.y.toFixed(2)}`);
});

test('зависшая лапа не получает долю веса', async () => {
    // Четвертая лапа висит: оставшиеся три симметричны и держат весь вес.
    const { body, legs, contacts } = await makeRig([
        { x: -1.6, z: 0.9 },
        { x: 1.6, z: 0.9 },
        { x: 0.0, z: -1.8 },
        { x: 0.0, z: 2.6 }
    ]);
    legs[3].groundGap = 0.5;

    contacts.solve(motionOf(body), PLANE);
    const debug = contacts.getDebug();
    const bodyWeight = MECH.mass * Math.abs(PHYSICS.gravity);

    assert.equal(legs[3].normalForce, 0.0, 'зависшая лапа нагружена');
    assert.ok(legs[0].normalForce > 0.0, 'опора потерялась');
    assert.equal(debug.planted, 3, 'в опоре осталось неверное число лап');
    assert.ok(Math.abs(debug.normal - bodyWeight) < 1.0,
        `вес не перераспределен: ${debug.normal.toFixed(0)} вместо ${bodyWeight.toFixed(0)}`);
});

test('нормальная реакция идет по нормали песка, а не по вертикали', async () => {
    const { world, body, legs, contacts } = await makeRig();

    // Склон поднимается к +x: нормаль наклонена в -x. Без тяги корпус
    // должен сползать вниз по склону, а не висеть на вертикальной силе.
    for (const leg of legs) leg.groundNormal = { x: -0.4472, y: 0.8944, z: 0.0 };

    for (let i = 0; i < 15; i++) {
        contacts.solve(motionOf(body), PLANE);
        world.step();
    }

    const v = body.linvel();
    assert.ok(v.x < -0.05, `нормаль не толкнула корпус вниз: vx=${v.x.toFixed(3)}`);
});

const vec = value => new THREE.Vector3(value.x, value.y, value.z);
function close(actual, expected, tolerance = 1e-8) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
async function tractionRig(t, normal = new THREE.Vector3(0, 1, 0)) {
    const rig = await makeRig();
    t.after(() => rig.world.free());
    for (const leg of rig.legs) {
        leg.supportForce = 500;
        leg.groundNormal = normal.clone();
        leg.groundContact = { y: 0, normal: normal.clone(), surfaceType: 'sand',
            colliderHandle: 7, packing: 0, friction: 0.5, sink: 0 };
    }
    return rig;
}

for (const [name, gx, gz] of [['longitudinal', 0, 0.65], ['transverse', 0.65, 0], ['diagonal', 0.4, 0.5]]) {
    test(`full tangent ellipse on ${name} slope is invariant under scene yaw`, async t => {
        const rig = await tractionRig(t);
        for (const direction of [[0, 1], [1, 0], [1, 1], [-1, 0.6]]) {
            let baseline = null;
            for (const yaw of [0, 0.7, Math.PI / 2, 2.8]) {
                const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
                const n = new THREE.Vector3(-gx, 1, -gz).normalize().applyQuaternion(rotation);
                const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
                const drive = new THREE.Vector3(direction[0], 0, direction[1]).multiplyScalar(10000).applyQuaternion(rotation);
                const tf = forward.clone().addScaledVector(n, -forward.dot(n)).normalize();
                const ts = n.clone().cross(tf);
                for (const leg of rig.legs) leg.groundNormal.copy(n);
                rig.contacts.solve({ ...motionOf(rig.body), flatFwd: forward,
                    driveForceX: drive.x, driveForceZ: drive.z }, { loadsSolved: true });
                for (const leg of rig.legs) {
                    const applied = vec(leg.tangentApplied);
                    const requested = drive.clone().multiplyScalar(1 / 3).projectOnPlane(n);
                    const rho = Math.hypot(requested.dot(tf) / 250, requested.dot(ts) / (250 * 0.85));
                    close(applied.dot(n), 0);
                    close(vec(leg.tangentRequested).distanceTo(requested), 0);
                    close(applied.distanceTo(requested.divideScalar(Math.max(1, rho))), 0);
                    close(Math.hypot(applied.dot(tf) / 250, applied.dot(ts) / (250 * 0.85)), 1);
                    close(vec(leg.yieldVelocity).dot(n), 0);
                    assert.ok(vec(leg.yieldVelocity).length() <= 1.5 + 1e-12);
                    close(leg.supportForce, 500);
                    close(leg.normalLoad, 500);
                    if (baseline === null) baseline = applied.length();
                    else close(applied.length(), baseline);
                }
            }
        }
    });
}

test('degenerate tangent headings and zero normal have finite orthogonal fallbacks', async t => {
    const { body, legs, contacts } = await tractionRig(t);
    for (const n of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(-0.4, 1, -0.2).normalize(), new THREE.Vector3()]) {
        const effectiveNormal = n.length() ? n : new THREE.Vector3(0, 1, 0);
        for (const heading of [n, n.clone().add(new THREE.Vector3(1e-12, 0, 0)), new THREE.Vector3()]) {
            for (const leg of legs) leg.groundNormal.copy(n);
            contacts.solve({ ...motionOf(body, 10000), driveForceX: 4000, flatFwd: heading }, { loadsSolved: true });
            for (const leg of legs) {
                const actual = vec(leg.tangentApplied);
                assert.ok(Object.values(leg.tangentApplied).every(Number.isFinite));
                close(actual.dot(effectiveNormal), 0);
                assert.ok(actual.length() <= 250 + 1e-8);
                assert.ok(actual.length() >= 250 * 0.85 - 1e-8);
            }
        }
    }
});

test('zero loads and zero solid friction produce no phantom traction or nonfinite values', async t => {
    const { body, legs, contacts } = await tractionRig(t);
    for (const load of [0, 1e-12, 500]) {
        for (const leg of legs) {
            leg.supportForce = load;
            leg.groundContact.surfaceType = 'solid';
            leg.groundContact.friction = 0;
        }
        const debug = contacts.solve(motionOf(body, 100000), { loadsSolved: true });
        assert.equal(debug.tangent, 0);
        assert.equal(debug.capacity, 0);
        assert.ok(Object.values(debug).every(Number.isFinite));
        for (const leg of legs) {
            assert.equal(leg.pendingAnchorShift, null);
            close(vec(leg.yieldVelocity).length(), 0);
            close(vec(leg.tangentApplied).length(), 0);
            close(leg.normalLoad, load > 1e-3 ? load : 0);
            close(leg.supportForce, load);
        }
    }
});

test('sand traction clamps current packing while solid retains its selected friction', async t => {
    const { body, legs, contacts } = await tractionRig(t);
    for (const [packing, mu] of [[-1, 0.5], [0, 0.5], [0.5, 0.725], [1, 0.95], [2, 0.95]]) {
        for (const leg of legs) {
            leg.packing = 1 - packing; // Deliberately stale cached packing.
            leg.groundContact.packing = packing;
            leg.groundContact.friction = 99;
        }
        contacts.solve(motionOf(body, 10000), { loadsSolved: true });
        close(contacts.getDebug().capacity, mu * 1500);
        for (const leg of legs) close(leg.tangentForce, mu * 500);
    }
    for (const friction of [0.12, 0.9, 1.2]) {
        for (const leg of legs) Object.assign(leg.groundContact, { surfaceType: 'solid', friction });
        contacts.solve(motionOf(body, 10000), { loadsSolved: true });
        close(contacts.getDebug().capacity, friction * 1500);
        assert.equal(contacts.getDebug().slip, 0);
        assert.ok(legs.every(leg => leg.pendingAnchorShift === null));
    }
});

test('yield opposes unmet demand, uses the effective gain and dt, and caps at 1.5 m/s', async t => {
    const { body, legs, contacts } = await tractionRig(t);
    const dt = 0.012;
    for (const gain of [4, 8, 12]) {
        const motion = { ...motionOf(body, 1050), velocityGain: gain };
        contacts.solve(motion, { loadsSolved: true }, dt);
        for (const leg of legs) {
            close(leg.yieldVelocity.z, -100 / (MECH.mass * gain / 3));
            close(leg.yieldVelocity.x, 0);
            close(leg.yieldVelocity.y, 0);
            close(leg.pendingAnchorShift.z, leg.yieldVelocity.z * dt);
            assert.notEqual(leg.pendingAnchorShift.surface, leg.groundContact);
            assert.notEqual(leg.pendingAnchorShift.surface.normal, leg.groundContact.normal);
        }
        assert.equal(contacts.getDebug().slip, 0, 'unconsumed yielding is not motion');
    }
    contacts.solve({ ...motionOf(body, 100000), driveForceX: -100000 }, { loadsSolved: true });
    for (const leg of legs) {
        close(vec(leg.yieldVelocity).length(), SANDFIELD.maxSlipSpeed);
        assert.ok(leg.yieldVelocity.x > 0 && leg.yieldVelocity.z < 0);
    }
    contacts.solve(motionOf(body, 200), { loadsSolved: true });
    for (const leg of legs) {
        assert.equal(leg.forceSaturation, 0);
        assert.equal(leg.pendingAnchorShift, null);
        close(vec(leg.yieldVelocity).length(), 0);
    }
});

test('unequal loads use total applied load, including solids, in the yield coefficient', async t => {
    const { body, legs, contacts } = await tractionRig(t);
    [100, 300, 1100].forEach((load, i) => { legs[i].supportForce = load; });
    legs[1].groundContact.surfaceType = 'solid';
    legs[1].groundContact.friction = 0.2;
    contacts.solve({ ...motionOf(body, 1500), velocityGain: 8 }, { loadsSolved: true });
    for (const i of [0, 2]) {
        const leg = legs[i];
        const alpha = leg.normalLoad / 1500;
        close(leg.tangentRequested.z, 1500 * alpha);
        close(leg.yieldVelocity.z, -(leg.tangentRequested.z - leg.tangentApplied.z) / (MECH.mass * 8 * alpha));
        close(leg.yieldVelocity.z, -750 / (MECH.mass * 8));
    }
    close(vec(legs[1].yieldVelocity).length(), 0);
    assert.equal(legs[1].pendingAnchorShift, null);
});

test('negligible load shares and velocity coefficients suppress yield without division', async t => {
    const { body, legs, contacts } = await tractionRig(t);
    for (const gain of [0, 1e-15, NaN, Infinity, -1]) {
        contacts.solve({ ...motionOf(body, 100000), velocityGain: gain }, { loadsSolved: true });
        for (const leg of legs) {
            close(vec(leg.yieldVelocity).length(), 0);
            assert.equal(leg.pendingAnchorShift, null);
        }
    }
    legs[0].supportForce = 0.002;
    legs[1].supportForce = legs[2].supportForce = 4000;
    contacts.solve(motionOf(body, 100000), { loadsSolved: true });
    assert.ok(legs[0].normalLoad > 0);
    close(vec(legs[0].yieldVelocity).length(), 0);
    assert.equal(legs[0].pendingAnchorShift, null);
    for (const dt of [0, -1, NaN]) {
        contacts.solve(motionOf(body, 100000), { loadsSolved: true }, dt);
        assert.ok(legs.every(leg => leg.pendingAnchorShift === null));
    }
});
