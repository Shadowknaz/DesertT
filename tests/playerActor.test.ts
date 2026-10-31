import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayerActor } from '../src/character/playerActor.ts';

test('playerActor rebuilds world-space IK stance after movement', () => {
    const position = new THREE.Vector3(4, 2, 6);
    const controller = {
        update: () => ({}),
        getPose: () => ({ position, currentYaw: 0, flatFwd: new THREE.Vector3(0, 0, 1) }),
        getState: () => ({ position, yaw: 0, crouch: 0 }),
        simulateStep: () => ({ motion: { bodyPos: position } }),
        getDebug: () => ({})
    };
    const model = {
        pose: { rootPosition: new THREE.Vector3(), rootYaw: 0, pelvisOffset: new THREE.Vector3() },
        ikTargets: { leftFoot: { position: new THREE.Vector3() }, rightFoot: { position: new THREE.Vector3() } },
        resetTargetsToStance() {
            this.ikTargets.leftFoot.position.set(0, 0, 0);
            this.ikTargets.rightFoot.position.set(0, 0, 0);
        },
        update() {}
    };
    const actor = createPlayerActor({ model, controller });

    actor.syncVisuals();

    assert.equal(model.pose.rootPosition.y, 2);
    assert.equal(model.ikTargets.leftFoot.position.y, 2);
    assert.equal(model.ikTargets.rightFoot.position.y, 2);
});

test('playerActor adapts foot IK targets to terrain height and normal via groundAt', () => {
    const position = new THREE.Vector3(0, 3, 0);
    const controller = {
        update: () => ({}),
        getPose: () => ({ position, currentYaw: 0, flatFwd: new THREE.Vector3(0, 0, 1) }),
        getState: () => ({ position, yaw: 0, crouch: 0 }),
        simulateStep: () => ({ motion: { bodyPos: position } }),
        getDebug: () => ({})
    };
    const model = {
        pose: { rootPosition: new THREE.Vector3(), rootYaw: 0, pelvisOffset: new THREE.Vector3() },
        ikTargets: { leftFoot: { position: new THREE.Vector3(-0.2, 0, 0) }, rightFoot: { position: new THREE.Vector3(0.2, 0, 0) } },
        resetTargetsToStance() {
            this.ikTargets.leftFoot.position.set(-0.2, 0, 0);
            this.ikTargets.rightFoot.position.set(0.2, 0, 0);
        },
        update() {}
    };
    const duneNormal = new THREE.Vector3(0.1, 0.99, 0).normalize();
    const groundAt = (x, z) => ({
        y: x < 0 ? 1.5 : 2.5,
        normal: duneNormal
    });

    const actor = createPlayerActor({ model, controller, groundAt });
    actor.syncVisuals();

    assert.equal(model.ikTargets.leftFoot.position.y, 1.5);
    assert.equal(model.ikTargets.rightFoot.position.y, 2.5);
    assert.equal(model.ikTargets.leftFoot.normal, duneNormal);
    assert.equal(model.ikTargets.rightFoot.normal, duneNormal);
});


test('playerActor stamps footprints into sandField on foot touchdown', () => {
    const position = new THREE.Vector3(1, 0, 2);
    let state = { position, yaw: 0, crouch: 0, walkAmount: 0.5, walkPhase: 0 };
    const controller = {
        update: () => ({}),
        getPose: () => ({ position, currentYaw: 0, flatFwd: new THREE.Vector3(0, 0, 1) }),
        getState: () => state,
        simulateStep: () => ({ motion: { bodyPos: position } }),
        getDebug: () => ({})
    };

    const model = {
        pose: { rootPosition: new THREE.Vector3(), rootYaw: 0, pelvisOffset: new THREE.Vector3() },
        ikTargets: {
            leftFoot: { position: new THREE.Vector3(0.8, 0, 2), contactWeight: 0.0 }, // lifted
            rightFoot: { position: new THREE.Vector3(1.2, 0, 2), contactWeight: 1.0 }
        },
        resetTargetsToStance() {},
        update() {}
    };

    const stamped = [];
    const sandField = {
        stampCrater: (x, z, radius, depth) => {
            stamped.push({ x, z, radius, depth });
        }
    };

    const actor = createPlayerActor({ model, controller, sandField });

    // Первый кадр: левая нога в воздухе (contactWeight = 0.0 < 0.9)
    actor.syncVisuals();
    assert.equal(stamped.length, 0, 'No footprints while foot is in the air');

    // Второй кадр: левая нога опускается на песок (contactWeight = 1.0 >= 0.9)
    model.ikTargets.leftFoot.contactWeight = 1.0;
    actor.syncVisuals();

    assert.equal(stamped.length, 1, 'Footprint must be stamped upon foot touchdown');
    assert.equal(stamped[0].x, 0.8);
    assert.equal(stamped[0].z, 2);
    assert.ok(stamped[0].radius > 0);
    assert.ok(stamped[0].depth > 0);
});
