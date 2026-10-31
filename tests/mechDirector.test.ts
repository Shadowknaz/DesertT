import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createMechDirector } from '../src/control/mechDirector.ts';
import { INPUT, AUTOPILOT } from '../src/config.ts';

function createDummyContext(overrides = {}) {
    return {
        bodyPos: new THREE.Vector3(0, 0, 0),
        currentYaw: 0,
        flatFwd: new THREE.Vector3(0, 0, 1),
        actions: {
            forward: false,
            backward: false,
            left: false,
            right: false,
            stomp: false,
            jump: false
        },
        ...overrides
    };
}

test('mechDirector returns stationary command when idle', () => {
    const director = createMechDirector();
    const ctx = createDummyContext();
    const cmd = director.update(1 / 60, ctx);

    assert.equal(cmd.throttle, 0);
    assert.equal(cmd.turnInput, 0);
    assert.equal(cmd.desiredYawRate, 0);
    assert.equal(cmd.isManual, false);
    assert.equal(cmd.stompHeld, false);
    assert.equal(cmd.jumpHeld, false);
});

test('mechDirector handles manual movement actions and populates 7 fields', () => {
    const director = createMechDirector();
    const ctx = createDummyContext({
        actions: {
            forward: true,
            backward: false,
            left: true,
            right: false,
            stomp: true,
            jump: false
        }
    });

    const cmd = director.update(1 / 60, ctx);
    assert.equal(cmd.throttle, 1);
    assert.equal(cmd.turnInput, 1);
    assert.equal(cmd.desiredYawRate, AUTOPILOT.manualYawRate);
    assert.equal(cmd.isManual, true);
    assert.equal(cmd.stompHeld, true);
    assert.equal(cmd.jumpHeld, false);

    const debug = director.getDebug();
    assert.equal(debug.isManual, true);
    assert.equal(debug.manualControlTimer, INPUT.manualHoldDuration);
});

test('mechDirector navigates to waypoint and pauses upon arrival', () => {
    const director = createMechDirector();
    const targetPoint = new THREE.Vector3(0, 0, 10);
    director.setWaypoint(targetPoint);

    // Mid-path
    const ctx = createDummyContext({
        bodyPos: new THREE.Vector3(0, 0, 0)
    });
    const cmd = director.update(1 / 60, ctx);
    assert.equal(cmd.throttle, 1.0);
    assert.equal(cmd.isManual, false);

    // Arrived within arrivalRadius (2.2)
    const arrivalCtx = createDummyContext({
        bodyPos: new THREE.Vector3(0, 0, 9.0) // distance = 1.0 < 2.2
    });
    const arrivalCmd = director.update(1 / 60, arrivalCtx);
    assert.equal(arrivalCmd.throttle, 0.0);
    assert.equal(arrivalCmd.isManual, true); // arrival pause holds position
    assert.equal(director.getDebug().customWaypoint, null);
});

test('mechDirector onAction triggers manual override', () => {
    const director = createMechDirector();
    director.setWaypoint(new THREE.Vector3(5, 0, 5));
    assert.notEqual(director.getDebug().customWaypoint, null);

    director.onAction('forward', 'down');
    assert.equal(director.getDebug().customWaypoint, null);
    assert.equal(director.getDebug().isManual, true);
});

test('mechDirector reset clears all state', () => {
    const director = createMechDirector();
    director.setWaypoint(new THREE.Vector3(5, 0, 5));
    director.notifyManualInput();

    director.reset();
    const debug = director.getDebug();
    assert.equal(debug.isManual, false);
    assert.equal(debug.customWaypoint, null);
    assert.equal(debug.manualControlTimer, 0);
});

