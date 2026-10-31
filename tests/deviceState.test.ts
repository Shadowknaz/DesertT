import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceState } from '../src/input/deviceState.ts';
import { INPUT } from '../src/config.ts';

function createHarness(overrides = {}) {
    const target = new EventTarget();
    const keyCalls = [];
    const clickCalls = [];

    const deviceState = createDeviceState({
        target,
        onKey: (code, isDown, event) => keyCalls.push({ code, isDown, event }),
        onPointerClick: (info) => clickCalls.push(info),
        ...overrides
    });

    function send(type, props = {}) {
        const event = new Event(type, { cancelable: true });
        Object.assign(event, props);
        target.dispatchEvent(event);
        return event;
    }

    return { target, deviceState, keyCalls, clickCalls, send };
}

test('deviceState tracks key presses and releases', () => {
    const { deviceState, keyCalls, send } = createHarness();

    send('keydown', { code: 'KeyW' });
    assert.equal(deviceState.isKeyDown('KeyW'), true);
    assert.deepEqual(Array.from(deviceState.getPressedCodes()), ['KeyW']);
    assert.equal(keyCalls.length, 1);
    assert.equal(keyCalls[0].code, 'KeyW');
    assert.equal(keyCalls[0].isDown, true);

    send('keyup', { code: 'KeyW' });
    assert.equal(deviceState.isKeyDown('KeyW'), false);
    assert.deepEqual(Array.from(deviceState.getPressedCodes()), []);
    assert.equal(keyCalls.length, 2);
    assert.equal(keyCalls[1].isDown, false);
});

test('deviceState prevents default only on configured keys', () => {
    const { send } = createHarness();

    const evW = send('keydown', { code: 'KeyW' });
    assert.equal(evW.defaultPrevented, false);

    const evSpace = send('keydown', { code: 'Space' });
    assert.equal(evSpace.defaultPrevented, true);

    const evArrow = send('keydown', { code: 'ArrowUp' });
    assert.equal(evArrow.defaultPrevented, true);
});

test('deviceState detects click within tolerance for left and right buttons', () => {
    const { clickCalls, send } = createHarness();

    // Left click
    send('pointerdown', { button: 0, clientX: 100, clientY: 100 });
    send('pointerup', { button: 0, clientX: 100 + INPUT.clickTolerancePx, clientY: 100 });
    assert.equal(clickCalls.length, 1);
    assert.equal(clickCalls[0].button, 0);
    assert.equal(clickCalls[0].clientX, 106);

    // Right click
    send('pointerdown', { button: 2, clientX: 200, clientY: 200 });
    send('pointerup', { button: 2, clientX: 200, clientY: 200 });
    assert.equal(clickCalls.length, 2);
    assert.equal(clickCalls[1].button, 2);
});

test('deviceState ignores drag exceeding click tolerance', () => {
    const { clickCalls, send } = createHarness();

    send('pointerdown', { button: 0, clientX: 100, clientY: 100 });
    send('pointerup', { button: 0, clientX: 100 + INPUT.clickTolerancePx + 0.1, clientY: 100 });
    assert.equal(clickCalls.length, 0);
});

test('deviceState ignores middle click and unmatched releases', () => {
    const { clickCalls, send } = createHarness();

    send('pointerdown', { button: 1, clientX: 100, clientY: 100 });
    send('pointerup', { button: 1, clientX: 100, clientY: 100 });
    assert.equal(clickCalls.length, 0);

    // Release without down
    send('pointerup', { button: 0, clientX: 100, clientY: 100 });
    assert.equal(clickCalls.length, 0);

    // Mismatched release button
    send('pointerdown', { button: 0, clientX: 100, clientY: 100 });
    send('pointerup', { button: 2, clientX: 100, clientY: 100 });
    assert.equal(clickCalls.length, 0);
});

test('deviceState blur resets all pressed keys and cancels pending click', () => {
    const { deviceState, clickCalls, send } = createHarness();

    send('keydown', { code: 'KeyW' });
    send('keydown', { code: 'KeyD' });
    assert.equal(deviceState.isKeyDown('KeyW'), true);
    assert.equal(deviceState.isKeyDown('KeyD'), true);

    send('pointerdown', { button: 0, clientX: 100, clientY: 100 });
    send('blur');

    assert.equal(deviceState.isKeyDown('KeyW'), false);
    assert.equal(deviceState.isKeyDown('KeyD'), false);
    assert.equal(deviceState.getPressedCodes().size, 0);

    send('pointerup', { button: 0, clientX: 100, clientY: 100 });
    assert.equal(clickCalls.length, 0);
});

test('deviceState prevents contextmenu default', () => {
    const { send } = createHarness();
    const ev = send('contextmenu');
    assert.equal(ev.defaultPrevented, true);
});

test('deviceState dispose detaches listeners and clears state', () => {
    const { deviceState, keyCalls, send } = createHarness();

    send('keydown', { code: 'KeyW' });
    assert.equal(deviceState.isKeyDown('KeyW'), true);

    deviceState.dispose();
    assert.equal(deviceState.isKeyDown('KeyW'), false);

    send('keydown', { code: 'KeyW' });
    assert.equal(keyCalls.length, 1); // No new events after dispose
    assert.equal(deviceState.isKeyDown('KeyW'), false);
});

