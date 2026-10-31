import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { INPUT } from '../src/config.ts';
import { createInputController } from '../src/input/inputController.ts';

function createInputHarness(t, overrides = {}) {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const window = new EventTarget();
    window.innerWidth = 800;
    window.innerHeight = 600;
    Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
    t.after(() => {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete globalThis.window;
    });

    const camera = new THREE.PerspectiveCamera(42, 4 / 3, 0.5, 200);
    camera.position.set(0, 5, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const callbacks = {
        getSandMeshes: t.mock.fn(() => []),
        onManualInput: t.mock.fn(),
        onSandClick: t.mock.fn(),
        onWeatherSelect: t.mock.fn(),
        onWeatherCycle: t.mock.fn(),
        onTimeToggle: t.mock.fn(),
        ...overrides
    };
    const { keyState } = createInputController({ camera, ...callbacks });

    function send(type, properties = {}) {
        const event = new Event(type, { cancelable: true });
        Object.assign(event, properties);
        window.dispatchEvent(event);
        return event;
    }
    return { keyState, callbacks, send };
}

test('all movement aliases update and release their existing actions', t => {
    const { keyState, callbacks, send } = createInputHarness(t);
    const bindings = [
        ['KeyW', 'forward'], ['ArrowUp', 'forward'],
        ['KeyS', 'backward'], ['ArrowDown', 'backward'],
        ['KeyA', 'left'], ['ArrowLeft', 'left'],
        ['KeyD', 'right'], ['ArrowRight', 'right'],
        ['Space', 'stomp'], ['ShiftLeft', 'jump'], ['ShiftRight', 'jump']
    ];
    for (const [code, action] of bindings) {
        const event = send('keydown', { code });
        assert.equal(keyState[action], true, code);
        assert.equal(Object.values(keyState).filter(Boolean).length, 1);
        assert.equal(event.defaultPrevented, code.startsWith('Arrow') || code === 'Space');
        send('keyup', { code });
        assert.ok(Object.values(keyState).every(value => value === false));
    }
    assert.equal(callbacks.onManualInput.mock.callCount(), bindings.length);
});

test('key repeats notify manual control and overlapping aliases maintain action until all released', t => {
    const { keyState, callbacks, send } = createInputHarness(t);
    send('keydown', { code: 'KeyW' });
    send('keydown', { code: 'KeyW', repeat: true });
    send('keydown', { code: 'ArrowUp' });
    assert.equal(callbacks.onManualInput.mock.callCount(), 3);
    send('keyup', { code: 'KeyW' });
    assert.equal(keyState.forward, true);
    send('keyup', { code: 'ArrowUp' });
    assert.equal(keyState.forward, false);
    assert.equal(callbacks.onManualInput.mock.callCount(), 3);
});

test('unmapped keys cannot change state or notify manual control', t => {
    const { keyState, callbacks, send } = createInputHarness(t);
    const initialState = { ...keyState };
    for (const code of ['KeyQ', 'Digit0', '__proto__', 'toString']) {
        send('keydown', { code });
        send('keyup', { code });
    }
    assert.deepEqual(keyState, initialState);
    assert.equal(callbacks.onManualInput.mock.callCount(), 0);
});

test('weather and time callbacks remain separate from movement and run on repeats', t => {
    const { keyState, callbacks, send } = createInputHarness(t);
    for (let i = 1; i <= 4; i++) {
        send('keydown', { code: `Digit${i}` });
        send('keyup', { code: `Digit${i}` });
    }
    assert.deepEqual(callbacks.onWeatherSelect.mock.calls.map(call => call.arguments), [[0], [1], [2], [3]]);
    for (const code of ['KeyR', 'KeyT']) {
        send('keydown', { code });
        send('keydown', { code, repeat: true });
        send('keyup', { code });
    }
    assert.equal(callbacks.onWeatherCycle.mock.callCount(), 2);
    assert.equal(callbacks.onTimeToggle.mock.callCount(), 2);
    assert.equal(callbacks.onManualInput.mock.callCount(), 0);
    assert.ok(Object.values(keyState).every(value => value === false));
});

test('optional weather and time callbacks may be omitted', t => {
    const { keyState, callbacks, send } = createInputHarness(t, {
        onWeatherSelect: null, onWeatherCycle: null, onTimeToggle: null
    });
    for (const code of ['Digit1', 'KeyR', 'KeyT']) send('keydown', { code });
    assert.equal(callbacks.onManualInput.mock.callCount(), 0);
    assert.ok(Object.values(keyState).every(value => value === false));
});

test('blur clears all actions and cancels a pending pointer press', t => {
    const { keyState, send } = createInputHarness(t);
    const intersect = t.mock.method(THREE.Raycaster.prototype, 'intersectObjects', () => []);
    for (const code of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'ShiftLeft']) {
        send('keydown', { code });
    }
    assert.ok(Object.values(keyState).every(Boolean));
    send('pointerdown', { button: 0, clientX: 100, clientY: 100 });
    send('blur');
    assert.ok(Object.values(keyState).every(value => value === false));
    send('pointerup', { button: 0, clientX: 100, clientY: 100 });
    assert.equal(intersect.mock.callCount(), 0);
});

test('left and right clicks raycast current meshes at the click tolerance', t => {
    const { callbacks, send } = createInputHarness(t);
    const point = new THREE.Vector3(1, 0, 2);
    const meshes = [new THREE.Object3D()];
    callbacks.getSandMeshes.mock.mockImplementation(() => meshes);
    const intersect = t.mock.method(THREE.Raycaster.prototype, 'intersectObjects', () => [{ point }]);
    for (const button of [0, 2]) {
        send('pointerdown', { button, clientX: 100, clientY: 100 });
        send('pointerup', { button, clientX: 100 + INPUT.clickTolerancePx, clientY: 100 });
    }
    assert.equal(callbacks.onSandClick.mock.callCount(), 2);
    assert.equal(callbacks.getSandMeshes.mock.callCount(), 2);
    for (const call of intersect.mock.calls) assert.deepEqual(call.arguments, [meshes, false]);
    for (const call of callbacks.onSandClick.mock.calls) assert.equal(call.arguments[0], point);
    assert.equal(send('contextmenu').defaultPrevented, true);
});

test('dragging, middle clicks, and unmatched releases do not select sand', t => {
    const { callbacks, send } = createInputHarness(t);
    const intersect = t.mock.method(THREE.Raycaster.prototype, 'intersectObjects', () => []);
    send('pointerup', { button: 0, clientX: 100, clientY: 100 });
    send('pointerdown', { button: 1, clientX: 100, clientY: 100 });
    send('pointerup', { button: 1, clientX: 100, clientY: 100 });
    send('pointerdown', { button: 0, clientX: 100, clientY: 100 });
    send('pointerup', { button: 0, clientX: 100 + INPUT.clickTolerancePx + 0.01, clientY: 100 });
    send('pointerdown', { button: 2, clientX: 100, clientY: 100 });
    send('pointerup', { button: 0, clientX: 100, clientY: 100 });
    assert.equal(intersect.mock.callCount(), 0);
    send('pointerup', { button: 2, clientX: 100, clientY: 100 });
    assert.equal(intersect.mock.callCount(), 1);
    assert.equal(callbacks.onSandClick.mock.callCount(), 0, 'a raycast miss must not select a waypoint');
});
