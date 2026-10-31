// Интеграционный тест физики: настоящий Rapier, риг, походка, контакты и
// песок, собранные тем же порядком фаз, что и в приложении. Проверяет, что
// переходные режимы (спавн, разгон, переступание) не роняют мех и не дают
// NaN. Это не рендер: документ подменен заглушкой для текстур.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CHUNK, GAIT, HEXAPOD, MECH, PHYSICS, SANDFIELD } from '../src/config.ts';
import { getDuneHeight } from '../src/core/duneField.ts';
import { RAPIER, createPhysicsWorld } from '../src/world/physics.ts';

// Холст для процедурных текстур: WebGL не нужен, только 2D-контекст.
globalThis.document = {
    createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData() {}
        })
    })
};

const { createMechRig } = await import('../src/mech/mechRig.ts');
const { copyGroundSample, createGroundSampler } = await import('../src/world/groundSampler.ts');
const { createSandField } = await import('../src/world/sandField.ts');
const { createSandDeformer } = await import('../src/world/sandDeformation.ts');
const { createChunkTerrain } = await import('../src/world/terrain.ts');
const { createGaitController } = await import('../src/mech/gait.ts');
const { createLocomotion } = await import('../src/mech/locomotion.ts');
const { createLegContacts } = await import('../src/mech/legContacts.ts');
const { computeFootSupport } = await import('../src/mech/legSupport.ts');
const { evaluateContact, hipOffset, solveNormalLoads } = await import('../src/mech/contactModel.ts');
const { solveHexapodLeg } = await import('../src/mech/hexapodIK.ts');
const { simulatePhysicsStep, advancePhysicsAccumulator } = await import('../src/app.ts');

const SIZE = CHUNK.size;
const SEG = CHUNK.gridSegments;
const CELL = SIZE / SEG;
const HALF = SIZE * 0.5;

async function createCourse(spawnX, spawnZ) {
    const world = await createPhysicsWorld();

    for (let cx = -1; cx <= 1; cx++) {
        for (let cz = -1; cz <= 2; cz++) {
            const heights = new Float32Array((SEG + 1) * (SEG + 1));
            for (let row = 0; row <= SEG; row++) {
                for (let col = 0; col <= SEG; col++) {
                    heights[row + col * (SEG + 1)] = getDuneHeight(
                        cx * SIZE + col * CELL - HALF,
                        cz * SIZE + row * CELL - HALF
                    );
                }
            }
            const ground = world.createRigidBody(
                RAPIER.RigidBodyDesc.fixed().setTranslation(cx * SIZE, 0, cz * SIZE)
            );
            world.createCollider(
                RAPIER.ColliderDesc.heightfield(SEG, SEG, heights, { x: SIZE, y: 1, z: SIZE })
                    .setFriction(0.9),
                ground
            );
        }
    }

    const rig = createMechRig({ scene: new THREE.Scene(), world, spawnX, spawnZ });
    const sandField = createSandField();
    for (let cx = -1; cx <= 1; cx++) {
        for (let cz = -1; cz <= 2; cz++) sandField.attachChunk(cx, cz);
    }

    const sampler = createGroundSampler({
        world,
        mechBodies: [rig.body],
        ignoredBodyHandles: rig.footBodyHandles,
        sandField
    });
    const gait = createGaitController({
        legs: rig.legs,
        sampler,
        dust: { spawnSplash() {} },
        sandField,
        syncBody: rig.syncFromMotion
    });
    const locomotion = createLocomotion({
        body: rig.body,
        groundAt: (x, z) => sampler.sample(x, z).y
    });
    const contacts = createLegContacts({ body: rig.body, legs: rig.legs });

    const dt = PHYSICS.fixedDt;

    // Exercise production orchestration instead of a copied phase sequence.
    const simulation = { rig, locomotion, gait, contacts, world };
    function step(command) {
        const { support } = simulatePhysicsStep(simulation, dt, command);

        const t = rig.body.translation();
        const r = rig.body.rotation();
        const up = 1 - 2 * (r.x * r.x + r.z * r.z);
        const finite = Number.isFinite(t.x) && Number.isFinite(t.y)
            && Number.isFinite(t.z) && Number.isFinite(up);
        return {
            x: t.x, y: t.y, z: t.z, up, finite,
            loadRatio: support.loadRatio,
            planted: support.plantedCount
        };
    }

    return { world, rig, step, dt };
}

function command(throttle = 0.0) {
    return {
        throttle,
        turnInput: 0.0,
        desiredYawRate: 0.0,
        yawError: 0.0,
        isManual: true,
        stompHeld: false,
        jumpHeld: false
    };
}

test('стояние на склоне: без NaN, без падения, малый дрейф', async () => {
    const { step, dt } = await createCourse(-4, 18);
    const start = step(command(0.0));

    let minUp = 1.0;
    let end = start;
    for (let i = 0; i < Math.round(6 / dt); i++) {
        end = step(command(0.0));
        if (end.up < minUp) minUp = end.up;
        assert.ok(end.finite, `NaN на шаге ${i}`);
    }

    const drift = Math.hypot(end.x - start.x, end.z - start.z);
    assert.ok(drift < 0.6, `мех уехал на ${drift.toFixed(2)} м`);
    assert.ok(minUp > 0.9, `корпус накренился до up=${minUp.toFixed(2)}`);
    assert.ok(end.y > -5.0, `корпус провалился на y=${end.y.toFixed(2)}`);
});

test('ходьба 10 с: проходит дистанцию, не опрокидывается', async () => {
    const { step, dt } = await createCourse(0, 0);
    const start = step(command(1.0));

    let minUp = 1.0;
    let end = start;
    let loadSum = 0.0;
    let loadedSteps = 0;
    const steps = Math.round(10 / dt);
    for (let i = 0; i < steps; i++) {
        end = step(command(1.0));
        if (end.up < minUp) minUp = end.up;
        loadSum += end.loadRatio;
        if (end.loadRatio > 0.3) loadedSteps++;
        assert.ok(end.finite, `NaN на шаге ${i}`);
    }

    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    const averageLoad = loadSum / steps;

    assert.ok(distance > 8.0, `мех прошел всего ${distance.toFixed(1)} м`);
    assert.ok(minUp > 0.8, `корпус накренился до up=${minUp.toFixed(2)}`);
    assert.ok(averageLoad > 0.6, `средняя опора ${averageLoad.toFixed(2)}`);
    assert.ok(loadedSteps > steps * 0.85,
        `опора была только ${loadedSteps} из ${steps} шагов`);
});

// Block-one regressions use the real mesh hierarchy and offset Rapier collider.
const BODY_WEIGHT = MECH.mass * Math.abs(PHYSICS.gravity);
const FLAT_PLANE = { supportY: 0, pitchSlope: 0, rollSlope: 0 };
const vector = value => new THREE.Vector3(value.x, value.y, value.z);
function near(actual, expected, tolerance = 1e-5) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function nearVector(actual, expected, tolerance = 1e-5) {
    near(actual.x, expected.x, tolerance);
    near(actual.y, expected.y, tolerance);
    near(actual.z, expected.z, tolerance);
}
function supportPose(state, extra = {}) {
    return {
        y: state.bodyPos.y, quat: state.bodyQuat, com: state.bodyCom,
        vel: state.bodyVel, angVel: state.bodyAngVel, ...extra
    };
}
function contactLeg(x, y, z) {
    return {
        currentFootPos: new THREE.Vector3(x, y, z),
        groundNormal: new THREE.Vector3(0, 1, 0),
        groundGap: 0, isPlanted: true, isStepping: false, normalLoad: 123
    };
}
function squareFeet(halfX = 2, halfZ = 2, height = () => 0) {
    return [-halfX, halfX].flatMap(x => [-halfZ, halfZ].map(z => contactLeg(x, height(x, z), z)));
}
async function flatRig(t) {
    const world = await createPhysicsWorld();
    t.after(() => world.free());
    const rig = createMechRig({ scene: new THREE.Scene(), world });
    rig.body.setTranslation({ x: 0, y: MECH.rideHeight, z: 0 }, true);
    for (const leg of rig.legs) {
        leg.currentFootPos.set(leg.restLocal.x, 0, leg.restLocal.z);
        leg.stepStartPos.copy(leg.currentFootPos);
        leg.stepTargetPos.copy(leg.currentFootPos);
        leg.groundGap = 0;
    }
    const locomotion = createLocomotion({ body: rig.body, groundAt: () => 0 });
    return { world, rig, locomotion };
}

test('tilted real rig: both visual sync paths match physical mounts and IK reach', async t => {
    const { rig, locomotion } = await flatRig(t);
    const check = state => {
        nearVector(rig.chassisGroup.getWorldPosition(new THREE.Vector3()), state.bodyPos);
        const rootExpected = state.bodyPos.clone().sub(
            new THREE.Vector3(0, MECH.rideHeight, 0).applyQuaternion(state.bodyQuat)
        );
        nearVector(rig.root.position, rootExpected);
        for (const leg of rig.legs) {
            const hip = hipOffset(state.bodyQuat, leg.hipLocal, {});
            nearVector(leg.mountNode.getWorldPosition(new THREE.Vector3()), vector(hip).add(state.bodyPos));
            for (const stretch of [0.97, 1.02, 1.07]) {
                const reach = (HEXAPOD.femurLength + HEXAPOD.tibiaLength) * 0.992 * stretch;
                const localAnkle = new THREE.Vector3(0, -reach * Math.sqrt(0.96), HEXAPOD.coxaOffset + reach * 0.2);
                const ankle = leg.mountNode.localToWorld(localAnkle);
                leg.currentFootPos.copy(ankle).add(new THREE.Vector3(0, -HEXAPOD.ankleHeight * HEXAPOD.scale, 0));
                const expected = stretch <= 1 ? 1 : Math.max(0, 1 - (stretch - 1) / MECH.contactReachSlack);
                near(evaluateContact(leg, state.bodyPos, state.bodyQuat).reachFactor, expected, 2e-5);
                if (stretch < 1) {
                    solveHexapodLeg(leg, leg.currentFootPos);
                    nearVector(leg.footGroup.getWorldPosition(new THREE.Vector3()), ankle);
                }
            }
        }
    };
    for (const angles of [[0, 0, 0], [0.35, 0.7, -0.4], [-0.6, -1.1, 0.5], [1.3, 0.2, -0.8]]) {
        rig.body.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles, 'YXZ')), true);
        rig.body.setTranslation({ x: 2.5, y: 4, z: -3 }, true);
        rig.syncVisuals();
        const state = locomotion.readBodyState();
        check(state);
        // A deliberately different snapshot catches implementations reading the body here.
        const next = { ...state, bodyPos: state.bodyPos.clone().add(new THREE.Vector3(1, 0.4, -0.3)) };
        rig.syncFromMotion(next);
        check(next);
    }
});

test('snapshot separates body origin, world CoM and CoM velocity', async t => {
    const { rig, locomotion } = await flatRig(t);
    rig.body.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0.6, -0.5, 'YXZ')), true);
    rig.body.setLinvel({ x: 0.4, y: -0.7, z: 0.2 }, true);
    rig.body.setAngvel({ x: 0.2, y: 0.1, z: -0.3 }, true);
    const state = locomotion.readBodyState();
    nearVector(rig.body.localCom(), new THREE.Vector3(0, HEXAPOD.hullOffsetY, 0));
    nearVector(state.bodyPos, rig.body.translation());
    nearVector(state.bodyCom, vector(rig.body.localCom()).applyQuaternion(state.bodyQuat).add(state.bodyPos));
    nearVector(state.bodyCom, rig.body.worldCom());
    nearVector(state.bodyVel, rig.body.linvel());
    nearVector(state.bodyAngVel, rig.body.angvel());
    assert.ok(state.bodyCom.distanceTo(state.bodyPos) > 0.34);
    const saved = state.bodyCom.clone();
    rig.body.setTranslation({ x: 10, y: 20, z: 30 }, true);
    locomotion.readBodyState();
    nearVector(state.bodyCom, saved);
});

test('normal damping uses vCOM plus angular velocity crossed with foot minus CoM', async t => {
    const { rig, locomotion } = await flatRig(t);
    rig.body.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0.6, -0.5, 'YXZ')), true);
    rig.body.setLinvel({ x: 0.03, y: -0.04, z: 0.01 }, true);
    rig.body.setAngvel({ x: 0.2, y: 0.1, z: -0.3 }, true);
    const state = locomotion.readBodyState();
    const legs = [contactLeg(-1.2, 0, -0.5), contactLeg(1.2, 0, 0.5)];
    const normal = new THREE.Vector3(0.2, 1, -0.1).normalize();
    for (const leg of legs) leg.groundNormal.copy(normal);
    const expected = legs.map(leg => {
        const arm = leg.currentFootPos.clone().sub(state.bodyCom);
        const pointVel = state.bodyAngVel.clone().cross(arm).add(state.bodyVel);
        const originVel = state.bodyAngVel.clone().cross(leg.currentFootPos.clone().sub(state.bodyPos)).add(state.bodyVel);
        assert.ok(Math.abs(pointVel.dot(normal) - originVel.dot(normal)) > 0.01);
        return BODY_WEIGHT / 2 + MECH.contactStiffness * (MECH.rideHeight - state.bodyPos.y)
            - MECH.contactDamping * pointVel.dot(normal);
    });
    solveNormalLoads(legs, state.bodyPos, state.bodyQuat, state.bodyVel, state.bodyAngVel,
        FLAT_PLANE, Infinity, state.bodyCom);
    legs.forEach((leg, i) => {
        near(leg.supportForce, expected[i], 0.003);
        assert.equal(leg.normalLoad, 123, 'prediction must not overwrite applied load');
    });
    // Standalone contact callers also get Rapier CoM, even without the new field.
    const { bodyCom, ...legacyState } = state;
    const contacts = createLegContacts({ body: rig.body, legs });
    contacts.solve({ ...legacyState, driveForceX: 0, driveForceZ: 0,
        attitudeTorqueX: 0, attitudeTorqueZ: 0, yawTorque: 0 }, FLAT_PLANE);
    legs.forEach((leg, i) => near(leg.normalLoad, expected[i], 0.003));
});

test('support margin, preload balance and finalized CoP shift use world CoM', async t => {
    const { rig, locomotion } = await flatRig(t);
    rig.body.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0.4, 0.6, 'YXZ')), true);
    const state = locomotion.readBodyState();
    const legs = squareFeet();
    const support = computeFootSupport(legs, state.bodyPos.x, state.bodyPos.z, supportPose(state));
    near(support.supportY, 0);
    near(support.tippingMargin, Math.min(2 - Math.abs(state.bodyCom.x), 2 - Math.abs(state.bodyCom.z)));
    near(support.copX, state.bodyCom.x, 1e-4);
    near(support.copZ, state.bodyCom.z, 1e-4);
    const moment = new THREE.Vector3();
    for (const leg of legs) moment.add(leg.currentFootPos.clone().sub(state.bodyCom)
        .cross(new THREE.Vector3(0, leg.supportForce, 0)));
    assert.ok(moment.length() < 0.1);
    const planned = locomotion.plan(PHYSICS.fixedDt, support, command(), state);
    near(locomotion.finalize(support, planned).tippingMargin, support.tippingMargin, 1e-4);
    const narrow = computeFootSupport(squareFeet(0.1, 2), 0, 0, supportPose(state, { solveLoads: false }));
    assert.ok(narrow.tippingMargin < 0, 'CoM is outside while the body origin remains inside');
});

test('offset CoM CoP intersects the origin-anchored sloped support plane', async t => {
    const { rig, locomotion } = await flatRig(t);
    const height = (x, z) => 0.7 + 0.3 * x - 0.2 * z;
    rig.body.setTranslation({ x: 0.6, y: height(0.6, 0.3) + MECH.rideHeight, z: 0.3 }, true);
    rig.body.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.8, -0.4, 'YXZ')), true);
    const state = locomotion.readBodyState();
    const legs = squareFeet(3, 3, height);
    for (const leg of legs) leg.groundNormal.set(-0.3, 1, 0.2).normalize();
    const support = computeFootSupport(legs, state.bodyPos.x, state.bodyPos.z, supportPose(state));
    near(support.supportY, height(state.bodyPos.x, state.bodyPos.z));
    assert.ok(support.copValid);
    const weighted = new THREE.Vector3();
    let load = 0;
    for (const leg of legs) {
        weighted.addScaledVector(leg.currentFootPos, leg.supportForce);
        load += leg.supportForce;
    }
    weighted.divideScalar(load);
    near(support.copX, weighted.x);
    near(support.copZ, weighted.z);
});

test('weak-only contacts are solved before finalize without inventing a polygon', async t => {
    const { rig, locomotion } = await flatRig(t);
    const state = locomotion.readBodyState();
    const legs = squareFeet();
    for (const leg of legs) leg.contactBlend = 0.3;
    const support = computeFootSupport(legs, 0, 0, supportPose(state, { commitSupport: true }));
    assert.equal(support.plantedCount, 0);
    assert.equal(support.tippingMargin, 0);
    assert.equal(support.loadsSolved, true);
    assert.ok(support.loadNormal > 0);
    const predicted = legs.map(leg => leg.supportForce);
    const contacts = createLegContacts({ body: rig.body, legs });
    // If contacts solves again, this changed velocity would erase the loads.
    contacts.solve({ ...state, bodyVel: new THREE.Vector3(0, 100, 0), driveForceX: 0, driveForceZ: 0,
        attitudeTorqueX: 0, attitudeTorqueZ: 0, yawTorque: 0 }, support);
    legs.forEach((leg, i) => near(leg.normalLoad, predicted[i]));
    for (const leg of legs) leg.isPlanted = false;
    const empty = computeFootSupport(legs, 0, 0, supportPose(state, { commitSupport: true }));
    assert.equal(empty.loadsSolved, true);
    assert.equal(empty.loadNormal, 0);
    assert.ok(legs.every(leg => leg.supportForce === 0));
});

test('recovery refreshes the origin and world CoM before gait sees the new pose', async t => {
    const { rig, locomotion } = await flatRig(t);
    rig.body.setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.5, 1.4, 'YXZ')), true);
    const support = computeFootSupport(squareFeet(), 0, 0, { y: MECH.rideHeight, solveLoads: false });
    let planned;
    for (let i = 0; i <= Math.ceil(MECH.tipRecoverDelay / PHYSICS.fixedDt); i++) {
        planned = locomotion.plan(PHYSICS.fixedDt, support, command(), locomotion.readBodyState());
        if (planned.recovery) break;
    }
    assert.ok(planned.recovery);
    nearVector(planned.bodyPos, rig.body.translation());
    nearVector(planned.bodyCom, rig.body.worldCom());
    nearVector(planned.bodyCom, planned.bodyPos.clone().add(new THREE.Vector3(0, HEXAPOD.hullOffsetY, 0)));
    rig.syncFromMotion(planned);
    nearVector(rig.chassisGroup.getWorldPosition(new THREE.Vector3()), planned.bodyPos);
});

for (const event of ['step', 'stomp', 'both', 'jump']) {
    test(`production substep refreshes velocities after ${event} impulses and solves loads once`, async t => {
        const { rig, locomotion, world } = await flatRig(t);
        const trace = [];
        let loadResets = 0;
        for (const leg of rig.legs) {
            let force = 777;
            Object.defineProperty(leg, 'supportForce', {
                get: () => force,
                set: value => { if (value === 0) loadResets++; force = value; },
                configurable: true
            });
        }
        const read = locomotion.readBodyState;
        const plan = locomotion.plan;
        const finalize = locomotion.finalize;
        const stepImpact = locomotion.registerStepImpact;
        const stompImpact = locomotion.registerStompImpact;
        locomotion.readBodyState = () => { trace.push('snapshot'); return read(); };
        locomotion.plan = (...args) => {
            trace.push('plan');
            assert.equal(args[1].loadsSolved, false);
            assert.equal(loadResets, 0);
            return plan(...args);
        };
        locomotion.registerStepImpact = () => { trace.push('step impulse'); stepImpact(); };
        locomotion.registerStompImpact = () => { trace.push('stomp impulse'); stompImpact(); };
        locomotion.finalize = (support, motion) => {
            trace.push('finalize');
            assert.equal(support.loadsSolved, true);
            assert.equal(loadResets, rig.legs.length, 'one load-solver reset per leg');
            nearVector(motion.bodyVel, rig.body.linvel());
            nearVector(motion.bodyAngVel, rig.body.angvel());
            assert.ok(Math.abs(motion.bodyAngVel.y) > 1e-5, 'angular impulse must be in the refreshed snapshot');
            return finalize(support, motion);
        };
        const realContacts = createLegContacts({ body: rig.body, legs: rig.legs });
        const contacts = { solve(motion, support, dt) {
            trace.push('contacts');
            near(dt, PHYSICS.fixedDt, 1e-12);
            realContacts.solve(motion, support, dt);
            assert.equal(loadResets, rig.legs.length, 'contacts must reuse the load solution');
        } };
        const gait = {
            update(dt, motion) {
                trace.push('gait');
                near(dt, PHYSICS.fixedDt);
                rig.body.applyTorqueImpulse({ x: 0, y: 0.7, z: 0 }, true);
                if (motion.airborne) for (const leg of rig.legs) leg.isPlanted = false;
                return { finishedStep: event === 'step' || event === 'both', stomped: event === 'stomp' || event === 'both' };
            },
            applySand(dt, motion) {
                trace.push('sand');
                nearVector(motion.bodyVel, rig.body.linvel());
                for (const leg of rig.legs) near(leg.normalLoad, leg.supportForce);
            }
        };
        const steppingWorld = { step() { trace.push('world'); world.step(); } };
        const { motion, support } = simulatePhysicsStep({ rig, locomotion, gait, contacts, world: steppingWorld },
            PHYSICS.fixedDt, { ...command(), jumpHeld: event === 'jump' });
        const impulses = event === 'both' ? ['step impulse', 'stomp impulse']
            : event === 'jump' ? [] : [`${event} impulse`];
        assert.deepEqual(trace, ['snapshot', 'plan', 'gait', ...impulses, 'snapshot', 'finalize', 'contacts', 'sand', 'world']);
        if (event === 'jump') {
            assert.ok(motion.launched && motion.airborne);
            near(motion.bodyVel.y, MECH.jumpImpulse / MECH.mass);
            assert.equal(support.loadNormal, 0);
        } else {
            const impulse = (event !== 'stomp' ? MECH.stepImpactImpulse : 0)
                + (event !== 'step' ? MECH.stompImpulse : 0);
            near(motion.bodyVel.y, -impulse / MECH.mass);
            assert.ok(support.loadNormal > BODY_WEIGHT * 1.1, 'same-step damping must see the downward impact');
        }
    });
}

for (const event of ['step', 'stomp', 'landing']) {
    test(`gait re-samples all contacts after synchronized ${event} impacts, before IK`, async t => {
        const { rig, locomotion } = await flatRig(t);
        let stamps = 0;
        let synced = 0;
        let height = 0;
        const trace = [];
        const normal = new THREE.Vector3(0, 1, 0);
        const sharedSample = { y: 0, normal: new THREE.Vector3(), surfaceType: 'sand',
            colliderHandle: null, packing: 0, friction: SANDFIELD.gripLoose, sink: 0 };
        const sampler = { sample() {
            assert.equal(synced, stamps, 'surface sampled before immediate collider synchronization');
            trace.push('sample');
            sharedSample.y = height;
            sharedSample.normal.copy(normal);
            return sharedSample;
        } };
        const impact = () => { stamps++; trace.push('impact'); };
        const gait = createGaitController({
            legs: rig.legs, sampler, dust: { spawnSplash() {} }, syncBody: rig.syncFromMotion,
            sandField: { land: impact, stampCrater: impact, sampleHeight: () => height },
            syncSand() {
                synced = stamps;
                height = -0.035 * stamps;
                normal.set(0.02 * stamps, 1, -0.01 * stamps).normalize();
                trace.push('sync');
            }
        });
        const motion = { ...locomotion.readBodyState(), signedWalkSpeed: 0, desiredYawRate: 0,
            desiredVelX: 0, desiredVelZ: 0, plantedCount: 6, tippingMargin: 1, airborne: false };
        if (event === 'landing') {
            gait.update(PHYSICS.fixedDt, { ...motion, airborne: true, bodyVel: new THREE.Vector3(0, -2, 0) });
            motion.bodyVel.set(0, -2, 0);
            trace.length = 0;
        }
        if (event === 'step') for (const leg of rig.legs) {
            leg.isStepping = true;
            leg.stepProgress = 1 - PHYSICS.fixedDt * GAIT.stepRateBase * 0.5;
        }
        if (event === 'stomp') motion.stompHeld = true;
        for (const leg of rig.legs) {
            const rb = leg.footRb;
            leg.footRb = { setNextKinematicTranslation(position) {
                trace.push('pose');
                near(leg.groundGap, leg.currentFootPos.y - height);
                nearVector(leg.groundNormal, normal);
                rb.setNextKinematicTranslation(position);
            } };
        }
        const result = gait.update(PHYSICS.fixedDt, motion);
        assert.equal(stamps, event === 'stomp' ? 7 : 6);
        assert.equal(result.finishedStep, event === 'step');
        assert.equal(result.stomped, event === 'stomp');
        assert.equal(result.landed, event === 'landing');
        const afterSync = trace.slice(trace.lastIndexOf('sync') + 1);
        assert.ok(afterSync.filter(item => item === 'sample').length >= rig.legs.length);
        assert.equal(afterSync.filter(item => item === 'pose').length, rig.legs.length);
        assert.ok(rig.legs[0].groundGap > 0, 'a crater must not retain a pre-impact zero gap');
        if (event === 'step') {
            near(rig.legs[0].currentFootPos.y, 0, 1e-8);
            near(rig.legs[0].contactBlend, GAIT.contactBlendStart);
        }
    });
}

// Real field + real deformer + real Rapier terrain, using production gait.
// No collider-version assertions: batching/version synchronization is block four.
async function surfaceRig(t, solid = false) {
    const world = await createPhysicsWorld();
    const scene = new THREE.Scene();
    const material = new THREE.MeshBasicMaterial();
    const frameGeometry = new THREE.BoxGeometry(1, 1, 1);
    const terrain = createChunkTerrain({ scene, world, cx: 0, cz: 0,
        sandMaterial: material, skirtMaterial: material, frameMaterial: material, frameGeometry });
    t.after(() => { terrain.dispose(); frameGeometry.dispose(); material.dispose(); world.free(); });
    const field = createSandField();
    const deformer = createSandDeformer({ field });
    deformer.attachChunk('0,0', terrain.sandGeometry, 0, 0, terrain);
    const rec = field.getRecord('0,0');
    const rig = createMechRig({ scene, world });
    const sampler = createGroundSampler({ world, sandField: field,
        mechBodies: [rig.body], ignoredBodyHandles: rig.footBodyHandles });
    const locomotion = createLocomotion({ body: rig.body, groundAt: (x, z) => sampler.sample(x, z).y });
    const dust = [];
    const gait = createGaitController({ legs: rig.legs, sampler, sandField: field,
        syncBody: rig.syncFromMotion, syncSand: deformer.syncPhysicsAt,
        dust: { spawnSplash(position) { dust.push(position.clone()); } } });
    const addStone = (mixed = false) => world.createCollider(RAPIER.ColliderDesc.cuboid(mixed ? 6 : 10, 0.2, 10)
        .setTranslation(mixed ? -6 : 0, getDuneHeight(0, 0) + 0.2, 0).setFriction(0.9));
    const stone = solid ? addStone() : null;
    world.step();
    rig.body.setTranslation({ x: 0, y: getDuneHeight(0, 0) + MECH.rideHeight + (solid ? 0.4 : 0), z: 0 }, true);
    rig.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    for (const leg of rig.legs) {
        const surface = sampler.sample(leg.currentFootPos.x, leg.currentFootPos.z);
        leg.currentFootPos.y = surface.y;
        leg.stepStartPos.copy(leg.currentFootPos);
        leg.stepTargetPos.copy(leg.currentFootPos);
        leg.isPlanted = true;
        leg.isStepping = false;
    }
    const motion = () => ({ ...locomotion.readBodyState(), signedWalkSpeed: 0, desiredYawRate: 0,
        desiredVelX: 0, desiredVelZ: 0, plantedCount: 0, tippingMargin: 1, airborne: false });
    return { world, rig, field, rec, sampler, gait, motion, stone, addStone, deformer, dust };
}

function finishSteps(rig) {
    for (const leg of rig.legs) {
        leg.isStepping = true;
        leg.stepProgress = 1;
    }
}

function queueAnchorShift(leg, displacement, dt = PHYSICS.fixedDt) {
    leg.normalLoad ||= 100;
    leg.pendingAnchorShift = { ...displacement, dt,
        origin: leg.currentFootPos.clone(), surface: copyGroundSample(leg.groundContact) };
}

// Observe the real field boundary without substituting its deformation model.
function recordContactShifts(field) {
    const calls = [];
    const contact = field.contact;
    field.contact = (...args) => {
        calls.push({ x: args[0], z: args[1], reference: args[6],
            displacement: args[6] ? vector(args[6]) : null });
        return contact(...args);
    };
    return calls;
}

for (const solid of [false, true]) for (const event of ['pressure', 'scour', 'step', 'stomp', 'launch', 'landing', 'recovery']) {
    test(`real gait ${event} affects sand only (solid=${solid})`, async t => {
        const { rig, field, rec, gait, motion, dust } = await surfaceRig(t, solid);
        const dt = PHYSICS.fixedDt;
        const state = motion();
        gait.update(dt, state);
        const before = structuredClone(rec);
        const stats = field.getStats();
        const beforeVolume = rec.delta.reduce((sum, value) => sum + value * CELL * CELL, 0);
        if (event === 'pressure' || event === 'scour') {
            for (const leg of rig.legs) {
                leg.normalLoad = 6000;
                if (event === 'scour') queueAnchorShift(leg, { x: 0.018, y: 0, z: -0.009 });
            }
            if (event === 'scour') gait.update(dt, state);
            gait.applySand(dt, { ...state, bodyVel: new THREE.Vector3(4, 0, -2) });
        } else if (event === 'step') {
            finishSteps(rig);
            assert.equal(gait.update(dt, state).finishedStep, true);
        } else if (event === 'stomp') {
            assert.equal(gait.update(dt, { ...state, stompHeld: true }).stomped, true);
        } else if (event === 'launch') {
            gait.update(dt, { ...state, airborne: true, launched: true });
        } else if (event === 'landing') {
            gait.update(dt, { ...state, airborne: true, bodyVel: new THREE.Vector3(0, -2, 0) });
            assert.equal(gait.update(dt, { ...state, bodyVel: new THREE.Vector3(0, -2, 0) }).landed, true);
        } else {
            gait.update(dt, { ...state, recovery: true });
            finishSteps(rig);
            gait.update(dt, state);
        }
        if (solid) {
            assert.deepEqual(rec, before, 'hidden sand must retain height, packing, shear and cache state');
            assert.deepEqual(field.getStats(), stats);
            assert.equal(dust.length, 0, 'no sand splash from a solid upper support');
            assert.ok(rig.legs.every(leg => leg.sink === 0 && leg.sinkRate === 0));
        } else {
            assert.notDeepEqual(rec.delta, before.delta, 'real field must deform on exposed sand');
            assert.ok(rec.packing.some((value, i) => value > before.packing[i]));
            assert.ok(field.getStats().dirty > 0);
            const afterVolume = rec.delta.reduce((sum, value) => sum + value * CELL * CELL, 0);
            near(afterVolume, beforeVolume, 2e-6);
            if (event === 'scour') assert.ok(rec.slipX.some(value => value !== 0));
            if (event === 'pressure') assert.ok(rec.slipX.every(value => value === 0));
        }
    });
}

for (const startSolid of [false, true]) {
    test(`touchdown reselects upper material after a mid-swing transition (startSolid=${startSolid})`, async t => {
        const { world, rig, field, rec, sampler, gait, motion, stone, addStone } = await surfaceRig(t, startSolid);
        const dt = PHYSICS.fixedDt;
        gait.update(dt, motion());
        const old = rig.legs.map(leg => copyGroundSample(leg.groundContact));
        for (const leg of rig.legs) { leg.isStepping = true; leg.stepProgress = 0.4; }
        gait.update(dt, motion());
        const nextStone = startSolid ? null : addStone();
        if (stone) world.removeCollider(stone, true);
        world.step();
        gait.update(dt, motion());
        for (const leg of rig.legs) {
            const upper = sampler.sample(leg.currentFootPos.x, leg.currentFootPos.z).y;
            near(leg.currentFootPos.y, Math.max(leg.stepStartPos.y, upper)
                + Math.sin(leg.stepProgress * Math.PI) * GAIT.stepArcHeight);
        }
        const before = new Float32Array(rec.delta);
        finishSteps(rig);
        gait.update(dt, motion());
        for (let i = 0; i < rig.legs.length; i++) {
            const leg = rig.legs[i];
            const selected = sampler.sample(leg.currentFootPos.x, leg.currentFootPos.z);
            assert.deepEqual(leg.groundContact, selected);
            assert.notEqual(leg.groundContact, selected);
            assert.notEqual(leg.groundContact.normal, selected.normal);
            assert.equal(old[i].surfaceType, startSolid ? 'solid' : 'sand');
            assert.equal(leg.groundContact.surfaceType, startSolid ? 'sand' : 'solid');
            if (nextStone) {
                assert.equal(leg.groundContact.colliderHandle, nextStone.handle);
                near(leg.currentFootPos.y, selected.y);
                assert.equal(leg.packing, 0);
                assert.equal(leg.sink, 0);
                assert.equal(leg.sinkRate, 0);
            } else {
                assert.notEqual(leg.groundContact.colliderHandle, null);
                assert.equal(leg.packing, field.samplePacking(leg.currentFootPos.x, leg.currentFootPos.z));
                assert.ok(leg.groundGap > 0, 'impact resampling sees the new sand crater');
            }
        }
        if (startSolid) assert.notDeepEqual(rec.delta, before);
        else assert.deepEqual(rec.delta, before);
    });
}

test('mixed real contacts retain independent complete sampler snapshots', async t => {
    const { world, rig, rec, sampler, gait, motion, addStone, deformer, field } = await surfaceRig(t);
    for (let row = 0; row <= SEG; row++) for (let col = 0; col <= SEG; col++) {
        rec.packing[row * (SEG + 1) + col] = col / SEG;
        rec.delta[row * (SEG + 1) + col] = (col - SEG / 2) * 0.002 + (row - SEG / 2) * 0.001;
    }
    deformer.syncPhysicsAt(0, 0);
    const stone = addStone(true);
    world.step();
    gait.update(PHYSICS.fixedDt, motion());
    const contacts = rig.legs.map(leg => leg.groundContact);
    assert.ok(contacts.some(contact => contact.surfaceType === 'sand'));
    assert.ok(contacts.some(contact => contact.surfaceType === 'solid'));
    assert.equal(new Set(contacts).size, rig.legs.length);
    assert.equal(new Set(contacts.map(contact => contact.normal)).size, rig.legs.length);
    const saved = contacts.map(contact => copyGroundSample(contact));
    rig.legs.forEach((leg, i) => {
        const sample = sampler.sample(leg.currentFootPos.x, leg.currentFootPos.z);
        assert.deepEqual(contacts[i], sample);
        assert.notEqual(contacts[i].normal, sample.normal);
        assert.notEqual(contacts[i].normal, leg.groundNormal);
        if (leg.currentFootPos.x < 0) {
            assert.equal(contacts[i].colliderHandle, stone.handle);
            assert.equal(contacts[i].packing, 0);
            assert.equal(contacts[i].friction, stone.friction());
        } else assert.equal(contacts[i].packing, field.samplePacking(leg.currentFootPos.x, leg.currentFootPos.z));
    });
    sampler.sample(300, -300);
    assert.deepEqual(contacts, saved, 'later samples must not overwrite retained scalar or normal values');
});

test('planted contacts clear sand state on stone and resume pressure on exposed sand', async t => {
    const { world, rig, rec, field, gait, motion, addStone } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    gait.update(dt, motion());
    for (const leg of rig.legs) leg.normalLoad = 6000;
    gait.applySand(dt, motion());
    assert.ok(rig.legs.some(leg => leg.packing > 0 && leg.sink > 0 && leg.sinkRate > 0));
    const stone = addStone();
    world.step();
    gait.update(dt, motion());
    const before = structuredClone(rec);
    gait.applySand(dt, motion());
    assert.deepEqual(rec, before);
    for (const leg of rig.legs) {
        assert.equal(leg.groundContact.surfaceType, 'solid');
        assert.equal(leg.groundContact.colliderHandle, stone.handle);
        assert.equal(leg.sink, 0);
        assert.equal(leg.sinkRate, 0);
        assert.equal(leg.packing, 0);
        near(leg.traction, stone.friction() * leg.normalLoad);
    }
    world.removeCollider(stone, true);
    world.step();
    gait.update(dt, motion());
    for (const leg of rig.legs) {
        assert.equal(leg.groundContact.surfaceType, 'sand');
        assert.equal(leg.packing, field.samplePacking(leg.currentFootPos.x, leg.currentFootPos.z));
        assert.ok(leg.packing > 0);
    }
    gait.applySand(dt, motion());
    assert.notDeepEqual(rec.delta, before.delta);
});

test('a solid appearing after accepted movement vetoes the groove and cannot replay it later', async t => {
    const { world, rig, rec, field, sampler, gait, motion, addStone } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    gait.update(dt, motion());
    const leg = rig.legs[0];
    queueAnchorShift(leg, { x: 0.02, y: 0, z: 0 });
    gait.update(dt, motion());
    assert.ok(leg.groovePending && leg.slip > 0);
    const stone = addStone();
    world.step();
    assert.equal(sampler.sample(leg.currentFootPos.x, leg.currentFootPos.z).colliderHandle, stone.handle);
    const before = structuredClone(rec);
    gait.applySand(dt, motion());
    assert.deepEqual(rec, before, 'solid support must not excavate hidden sand');
    assert.equal(leg.groovePending, false);
    assert.equal(leg.slip, 0);
    world.removeCollider(stone, true);
    world.step();
    gait.applySand(dt, { ...motion(), bodyVel: new THREE.Vector3(40, 0, 0) });
    assert.deepEqual(rec.delta, before.delta, 'exposing sand cannot replay the old displacement');
    assert.ok(rec.packing.some(value => value > 0), 'current exposed pressure still compacts');
    // Only a fresh, accepted stance displacement can produce another groove.
    gait.update(dt, motion());
    queueAnchorShift(leg, { x: 0.02, y: 0, z: 0 });
    gait.update(dt, motion());
    gait.applySand(dt, motion());
    assert.notDeepEqual(rec.delta, before.delta);
    assert.ok(field.getStats().dirty > 0);
});

test('solid contact friction budget is independent of stale sand packing and sink', async t => {
    const { rig, gait, motion, stone } = await surfaceRig(t, true);
    gait.update(PHYSICS.fixedDt, motion());
    const contacts = createLegContacts({ body: rig.body, legs: rig.legs });
    const state = motion();
    const drive = { ...state, driveForceX: state.flatFwd.x * 100000, driveForceZ: state.flatFwd.z * 100000,
        attitudeTorqueX: 0, attitudeTorqueZ: 0, yawTorque: 0 };
    for (const packing of [0, 1]) {
        for (const leg of rig.legs) {
            leg.supportForce = 1000;
            leg.packing = packing;
            leg.sink = packing * SANDFIELD.maxSinkDepth;
        }
        const debug = contacts.solve(drive, { loadsSolved: true });
        near(debug.capacity, stone.friction() * 1000 * rig.legs.length);
        for (const leg of rig.legs) {
            near(leg.normalLoad, 1000);
            near(leg.tangentForce, stone.friction() * 1000);
        }
    }
});

test('force yielding moves the anchor next pass exactly once and sends the same actual vector to sand', async t => {
    const { rig, rec, field, gait, motion, sampler, dust } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    const state = motion();
    gait.update(dt, state);
    const leg = rig.legs[0];
    for (const other of rig.legs) other.supportForce = other === leg ? 100 : 0;
    const contacts = createLegContacts({ body: rig.body, legs: rig.legs });
    const drive = { ...state, driveForceX: 1200, driveForceZ: -600, velocityGain: MECH.velGainGround,
        attitudeTorqueX: 0, attitudeTorqueZ: 0, yawTorque: 0 };
    const start = leg.currentFootPos.clone();
    contacts.solve(drive, { loadsSolved: true }, dt);
    const requested = vector(leg.pendingAnchorShift);
    const saved = copyGroundSample(leg.pendingAnchorShift.surface);
    sampler.sample(100, -100);
    assert.deepEqual(leg.pendingAnchorShift.surface, saved);
    nearVector(leg.currentFootPos, start, 1e-10);
    assert.equal(contacts.getDebug().slip, 0);
    gait.update(dt, state);
    const achieved = leg.currentFootPos.clone().sub(start);
    nearVector(achieved, requested, 1e-8);
    nearVector(leg.anchorDisplacement, achieved, 1e-10);
    nearVector(leg.slipVelocity, achieved.clone().divideScalar(dt), 1e-8);
    assert.equal(leg.pendingAnchorShift, null);
    assert.ok(leg.slip > SANDFIELD.slipScourThreshold);
    // New demand is now satisfied, but movement already accepted still scours.
    contacts.solve({ ...drive, driveForceX: 0, driveForceZ: 0 }, { loadsSolved: true }, dt);
    assert.equal(contacts.getDebug().saturation, 0);
    assert.ok(contacts.getDebug().slip > 0);
    const calls = recordContactShifts(field);
    gait.applySand(dt, { ...state, bodyVel: new THREE.Vector3(-99, 0, 77) });
    const groove = calls.find(call => call.displacement);
    assert.equal(groove.reference, leg.anchorDisplacement);
    nearVector(groove.displacement, achieved, 1e-10);
    near(groove.x, leg.currentFootPos.x);
    near(groove.z, leg.currentFootPos.z);
    assert.equal(leg.groovePending, false);
    assert.ok(rec.delta.some(value => value !== 0));
    const after = new Float32Array(rec.delta);
    const end = leg.currentFootPos.clone();
    calls.length = 0;
    gait.applySand(dt, state);
    assert.ok(calls.every(call => call.displacement === null));
    assert.deepEqual(rec.delta, after, 'second sand pass cannot replay accepted movement');
    gait.update(dt, state);
    near(leg.currentFootPos.x, end.x, 1e-10);
    near(leg.currentFootPos.z, end.z, 1e-10);
    nearVector(leg.anchorDisplacement, new THREE.Vector3(), 1e-10);
    assert.equal(leg.slip, 0);
    assert.equal(dust.length, 0, 'force saturation does not emit impact dust');
});

test('available static friction holds anchors without shear despite a demand above the old reserve', async t => {
    const { rig, rec, field, gait, motion } = await surfaceRig(t);
    rec.packing.fill(1);
    const dt = PHYSICS.fixedDt;
    const state = motion();
    gait.update(dt, state);
    const slope = 0.6;
    const normal = new THREE.Vector3(0, 1, -slope).normalize();
    const locomotion = createLocomotion({ body: rig.body });
    const support = { supportY: getDuneHeight(0, 0), normal, slope, plantedCount: 6,
        sink: 0, stability: 1, tippingMargin: 1 };
    const demand = locomotion.plan(dt, support, command(), state);
    assert.ok(demand.driveForceZ > MECH.mass * MECH.driveAccelLimit * 0.75);
    for (const leg of rig.legs) {
        leg.groundNormal.copy(normal);
        leg.supportForce = BODY_WEIGHT * normal.y / rig.legs.length;
    }
    const starts = rig.legs.map(leg => leg.currentFootPos.clone());
    const contacts = createLegContacts({ body: rig.body, legs: rig.legs });
    contacts.solve(demand, { loadsSolved: true }, dt);
    assert.equal(contacts.getDebug().saturation, 0);
    assert.ok(rig.legs.every(leg => leg.pendingAnchorShift === null));
    gait.update(dt, state);
    gait.applySand(dt, { ...state, bodyVel: new THREE.Vector3(30, 0, -20) });
    rig.legs.forEach((leg, i) => {
        nearVector(leg.currentFootPos, starts[i]);
        assert.equal(leg.slip, 0);
    });
    assert.ok(rec.slipX.every(value => value === 0));
    assert.ok(rec.slipZ.every(value => value === 0));
    assert.ok(rec.delta.every(value => value === 0));
    assert.equal(field.getStats().dirty, 0);
});

for (const transition of ['swing', 'touchdown', 'airborne', 'landing', 'recovery', 'unplanted', 'teleport', 'unloaded']) {
    test(`pending anchor displacement is discarded through ${transition}`, async t => {
        const { rig, field, gait, motion } = await surfaceRig(t);
        const dt = PHYSICS.fixedDt;
        let state = motion();
        gait.update(dt, state);
        const leg = rig.legs[0];
        if (transition === 'landing') {
            gait.update(dt, { ...state, airborne: true, bodyVel: new THREE.Vector3(0, -2, 0) });
            state = { ...state, landed: true, bodyVel: new THREE.Vector3(0, -2, 0) };
        }
        queueAnchorShift(leg, { x: 0.02, y: 0, z: -0.01 });
        if (transition === 'swing' || transition === 'touchdown') {
            leg.isStepping = true;
            leg.stepProgress = transition === 'touchdown' ? 1 : 0.2;
        }
        if (transition === 'airborne') state = { ...state, airborne: true };
        if (transition === 'recovery') state = { ...state, recovery: true };
        if (transition === 'unplanted') leg.isPlanted = false;
        if (transition === 'teleport') leg.currentFootPos.x += 0.2;
        if (transition === 'unloaded') leg.normalLoad = 0;
        const calls = recordContactShifts(field);
        gait.update(dt, state);
        assert.equal(leg.pendingAnchorShift, null);
        assert.equal(leg.groovePending, false);
        assert.equal(leg.slip, 0);
        nearVector(leg.anchorDisplacement, new THREE.Vector3());
        gait.applySand(dt, state);
        assert.ok(calls.every(call => call.displacement === null));
        // Returning to stance cannot resurrect the old request.
        state = motion();
        gait.update(dt, state);
        finishSteps(rig);
        gait.update(dt, state);
        assert.equal(leg.pendingAnchorShift, null);
        assert.equal(leg.groovePending, false);
        assert.equal(leg.slip, 0);
    });
}

test('a tripod swing triggered in the consuming pass wins over pending yielding', async t => {
    const { rig, gait, motion } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    gait.update(dt, motion());
    const group = rig.legs.filter(leg => leg.gaitGroup === 0);
    for (const leg of group) {
        leg.currentFootPos.x += 0.7;
        queueAnchorShift(leg, { x: 0.02, y: 0, z: 0 });
    }
    gait.update(dt, { ...motion(), plantedCount: 6 });
    for (const leg of group) {
        assert.equal(leg.isStepping, true);
        assert.equal(leg.pendingAnchorShift, null);
        assert.equal(leg.groovePending, false);
        assert.equal(leg.slip, 0);
    }
});

test('pending sand yielding is invalidated by a solid replacement with live friction', async t => {
    const { world, rig, rec, gait, motion, addStone } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    gait.update(dt, motion());
    const starts = rig.legs.map(leg => leg.currentFootPos.clone());
    for (const leg of rig.legs) queueAnchorShift(leg, { x: 0.02, y: 0, z: 0 });
    const stone = addStone();
    stone.setFriction(0.23);
    world.step();
    gait.update(dt, motion());
    const contacts = createLegContacts({ body: rig.body, legs: rig.legs });
    for (const leg of rig.legs) leg.supportForce = 1000;
    const drive = { ...motion(), driveForceX: 0, driveForceZ: 100000,
        attitudeTorqueX: 0, attitudeTorqueZ: 0, yawTorque: 0 };
    contacts.solve(drive, { loadsSolved: true }, dt);
    rig.legs.forEach((leg, i) => {
        near(leg.currentFootPos.x, starts[i].x);
        near(leg.currentFootPos.z, starts[i].z);
        assert.equal(leg.pendingAnchorShift, null);
        assert.equal(leg.groundContact.surfaceType, 'solid');
        near(leg.groundContact.friction, stone.friction());
        near(leg.tangentForce, stone.friction() * 1000);
        near(leg.slip, 0);
    });
    const before = structuredClone(rec);
    gait.applySand(dt, drive);
    assert.deepEqual(rec, before);
    stone.setFriction(0.61);
    gait.update(dt, motion());
    contacts.solve(drive, { loadsSolved: true }, dt);
    near(contacts.getDebug().capacity, stone.friction() * 6000);
});

test('yielding traces and clips at a solid boundary; grooves receive only the reached sand segment', async t => {
    const { world, rig, field, sampler, gait, motion } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    gait.update(dt, motion());
    const leg = rig.legs[0];
    const start = leg.currentFootPos.clone();
    const boundary = start.x + 0.012;
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 0.2, 0.1)
        .setTranslation(boundary + 0.1, start.y + 0.2, start.z).setFriction(0.7));
    world.step();
    queueAnchorShift(leg, { x: 0.025, y: 0, z: 0 });
    gait.update(dt, motion());
    const achieved = leg.currentFootPos.clone().sub(start);
    assert.ok(achieved.x > 0.01 && achieved.x < 0.0121);
    assert.ok(leg.currentFootPos.x < boundary + 1e-6);
    assert.equal(sampler.sample(leg.currentFootPos.x, leg.currentFootPos.z).surfaceType, 'sand');
    assert.equal(leg.pendingAnchorShift, null);
    const calls = recordContactShifts(field);
    gait.applySand(dt, motion());
    const groove = calls.find(call => call.displacement);
    nearVector(groove.displacement, achieved, 1e-8);
    assert.ok(groove.x - groove.displacement.x / 2 < boundary);
});

test('reach clips anchor travel using the real rig geometry and preserves the actual groove vector', async t => {
    const { rig, field, gait, motion } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    const state = motion();
    const leg = rig.legs[0];
    const hip = vector(hipOffset(state.bodyQuat, leg.hipLocal, {})).add(state.bodyPos);
    const ground = getDuneHeight(0, 0);
    const vertical = ground + HEXAPOD.ankleHeight * HEXAPOD.scale - hip.y;
    const reach = (HEXAPOD.femurLength + HEXAPOD.tibiaLength) * 0.992 * HEXAPOD.scale;
    const maxRadius = Math.sqrt(reach * reach - vertical * vertical) + HEXAPOD.coxaOffset * HEXAPOD.scale;
    leg.currentFootPos.set(hip.x - maxRadius + 0.008, ground, hip.z);
    gait.update(dt, state);
    const start = leg.currentFootPos.clone();
    queueAnchorShift(leg, { x: -0.024, y: 0, z: 0 });
    gait.update(dt, state);
    const achieved = leg.currentFootPos.clone().sub(start);
    assert.ok(achieved.x < -0.0079 && achieved.x > -0.0081);
    assert.ok(evaluateContact(leg, state.bodyPos, state.bodyQuat).reachFactor >= 1 - 1e-10);
    const calls = recordContactShifts(field);
    gait.applySand(dt, state);
    nearVector(calls.find(call => call.displacement).displacement, achieved, 1e-8);
    assert.equal(leg.pendingAnchorShift, null);
});

test('fully reach-blocked yielding reports saturation but no actual slip, groove or dust', async t => {
    const { rig, rec, field, gait, motion, dust } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    const state = motion();
    const leg = rig.legs[0];
    const hip = vector(hipOffset(state.bodyQuat, leg.hipLocal, {})).add(state.bodyPos);
    const ground = getDuneHeight(0, 0);
    const vertical = ground + HEXAPOD.ankleHeight * HEXAPOD.scale - hip.y;
    const reach = (HEXAPOD.femurLength + HEXAPOD.tibiaLength) * 0.992 * HEXAPOD.scale;
    const radius = Math.sqrt((reach * 1.01) ** 2 - vertical * vertical) + HEXAPOD.coxaOffset * HEXAPOD.scale;
    leg.currentFootPos.set(hip.x - radius, ground, hip.z);
    gait.update(dt, state);
    const start = leg.currentFootPos.clone();
    const weight = evaluateContact(leg, state.bodyPos, state.bodyQuat).weight;
    assert.ok(weight > 0 && weight < 1, 'fixture remains partially load-bearing');
    for (const other of rig.legs) other.supportForce = other === leg ? 100 : 0;
    const contacts = createLegContacts({ body: rig.body, legs: rig.legs });
    const drive = { ...state, driveForceX: 10000, driveForceZ: 0,
        attitudeTorqueX: 0, attitudeTorqueZ: 0, yawTorque: 0 };
    contacts.solve(drive, { loadsSolved: true }, dt);
    assert.ok(leg.pendingAnchorShift.x < 0, 'yield is outward and cannot be reached');
    gait.update(dt, state);
    nearVector(leg.currentFootPos, start);
    contacts.solve(drive, { loadsSolved: true }, dt);
    assert.ok(contacts.getDebug().saturation > 0.9);
    assert.equal(contacts.getDebug().slip, 0);
    const calls = recordContactShifts(field);
    gait.applySand(dt, { ...state, bodyVel: new THREE.Vector3(50, 0, 50) });
    assert.ok(calls.every(call => call.displacement === null));
    assert.ok(rec.delta.every(value => value === 0));
    assert.ok(rec.slipX.every(value => value === 0));
    assert.equal(dust.length, 0);
});

test('changed sand height limits yielding and reprojects the accepted anchor before its groove', async t => {
    const { rig, rec, field, gait, motion } = await surfaceRig(t);
    const dt = PHYSICS.fixedDt;
    gait.update(dt, motion());
    const leg = rig.legs[0];
    const start = leg.currentFootPos.clone();
    queueAnchorShift(leg, { x: 0.025, y: 0, z: 0 });
    // Change the real local surface after force prediction, without collider
    // version/flush infrastructure. Sampling uses analytical height + delta.
    for (let row = 0; row <= SEG; row++) for (let col = 0; col <= SEG; col++) {
        const x = col * CELL - HALF;
        rec.delta[row * (SEG + 1) + col] = Math.max(-0.8, Math.min(0.8, x - start.x));
    }
    gait.update(dt, motion());
    assert.ok(leg.anchorDisplacement.x > 0 && leg.anchorDisplacement.x < 0.025);
    assert.ok(leg.anchorDisplacement.y > 0);
    assert.ok(leg.anchorDisplacement.length() <= 0.025 + GAIT.anchorPositionEpsilon + 1e-10);
    near(leg.currentFootPos.y, field.sampleHeight(leg.currentFootPos.x, leg.currentFootPos.z));
    near(leg.groundGap, 0);
    const achieved = leg.anchorDisplacement.clone();
    const calls = recordContactShifts(field);
    gait.applySand(dt, motion());
    nearVector(calls.find(call => call.displacement).displacement, achieved, 1e-8);
});

test('all contacts expose final packing after overlapping pressure and use it for the next ellipse', async t => {
    const { rig, field, gait, motion } = await surfaceRig(t);
    rig.legs[1].currentFootPos.copy(rig.legs[0].currentFootPos);
    gait.update(PHYSICS.fixedDt, motion());
    for (const leg of rig.legs) leg.normalLoad = 6000;
    gait.applySand(PHYSICS.fixedDt, motion());
    for (const leg of rig.legs) {
        near(leg.packing, field.samplePacking(leg.currentFootPos.x, leg.currentFootPos.z), 1e-12);
        near(leg.groundContact.packing, leg.packing, 1e-12);
        leg.supportForce = 1000;
    }
    const expected = rig.legs.reduce((sum, leg) => sum + (0.5 + 0.45 * leg.packing) * 1000, 0);
    const contacts = createLegContacts({ body: rig.body, legs: rig.legs });
    contacts.solve({ ...motion(), driveForceX: 0, driveForceZ: 100000,
        attitudeTorqueX: 0, attitudeTorqueZ: 0, yawTorque: 0 }, { loadsSolved: true });
    near(contacts.getDebug().capacity, expected, 1e-8);
});

function timingState() {
    return { accumulator: 0, substeps: 0, droppedSteps: 0, droppedTime: 0 };
}

test('accumulator preserves fractions at the three-step cap and through overloads', () => {
    assert.equal(PHYSICS.fixedDt, 1 / 60);
    assert.equal(PHYSICS.maxSubsteps, 3);
    const h = PHYSICS.fixedDt;
    const timing = timingState();
    assert.equal(advancePhysicsAccumulator(timing, h * 3.5), 3);
    near(timing.accumulator, h * 0.5, 1e-12);
    assert.equal(timing.droppedSteps, 0);
    assert.equal(advancePhysicsAccumulator(timing, h * 0.5), 1);
    near(timing.accumulator, 0, 1e-12);
    assert.equal(advancePhysicsAccumulator(timing, h * 12.75), 3);
    assert.equal(timing.droppedSteps, 9);
    near(timing.droppedTime, 9 * h, 1e-12);
    near(timing.accumulator, h * 0.75, 1e-12);
    assert.equal(advancePhysicsAccumulator(timing, h * 0.25), 1);
    near(timing.accumulator, 0, 1e-12);
    assert.equal(timing.droppedSteps, 9);
});

test('accumulator conserves elapsed time including stalls and never exceeds three steps', () => {
    const timing = timingState();
    let elapsed = 0;
    let simulated = 0;
    for (const dt of [0, 1 / 144, 1 / 90, 1 / 30, 2.007, 0.0001, 1 / 60, 0.057, 1 / 120]) {
        elapsed += dt;
        const steps = advancePhysicsAccumulator(timing, dt);
        assert.ok(steps >= 0 && steps <= 3 && Number.isInteger(steps));
        simulated += steps * PHYSICS.fixedDt;
        assert.ok(timing.accumulator >= 0 && timing.accumulator < PHYSICS.fixedDt);
        near(elapsed, simulated + timing.droppedTime + timing.accumulator, 1e-10);
        near(timing.droppedTime, timing.droppedSteps * PHYSICS.fixedDt, 1e-10);
    }
    const split = timingState();
    let splitSteps = 0;
    for (let i = 0; i < 120; i++) splitSteps += advancePhysicsAccumulator(split, 1 / 120);
    assert.equal(splitSteps, 60);
    assert.equal(split.droppedSteps, 0);
    near(split.accumulator, 0, 1e-12);
});
