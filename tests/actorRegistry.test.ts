import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorRegistry } from '../src/actor/actorRegistry.ts';

function createDummyActor(id, overrides = {}) {
    return {
        id,
        contextId: id,
        controller: { update: () => ({}) },
        getPose: () => ({ position: { x: 0, y: 0, z: 0 } }),
        simulateStep: () => ({ motion: { bodyPos: { x: 0, y: 0, z: 0 } } }),
        syncVisuals: () => {},
        updateWorld: () => {},
        getDebug: () => ({}),
        ...overrides
    };
}

test('actorRegistry validates actor contract', () => {
    const registry = createActorRegistry();

    assert.throws(() => registry.registerActor(null), /must be an object/);
    assert.throws(() => registry.registerActor({}), /non-empty string "id"/);
    assert.throws(() => registry.registerActor({ id: 'bad' }), /update\(dt, ctx\)/);
    assert.throws(() => registry.registerActor({ id: 'bad', controller: { update: () => {} } }), /getPose/);
});

test('actorRegistry registers actor and sets first registered as active', () => {
    let contextSet = null;
    const mockRouter = {
        setContext: ctx => { contextSet = ctx; },
        onAction: () => () => {}
    };
    const registry = createActorRegistry({ inputRouter: mockRouter });

    const mechActor = createDummyActor('mech');
    registry.registerActor(mechActor);

    assert.equal(registry.getActiveActor().id, 'mech');
    assert.equal(contextSet, 'mech');
    assert.equal(registry.getActiveActor().cameraConfig.focusHeight, 0.5);
});

test('actorRegistry switches active actor and notifies context', () => {
    let contextSet = null;
    let changedActor = null;
    const mockRouter = {
        setContext: ctx => { contextSet = ctx; },
        onAction: () => () => {}
    };
    const registry = createActorRegistry({
        inputRouter: mockRouter,
        onActorChange: a => { changedActor = a; }
    });

    registry.registerActor(createDummyActor('mech'));
    registry.registerActor(createDummyActor('cosmo'));

    assert.equal(registry.getActiveActor().id, 'mech');

    registry.setActiveActor('cosmo');
    assert.equal(registry.getActiveActor().id, 'cosmo');
    assert.equal(contextSet, 'cosmo');
    assert.equal(changedActor.id, 'cosmo');
});

test('actorRegistry cycles actors sequentially', () => {
    const registry = createActorRegistry();
    registry.registerActor(createDummyActor('mech'));
    registry.registerActor(createDummyActor('cosmo'));
    registry.registerActor(createDummyActor('drone'));

    assert.equal(registry.getActiveActor().id, 'mech');
    registry.cycleActor();
    assert.equal(registry.getActiveActor().id, 'cosmo');
    registry.cycleActor();
    assert.equal(registry.getActiveActor().id, 'drone');
    registry.cycleActor();
    assert.equal(registry.getActiveActor().id, 'mech');
});

test('actorRegistry automatically cycles when switchActor action is received', () => {
    let actionHandler = null;
    const mockRouter = {
        setContext: () => {},
        onAction: fn => { actionHandler = fn; return () => {}; }
    };
    const registry = createActorRegistry({ inputRouter: mockRouter });

    registry.registerActor(createDummyActor('mech'));
    registry.registerActor(createDummyActor('cosmo'));

    assert.equal(registry.getActiveActor().id, 'mech');

    // Simulate Tab (switchActor) action
    actionHandler({ name: 'switchActor', phase: 'down' });
    assert.equal(registry.getActiveActor().id, 'cosmo');

    actionHandler({ name: 'switchActor', phase: 'up' }); // Phase up ignored
    assert.equal(registry.getActiveActor().id, 'cosmo');

    actionHandler({ name: 'switchActor', phase: 'down' });
    assert.equal(registry.getActiveActor().id, 'mech');
});
