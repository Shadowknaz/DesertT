import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFAULT_BINDINGS } from '../src/input/bindings.ts';
import { createInputRouter } from '../src/input/inputRouter.ts';
import { createPlayerController } from '../src/character/playerController.ts';
import { createPlayerModel } from '../src/character/playerModel.ts';
import { createActorLights } from '../src/render/actorLights.ts';

test('DEFAULT_BINDINGS binds crouch only to ControlLeft and ControlRight, and toggleLights to KeyL per actor context', () => {
    assert.deepEqual(DEFAULT_BINDINGS.cosmo.crouch, ['ControlLeft', 'ControlRight']);
    assert.equal(DEFAULT_BINDINGS.cosmo.crouchDown, undefined);
    assert.equal(DEFAULT_BINDINGS.cosmo.crouchUp, undefined);
    assert.equal(DEFAULT_BINDINGS.global.toggleLights, undefined);
    assert.deepEqual(DEFAULT_BINDINGS.mech.toggleLights, ['KeyL']);
    assert.deepEqual(DEFAULT_BINDINGS.cosmo.toggleLights, ['KeyL']);

    const target = new EventTarget();
    const events: any[] = [];
    const router = createInputRouter({
        target,
        onAction: (ev) => events.push(ev)
    });
    router.setContext('cosmo');

    function send(type: string, code: string) {
        const event = new Event(type, { cancelable: true });
        Object.assign(event, { code });
        target.dispatchEvent(event);
    }

    // Q and E must NOT trigger any crouch action
    send('keydown', 'KeyQ');
    send('keyup', 'KeyQ');
    send('keydown', 'KeyE');
    send('keyup', 'KeyE');
    assert.equal(events.length, 0, 'KeyQ and KeyE must not emit crouch actions');

    // ControlLeft must trigger crouch in cosmo context
    send('keydown', 'ControlLeft');
    assert.equal(router.getActionState('crouch'), true);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'crouch');
    assert.equal(events[0].context, 'cosmo');
    assert.equal(events[0].phase, 'down');
    send('keyup', 'ControlLeft');
    assert.equal(router.getActionState('crouch'), false);

    // KeyL while in cosmo context must trigger toggleLights in cosmo context
    send('keydown', 'KeyL');
    const cosmoLightEv = events[events.length - 1];
    assert.equal(cosmoLightEv.name, 'toggleLights');
    assert.equal(cosmoLightEv.context, 'cosmo');
    assert.equal(cosmoLightEv.phase, 'down');
    send('keyup', 'KeyL');

    // KeyL while in mech context must trigger toggleLights in mech context
    router.setContext('mech');
    send('keydown', 'KeyL');
    const mechLightEv = events[events.length - 1];
    assert.equal(mechLightEv.name, 'toggleLights');
    assert.equal(mechLightEv.context, 'mech');
    assert.equal(mechLightEv.phase, 'down');
    send('keyup', 'KeyL');

    router.dispose();
});

test('PlayerController toggles crouch on and off exclusively with CTRL (crouch action)', () => {
    const controller = createPlayerController({ groundAt: () => 0, speed: 2.8 });

    // Initially standing (crouch === 0)
    let cmd = controller.update(0.016, { actions: { crouch: false } });
    assert.equal(cmd.crouch, 0);

    // 1st press of CTRL -> crouches (crouch === 1)
    controller.onAction('crouch', 'down', false);
    cmd = controller.update(0.016, { actions: { crouch: true } });
    assert.equal(cmd.crouch, 1, 'First CTRL press must crouch');

    // Holding CTRL across multiple frames does NOT untoggle crouch
    cmd = controller.update(0.016, { actions: { crouch: true } });
    assert.equal(cmd.crouch, 1, 'Holding CTRL must keep crouch = 1');

    // Releasing CTRL keeps Cosmo crouched (toggle behavior)
    controller.onAction('crouch', 'up', false);
    cmd = controller.update(0.016, { actions: { crouch: false } });
    assert.equal(cmd.crouch, 1, 'Releasing CTRL must remain crouched until pressed again');

    // 2nd press of CTRL -> stands up (crouch === 0)
    controller.onAction('crouch', 'down', false);
    cmd = controller.update(0.016, { actions: { crouch: true } });
    assert.equal(cmd.crouch, 0, 'Second CTRL press must stand Cosmo back up');

    // Releasing CTRL after standing up keeps Cosmo standing
    controller.onAction('crouch', 'up', false);
    cmd = controller.update(0.016, { actions: { crouch: false } });
    assert.equal(cmd.crouch, 0);
});

test('createActorLights controls Mech and Cosmo lights independently', () => {
    const scene = new THREE.Scene();
    const chassisGroup = new THREE.Group();
    scene.add(chassisGroup);
    const mockMechRig = { chassisGroup } as any;
    const playerModel = createPlayerModel({ scene, scale: 1.0 });

    const actorLights = createActorLights({
        scene,
        mechRig: mockMechRig,
        playerModel,
        initialEnabled: false
    });

    assert.equal(actorLights.isEnabled('mech'), false);
    assert.equal(actorLights.isEnabled('cosmo'), false);
    assert.equal(actorLights.mechLightGroup.parent, chassisGroup);
    assert.equal(actorLights.cosmoHeadLightGroup.parent, playerModel.joints.headGroup);
    assert.equal(actorLights.cosmoTorsoLightGroup.parent, playerModel.joints.torsoGroup);
    assert.ok(actorLights.mechLights.length >= 4);
    assert.ok(actorLights.cosmoLights.length >= 2);

    // Toggle ONLY Mech lights ON -> Cosmo lights MUST remain OFF
    assert.equal(actorLights.toggle('mech'), true);
    assert.equal(actorLights.isEnabled('mech'), true);
    assert.equal(actorLights.isEnabled('cosmo'), false, 'Cosmo lights must stay OFF when Mech lights are toggled ON');
    for (const light of actorLights.mechLights) {
        assert.ok(light.intensity > 0, 'Mech lights must be ON');
    }
    for (const light of actorLights.cosmoLights) {
        assert.equal(light.intensity, 0, 'Cosmo lights must remain at 0 intensity');
    }

    // Toggle ONLY Cosmo lights ON -> both are now ON independently
    assert.equal(actorLights.toggle('cosmo'), true);
    assert.equal(actorLights.isEnabled('mech'), true);
    assert.equal(actorLights.isEnabled('cosmo'), true);
    for (const light of actorLights.cosmoLights) {
        assert.ok(light.intensity > 0, 'Cosmo lights must now be ON');
    }

    // Toggle Mech lights OFF -> Cosmo lights MUST remain ON
    assert.equal(actorLights.toggle('mech'), false);
    assert.equal(actorLights.isEnabled('mech'), false);
    assert.equal(actorLights.isEnabled('cosmo'), true, 'Cosmo lights must remain ON when Mech lights are turned OFF');
    for (const light of actorLights.mechLights) {
        assert.equal(light.intensity, 0, 'Mech lights must be OFF');
    }
    for (const light of actorLights.cosmoLights) {
        assert.ok(light.intensity > 0, 'Cosmo lights must still be ON');
    }

    // Toggle Cosmo lights OFF
    assert.equal(actorLights.toggle('cosmo'), false);
    assert.equal(actorLights.isEnabled('cosmo'), false);

    actorLights.dispose();
    assert.equal(actorLights.mechLightGroup.parent, null);
    assert.equal(actorLights.cosmoHeadLightGroup.parent, null);
    assert.equal(actorLights.cosmoTorsoLightGroup.parent, null);
    playerModel.dispose();
});
