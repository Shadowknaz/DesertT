import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createMechActor } from '../src/actor/mechActor.ts';

test('mechActor exposes generic pose and simulation hooks', () => {
    const bodyPos = new THREE.Vector3(1, 2, 3);
    let synced = 0;
    const locomotion = {
        readBodyState: () => ({
            bodyPos,
            currentYaw: 0.4,
            flatFwd: new THREE.Vector3(0, 0, 1)
        }),
        getDebug: () => ({ slope: 0 })
    };
    const rig = { legs: [], syncVisuals: () => { synced += 1; } };
    const controller = { update: () => ({}) };
    const simulationResult = { motion: { bodyPos }, support: { plantedCount: 6 } };
    const actor = createMechActor({
        controller,
        rig,
        locomotion,
        simulateStep: () => simulationResult,
        cameraConfig: { focusHeight: 2 }
    });

    assert.equal(actor.id, 'mech');
    assert.equal(actor.contextId, 'mech');
    assert.equal(actor.controller, controller);
    assert.equal(actor.getPose().position, bodyPos);
    assert.equal(actor.simulateStep(), simulationResult);
    actor.syncVisuals();
    assert.equal(synced, 1);
    assert.equal(actor.getDebug().loop.slope, 0);
});

test('mechActor keeps actor-specific world effects behind an adapter hook', () => {
    const calls = [];
    const actor = createMechActor({
        controller: { update: () => ({}) },
        locomotion: {
            readBodyState: () => ({
                bodyPos: new THREE.Vector3(),
                currentYaw: 0,
                flatFwd: new THREE.Vector3(0, 0, 1)
            })
        },
        rig: { setDustCoat: value => calls.push(['coat', value]) },
        dust: { updateAmbient: (...args) => calls.push(['dust', ...args]) },
        granules: { update: (...args) => calls.push(['granules', ...args]) },
        simulateStep: () => ({ motion: { bodyPos: new THREE.Vector3() } })
    });

    const chunks = {
        sandField: {
            sampleHeight: () => 0,
            depositMass: () => {},
            addReserve: () => {}
        }
    };
    const weatherState = { windX: 1, windZ: -1, coat: 0.4 };
    actor.updateWorld({
        motion: { bodyPos: new THREE.Vector3(1, 2, 3) },
        frameDt: 0.016,
        weatherState,
        chunks,
        sampler: null
    });

    assert.equal(calls[0][0], 'dust');
    assert.equal(calls[1][0], 'granules');
    assert.deepEqual(calls[1][2].windX, 1);
    assert.equal(calls[2][0], 'coat');
    assert.equal(calls[2][1], 0.4);
});

test('mechActor remains controllable in Rapier after switching to Cosmo and back to Mech', async () => {
    const { createPhysicsWorld, RAPIER } = await import('../src/world/physics.ts');
    const world = await createPhysicsWorld();

    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0), groundBody);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 2.0, 0)
        .setLinearDamping(1.35)
        .setAngularDamping(2.9)
        .setCanSleep(false);
    const body = world.createRigidBody(bodyDesc);
    world.createCollider(RAPIER.ColliderDesc.cuboid(1.0, 0.5, 1.5).setDensity(200), body);

    let resetCalls = 0;
    const controller = {
        update: () => ({}),
        reset: () => { resetCalls += 1; }
    };

    const actor = createMechActor({
        controller,
        rig: { body, legs: [] },
        locomotion: {
            readBodyState: () => ({
                bodyPos: new THREE.Vector3().copy(body.translation() as any),
                currentYaw: 0,
                flatFwd: new THREE.Vector3(0, 0, 1)
            })
        },
        simulateStep: () => ({ motion: { bodyPos: new THREE.Vector3() } })
    });

    // Step 1: Deactivate Mech (switch to Cosmo) and step physics world while Mech is parked
    actor.onDeactivate!();
    const parkedY = body.translation().y;
    for (let i = 0; i < 60; i++) {
        world.step();
    }
    assert.ok(Math.abs(body.translation().y - parkedY) < 1e-4, 'Parked mech must stay locked in place while Cosmo is active');

    // Step 2: Reactivate Mech (switch back from Cosmo) and apply drive force/impulse
    actor.onActivate!();
    assert.ok(resetCalls >= 2, 'Controller state must be reset on actor switch');

    body.applyImpulse({ x: 0, y: 0, z: 4500 }, true);
    for (let i = 0; i < 30; i++) {
        world.step();
    }

    assert.ok(
        body.translation().z > 0.15,
        `Reactivated mech body must respond to drive forces in Rapier (z=${body.translation().z})`
    );

    world.free();
});

