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
