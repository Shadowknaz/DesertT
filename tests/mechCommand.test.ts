import test from 'node:test';
import assert from 'node:assert/strict';
import { createMechCommand } from '../src/mech/mechCommand.ts';

test('createMechCommand returns default seven fields', () => {
    const cmd = createMechCommand();
    assert.deepEqual(cmd, {
        throttle: 0.0,
        turnInput: 0.0,
        desiredYawRate: 0.0,
        yawError: 0.0,
        isManual: false,
        stompHeld: false,
        jumpHeld: false
    });
});

test('createMechCommand accepts overrides', () => {
    const cmd = createMechCommand({
        throttle: 1.0,
        turnInput: -0.5,
        desiredYawRate: 1.2,
        yawError: 0.3,
        isManual: true,
        stompHeld: true,
        jumpHeld: false
    });
    assert.deepEqual(cmd, {
        throttle: 1.0,
        turnInput: -0.5,
        desiredYawRate: 1.2,
        yawError: 0.3,
        isManual: true,
        stompHeld: true,
        jumpHeld: false
    });
});

