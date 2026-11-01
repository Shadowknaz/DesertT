import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputRouter } from '../src/input/inputRouter.ts';
import { createDeviceState } from '../src/input/deviceState.ts';

function createRouterHarness(overrides = {}) {
    const target = new EventTarget();
    const actionEvents = [];
    const clickEvents = [];

    const router = createInputRouter({
        target,
        onAction: ev => actionEvents.push(ev),
        onPointerClick: ev => clickEvents.push(ev),
        ...overrides
    });

    function send(type, props = {}) {
        const event = new Event(type, { cancelable: true });
        Object.assign(event, props);
        target.dispatchEvent(event);
        return event;
    }

    return { target, router, actionEvents, clickEvents, send };
}

test('inputRouter provides OR-semantics for aliases (resolves alias bug)', () => {
    const { router, actionEvents, send } = createRouterHarness();

    // 1. Press KeyW -> forward is true
    send('keydown', { code: 'KeyW' });
    assert.equal(router.getActionState('forward'), true);
    assert.equal(actionEvents.length, 1);
    assert.equal(actionEvents[0].name, 'forward');
    assert.equal(actionEvents[0].phase, 'down');

    // 2. Press ArrowUp while KeyW is still held
    send('keydown', { code: 'ArrowUp' });
    assert.equal(router.getActionState('forward'), true);
    assert.equal(actionEvents.length, 2);

    // 3. Release KeyW -> ArrowUp is still held, forward MUST remain true!
    send('keyup', { code: 'KeyW' });
    assert.equal(router.getActionState('forward'), true, 'forward must remain true when ArrowUp is still held');
    // Notice: no 'up' action event emitted yet because action is still active
    assert.equal(actionEvents.filter(e => e.phase === 'up').length, 0);

    // 4. Release ArrowUp -> forward now becomes false
    send('keyup', { code: 'ArrowUp' });
    assert.equal(router.getActionState('forward'), false);
    const upEvents = actionEvents.filter(e => e.phase === 'up');
    assert.equal(upEvents.length, 1);
    assert.equal(upEvents[0].name, 'forward');
});

test('inputRouter prioritizes global context over actor context', () => {
    const { router, actionEvents, send } = createRouterHarness();

    send('keydown', { code: 'Digit1' });
    assert.equal(actionEvents.length, 1);
    assert.equal(actionEvents[0].name, 'weatherPreset1');
    assert.equal(actionEvents[0].context, 'global');

    send('keydown', { code: 'KeyR' });
    assert.equal(actionEvents[1].name, 'weatherCycle');
    assert.equal(actionEvents[1].context, 'global');

    send('keydown', { code: 'KeyT' });
    assert.equal(actionEvents[2].name, 'timeToggle');
    assert.equal(actionEvents[2].context, 'global');
});

test('inputRouter reports repeat flags on repeated keydown events', () => {
    const { actionEvents, send } = createRouterHarness();

    send('keydown', { code: 'KeyR' });
    send('keydown', { code: 'KeyR', repeat: true });

    assert.equal(actionEvents.length, 2);
    assert.equal(actionEvents[0].repeat, false);
    assert.equal(actionEvents[1].repeat, true);
});

test('inputRouter getActions returns snapshot of all active context actions', () => {
    const { router, send } = createRouterHarness();

    assert.deepEqual(router.getActions('mech'), {
        forward: false,
        backward: false,
        left: false,
        right: false,
        stomp: false,
        jump: false,
        toggleLights: false
    });

    send('keydown', { code: 'KeyW' });
    send('keydown', { code: 'Space' });

    assert.deepEqual(router.getActions('mech'), {
        forward: true,
        backward: false,
        left: false,
        right: false,
        stomp: true,
        jump: false,
        toggleLights: false
    });
});

test('inputRouter forwards pointer clicks', () => {
    const { clickEvents, send } = createRouterHarness();

    send('pointerdown', { button: 0, clientX: 50, clientY: 50 });
    send('pointerup', { button: 0, clientX: 50, clientY: 50 });

    assert.equal(clickEvents.length, 1);
    assert.equal(clickEvents[0].button, 0);
    assert.equal(clickEvents[0].clientX, 50);
});

test('inputRouter correctly wires up when deviceState is passed externally', () => {
    const target = new EventTarget();
    const device = createDeviceState({ target });
    const actions = [];
    const router = createInputRouter({
        deviceState: device,
        onAction: a => actions.push(a)
    });

    const ev = new Event('keydown', { cancelable: true });
    Object.assign(ev, { code: 'KeyW' });
    target.dispatchEvent(ev);

    assert.equal(router.getActionState('forward'), true);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, 'forward');

    router.dispose();
    device.dispose();
});

