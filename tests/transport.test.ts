import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { BUGGY } from '../src/config.ts';
import { createActorRegistry } from '../src/actor/actorRegistry.ts';
import { createPlayerController } from '../src/character/playerController.ts';
import { createPlayerModel } from '../src/character/playerModel.ts';
import { createPlayerActor } from '../src/character/playerActor.ts';
import {
    createBuggyModel,
    createCosmoVehicleRider,
    createDefaultVehicleAttachPoints,
    createTransportManager,
    createVehicleController,
    type IVehicleModel
} from '../src/transport/index.ts';

test('TransportManager: supports registering multiple independent vehicle types', () => {
    const scene = new THREE.Scene();
    const registry = createActorRegistry();

    const playerModel = createPlayerModel({ scene });
    const playerController = createPlayerController({
        spawnPosition: new THREE.Vector3(0, 0, 4.8),
        groundAt: () => 0
    });
    const playerActor = createPlayerActor({
        model: playerModel,
        controller: playerController,
        groundAt: () => 0
    });
    registry.registerActor(playerActor);

    const rider = createCosmoVehicleRider({
        model: playerModel,
        controller: playerController,
        groundAt: () => 0
    });

    const transport = createTransportManager({
        actorRegistry: registry,
        rider
    });

    // 1. Register Buggy motorcycle
    const buggyModel = createBuggyModel({ scene, id: 'buggy' });
    const buggyController = createVehicleController({
        spawnPosition: new THREE.Vector3(BUGGY.spawnX, 0, BUGGY.spawnZ),
        spawnYaw: BUGGY.spawnYaw,
        groundAt: () => 0
    });
    const buggyDef = transport.registerVehicle({
        id: 'buggy',
        kind: 'motorcycle',
        name: 'Desert Buggy',
        model: buggyModel,
        controller: buggyController
    });

    // 2. Register a second custom vehicle type (e.g., Desert Quad / Rover)
    const customGroup = new THREE.Group();
    scene.add(customGroup);
    const customAttach = createDefaultVehicleAttachPoints();
    const customModel: IVehicleModel = {
        id: 'quad_rover',
        group: customGroup,
        pose: {
            rootPosition: new THREE.Vector3(6, 0, 6),
            rootYaw: 0,
            chassisHeightOffset: 0,
            chassisPitch: 0,
            chassisRoll: 0,
            steeringAngle: 0,
            frontGroundY: 0,
            rearGroundY: 0,
            frontWheelSpin: 0,
            rearWheelSpin: 0
        },
        update() {
            customGroup.position.copy(this.pose.rootPosition);
            customGroup.rotation.y = this.pose.rootYaw;
            customGroup.updateMatrixWorld(true);
        },
        getAttachPoints(out = customAttach) {
            out.seatPosition.copy(this.pose.rootPosition).add(new THREE.Vector3(0, 0.9, -0.1));
            out.seatQuaternion.setFromEuler(new THREE.Euler(0, this.pose.rootYaw, 0));
            out.leftHandPosition.copy(this.pose.rootPosition).add(new THREE.Vector3(-0.32, 1.15, 0.35));
            out.rightHandPosition.copy(this.pose.rootPosition).add(new THREE.Vector3(0.32, 1.15, 0.35));
            out.leftFootPosition.copy(this.pose.rootPosition).add(new THREE.Vector3(-0.30, 0.35, 0.05));
            out.rightFootPosition.copy(this.pose.rootPosition).add(new THREE.Vector3(0.30, 0.35, 0.05));
            out.leftFootQuaternion.identity();
            out.rightFootQuaternion.identity();
            out.dismountPosition.copy(this.pose.rootPosition).add(new THREE.Vector3(-1.2, 0, 0));
            out.dismountYaw = this.pose.rootYaw;
            return out;
        },
        dispose() {
            if (customGroup.parent) customGroup.parent.remove(customGroup);
        }
    };
    const customController = createVehicleController({
        spawnPosition: new THREE.Vector3(6, 0, 6),
        groundAt: () => 0
    });
    const quadDef = transport.registerVehicle({
        id: 'quad_rover',
        kind: 'quad',
        name: 'Desert Quad Rover',
        model: customModel,
        controller: customController
    });

    assert.equal(transport.getAllVehicles().length, 2);
    assert.equal(buggyDef.kind, 'motorcycle');
    assert.equal(quadDef.kind, 'quad');
    assert.ok(registry.getActor('buggy'));
    assert.ok(registry.getActor('quad_rover'));

    transport.dispose();
    registry.dispose();
});

test('VehiclePhysics: accelerates, steers, spins wheels, and adapts to dune slope', () => {
    // Sloped terrain: y increases along +Z
    const groundAt = (_x: number, z: number) => ({
        y: z * 0.12,
        normal: new THREE.Vector3(0, 0.99, -0.12).normalize(),
        surfaceType: 'sand',
        materialId: 'loose_sand',
        packing: 0.2,
        sink: 0.02,
        friction: 0.6
    });

    const controller = createVehicleController({
        spawnPosition: new THREE.Vector3(0, 0, 0),
        spawnYaw: 0,
        groundAt
    });

    const dt = 1 / 60;
    for (let i = 0; i < 45; i++) {
        const cmd = controller.update(dt, {
            actions: { forward: true, left: true, boost: true }
        });
        controller.simulateStep(dt, cmd);
    }

    const state = controller.getVisualState(1.0);
    assert.ok(state.forwardSpeed > 4.0, `Expected forwardSpeed > 4.0, got ${state.forwardSpeed}`);
    assert.ok(state.position.z > 1.0, `Expected vehicle to move forward along +Z, got ${state.position.z}`);
    assert.ok(state.steeringAngle > 0.15, `Expected positive left steeringAngle, got ${state.steeringAngle}`);
    assert.ok(state.yaw > 0.05, `Expected vehicle yaw to turn left (+yaw), got ${state.yaw}`);
    assert.ok(state.frontWheelSpin > 2.0, `Expected frontWheelSpin > 2.0, got ${state.frontWheelSpin}`);
    assert.ok(state.rearWheelSpin > 2.0, `Expected rearWheelSpin > 2.0, got ${state.rearWheelSpin}`);
    assert.ok(state.frontGroundY > state.rearGroundY, 'Front wheel on uphill slope should have higher groundY than rear wheel');
    assert.ok(state.chassisPitch < -0.02, `Expected uphill nose-up pitch (< 0 in Three.js), got ${state.chassisPitch}`);
    assert.ok(state.chassisRoll < -0.02, `Expected inward lean roll (< 0 for left turn), got ${state.chassisRoll}`);

    controller.dispose();
});

test('RiderSync & Seated IK: Cosmo pelvis, hands, and feet stay strictly locked to Buggy saddle, turning handlebars, and footpegs', () => {
    const scene = new THREE.Scene();
    const registry = createActorRegistry();

    const playerModel = createPlayerModel({ scene });
    const playerController = createPlayerController({
        spawnPosition: new THREE.Vector3(0, 0, 4.8),
        groundAt: () => 0
    });
    const playerActor = createPlayerActor({
        model: playerModel,
        controller: playerController,
        groundAt: () => 0
    });
    registry.registerActor(playerActor);

    const buggyModel = createBuggyModel({ scene, id: 'buggy' });
    const buggyController = createVehicleController({
        spawnPosition: new THREE.Vector3(BUGGY.spawnX, 0, BUGGY.spawnZ),
        spawnYaw: BUGGY.spawnYaw,
        groundAt: (x: number, z: number) => Math.sin(x * 0.1) * 0.25 + Math.cos(z * 0.1) * 0.25
    });

    const rider = createCosmoVehicleRider({
        model: playerModel,
        controller: playerController,
        groundAt: () => 0
    });
    const transport = createTransportManager({
        actorRegistry: registry,
        rider
    });
    const buggyEntry = transport.registerVehicle({
        id: 'buggy',
        kind: 'motorcycle',
        model: buggyModel,
        controller: buggyController
    });

    // Mount Cosmo via proximity interaction (Cosmo at (0, 4.8), Buggy at (2.4, 4.6) -> dist ~2.41m <= 4.5m)
    const mounted = transport.tryInteract('cosmo');
    assert.equal(mounted, true, 'Cosmo should mount nearby Buggy via tryInteract');
    assert.equal(transport.isRiderMounted(), true);
    assert.equal(transport.getMountedVehicleId(), 'buggy');
    assert.equal(registry.getActiveActor()?.id, 'buggy');
    assert.equal(playerModel.isSeated(), true);

    // Simulate driving & turning left and right across uneven terrain
    const dt = 1 / 60;
    const clawOffset = playerModel.constants.FOREARM_LEN + playerModel.constants.CLAW_GRIP_OFFSET;
    const leftClawWorld = new THREE.Vector3();
    const rightClawWorld = new THREE.Vector3();
    const pelvisWorld = new THREE.Vector3();

    for (const steerAction of [{ left: true }, { right: true }]) {
        for (let step = 0; step < 30; step++) {
            const cmd = buggyEntry.actor.controller.update(dt, {
                actions: { forward: true, ...steerAction }
            });
            buggyEntry.actor.simulateStep(dt, cmd, null);
            // Call syncVisuals on all actors just like app.ts does
            for (const actor of registry.getAllActors()) {
                actor.syncVisuals(1.0);
            }
        }

        const attach = buggyModel.getAttachPoints();

        // 1. Pelvis world position must match Buggy seatAnchor world position
        playerModel.joints.pelvisGroup.getWorldPosition(pelvisWorld);
        const pelvisError = pelvisWorld.distanceTo(attach.seatPosition);
        assert.ok(pelvisError < 1e-4, `Pelvis world position must match saddle seatPosition (err=${pelvisError})`);

        // 2. Left and right mechanical claw grip centers must match turning handlebar grips
        leftClawWorld.set(0, 0, clawOffset);
        playerModel.joints.leftArm.forearmBone.localToWorld(leftClawWorld);
        const leftHandError = leftClawWorld.distanceTo(attach.leftHandPosition);
        assert.ok(
            leftHandError < 1e-3,
            `Left claw must stay locked to left handlebar grip when steering (err=${leftHandError})`
        );

        rightClawWorld.set(0, 0, clawOffset);
        playerModel.joints.rightArm.forearmBone.localToWorld(rightClawWorld);
        const rightHandError = rightClawWorld.distanceTo(attach.rightHandPosition);
        assert.ok(
            rightHandError < 1e-3,
            `Right claw must stay locked to right handlebar grip when steering (err=${rightHandError})`
        );

        // 3. Left and right feet must match chassis footpegs
        const leftFootError = playerModel.joints.leftLeg.footGroup.position.distanceTo(attach.leftFootPosition);
        const rightFootError = playerModel.joints.rightLeg.footGroup.position.distanceTo(attach.rightFootPosition);
        assert.ok(leftFootError < 1e-4, `Left foot must rest on left footpeg (err=${leftFootError})`);
        assert.ok(rightFootError < 1e-4, `Right foot must rest on right footpeg (err=${rightFootError})`);
    }

    // Dismount via tryInteract
    const dismounted = transport.tryInteract('buggy');
    assert.equal(dismounted, true, 'Cosmo should dismount Buggy via tryInteract');
    assert.equal(transport.isRiderMounted(), false);
    assert.equal(registry.getActiveActor()?.id, 'cosmo');
    assert.equal(playerModel.isSeated(), false);

    // Verify Cosmo is standing beside the Buggy at its current location
    const buggyPos = buggyController.getPose().position;
    const cosmoPos = playerController.getPose().position;
    const distAfterDismount = Math.hypot(cosmoPos.x - buggyPos.x, cosmoPos.z - buggyPos.z);
    assert.ok(
        distAfterDismount > 0.5 && distAfterDismount < 2.0,
        `Cosmo should dismount right beside the Buggy (dist=${distAfterDismount})`
    );

    transport.dispose();
    registry.dispose();
});

test('Dismount on the move: Buggy continues rolling forward by inertia and settles without interpolation jitter', () => {
    const scene = new THREE.Scene();
    const registry = createActorRegistry();

    const playerModel = createPlayerModel({ scene, scale: 1.0 });
    const playerController = createPlayerController({
        spawnPosition: new THREE.Vector3(0, 0, 4.8),
        groundAt: () => 0
    });
    const playerActor = createPlayerActor({
        model: playerModel,
        controller: playerController,
        groundAt: () => 0
    });
    registry.registerActor(playerActor);

    const buggyModel = createBuggyModel({ scene, id: 'buggy' });
    const buggyController = createVehicleController({
        spawnPosition: new THREE.Vector3(BUGGY.spawnX, 0, BUGGY.spawnZ),
        spawnYaw: 0,
        groundAt: () => 0
    });

    const rider = createCosmoVehicleRider({
        model: playerModel,
        controller: playerController,
        groundAt: () => 0
    });
    const transport = createTransportManager({
        actorRegistry: registry,
        rider
    });
    const buggyEntry = transport.registerVehicle({
        id: 'buggy',
        kind: 'motorcycle',
        model: buggyModel,
        controller: buggyController
    });

    const dt = 1 / 60;
    transport.tryInteract('cosmo');

    // Accelerate Buggy to high speed (~10 m/s)
    for (let i = 0; i < 60; i++) {
        const cmd = buggyEntry.actor.controller.update(dt, {
            actions: { forward: true }
        });
        buggyEntry.actor.simulateStep(dt, cmd, null);
        for (const actor of registry.getAllActors()) {
            actor.syncVisuals(1.0);
        }
    }

    const speedAtDismount = buggyController.getVisualState(1.0).forwardSpeed;
    const posAtDismount = buggyController.getPose().position.clone();
    assert.ok(speedAtDismount > 8.0, `Buggy should be moving fast before dismount (speed=${speedAtDismount})`);

    // Dismount while moving at high speed
    const dismounted = transport.tryInteract('buggy');
    assert.equal(dismounted, true);
    assert.equal(registry.getActiveActor()?.id, 'cosmo');

    // Simulate 360 steps (6 seconds) where Cosmo is the active actor and Buggy coasts unmanned
    let prevCoastZ = posAtDismount.z;
    for (let i = 0; i < 360; i++) {
        const active = registry.getActiveActor()!;
        const cmd = active.controller.update(dt, { actions: {} });
        active.simulateStep(dt, cmd, null);
        transport.simulateInactiveVehicles(dt, active.id, null);

        // Verify monotonic forward progress (never jerks backward during coasting)
        const curZ = buggyController.getVisualState(0.5).position.z;
        assert.ok(curZ >= prevCoastZ - 1e-6, `Buggy must never jerk backward while coasting (step=${i})`);
        prevCoastZ = curZ;
    }

    const finalState = buggyController.getVisualState(1.0);
    const coastDistance = finalState.position.distanceTo(posAtDismount);
    assert.ok(coastDistance > 12.0, `Buggy must roll forward by inertia after dismount (dist=${coastDistance})`);
    assert.equal(finalState.forwardSpeed, 0, 'Buggy should eventually come to a smooth stop');

    // Once stopped, cycling alpha (0.0 -> 0.25 -> 0.5 -> 0.75 -> 1.0) must produce zero position/angle jitter
    const refPos = buggyController.getVisualState(0.0).position.clone();
    const refYaw = buggyController.getVisualState(0.0).yaw;
    const refOffset = buggyController.getVisualState(0.0).chassisHeightOffset;
    for (const alpha of [0.1, 0.33, 0.5, 0.78, 1.0]) {
        const vs = buggyController.getVisualState(alpha);
        assert.ok(vs.position.distanceTo(refPos) < 1e-7, `Stopped Buggy position must not jitter with alpha=${alpha}`);
        assert.ok(Math.abs(vs.yaw - refYaw) < 1e-7, `Stopped Buggy yaw must not jitter with alpha=${alpha}`);
        assert.ok(Math.abs(vs.chassisHeightOffset - refOffset) < 1e-7, `Stopped Buggy suspension must not jitter with alpha=${alpha}`);
    }

    transport.dispose();
    registry.dispose();
});

test('Buggy launches into air over a hill/dune crest (ramp) at high speed and compresses suspension on landing', () => {
    // Hill / ramp profile: flat run-up for z < 6, 22-degree ramp climb from z=6..14 (peak height 3.2m),
    // then steep leeward drop-off for z > 14 down to y = 0.
    const hillGroundAt = (_x: number, z: number) => {
        let y = 0;
        let dz = 0;
        if (z >= 6 && z <= 14) {
            y = (z - 6) * 0.40;
            dz = 0.40;
        } else if (z > 14 && z <= 22) {
            y = Math.max(0, 3.2 - (z - 14) * 0.40);
            dz = -0.40;
        }
        const normal = new THREE.Vector3(0, 1, -dz).normalize();
        return {
            y,
            normal,
            surfaceType: 'sand',
            materialId: 'loose_sand',
            packing: 0.25,
            sink: 0.02,
            friction: 0.6
        };
    };

    const controller = createVehicleController({
        spawnPosition: new THREE.Vector3(0, 0, 0),
        spawnYaw: 0,
        groundAt: hillGroundAt
    });

    const dt = 1 / 60;
    let wasAirborne = false;
    let maxAirClearance = 0;
    let liftoffEventCount = 0;
    let landingEventCount = 0;
    let minChassisOffsetAfterLanding = 0;

    for (let i = 0; i < 180; i++) {
        const cmd = controller.update(dt, {
            actions: { forward: true, boost: true }
        });
        controller.simulateStep(dt, cmd);
        const vs = controller.getVisualState(1.0);
        const groundY = hillGroundAt(vs.position.x, vs.position.z).y;
        const clearance = vs.position.y - groundY;

        if (!vs.grounded) {
            wasAirborne = true;
            if (clearance > maxAirClearance) {
                maxAirClearance = clearance;
            }
        }

        const events = controller.consumeContactEvents();
        for (const ev of events) {
            if (ev.type === 'liftoff') liftoffEventCount++;
            if (ev.type === 'landing') landingEventCount++;
        }

        if (landingEventCount > 0 && vs.chassisHeightOffset < minChassisOffsetAfterLanding) {
            minChassisOffsetAfterLanding = vs.chassisHeightOffset;
        }
    }

    assert.equal(wasAirborne, true, 'Buggy must launch into the air when crossing a hill crest at high speed');
    assert.ok(maxAirClearance > 0.35, `Buggy must achieve real airtime clearance above the downhill slope (got ${maxAirClearance}m)`);
    assert.ok(liftoffEventCount >= 1, 'Buggy must emit a liftoff contact event at the ramp crest');
    assert.ok(landingEventCount >= 1, 'Buggy must emit a landing contact event upon touching down');
    assert.ok(minChassisOffsetAfterLanding < -0.02, `Suspension must compress deeply upon landing impact (got ${minChassisOffsetAfterLanding})`);

    controller.dispose();
});

test('Buggy steering respects 165kg weight: no turn-in-place when parked and bounded lateral G at high speed', () => {
    const controller = createVehicleController({
        spawnPosition: new THREE.Vector3(0, 0, 0),
        spawnYaw: 0,
        groundAt: () => 0
    });

    const dt = 1 / 60;
    // 1. Holding left steer without throttle while parked must NOT rotate the motorcycle in place
    for (let i = 0; i < 20; i++) {
        const cmd = controller.update(dt, { actions: { left: true } });
        controller.simulateStep(dt, cmd);
    }
    assert.equal(controller.getVisualState(1.0).yaw, 0, 'Parked motorcycle must not rotate in place when steering without throttle');

    // 2. Accelerate to high speed, then apply full left steer: yaw rate must build progressively and lateral drift must engage
    for (let i = 0; i < 60; i++) {
        const cmd = controller.update(dt, { actions: { forward: true, boost: true } });
        controller.simulateStep(dt, cmd);
    }
    const yawBeforeTurn = controller.getVisualState(1.0).yaw;
    const cmdTurn1 = controller.update(dt, { actions: { forward: true, boost: true, left: true } });
    controller.simulateStep(dt, cmdTurn1);
    const yawStep1 = controller.getVisualState(1.0).yaw - yawBeforeTurn;

    for (let i = 0; i < 20; i++) {
        const cmd = controller.update(dt, { actions: { forward: true, boost: true, left: true } });
        controller.simulateStep(dt, cmd);
    }
    const stateInTurn = controller.getVisualState(1.0);
    assert.ok(yawStep1 < 0.008, `First-frame yaw step at high speed must be smooth and weighted (got ${yawStep1})`);
    assert.ok(Math.abs(stateInTurn.lateralSpeed) > 0.05, `High-speed turn on sand must produce lateral tire slip/drift (got ${stateInTurn.lateralSpeed})`);

    controller.dispose();
});


