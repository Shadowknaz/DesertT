import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsWorld, RAPIER } from '../src/world/physics.ts';
import { createPlayerController } from '../src/character/playerController.ts';

test('playerController moves forward and returns actor motion', () => {
    const controller = createPlayerController({ groundAt: () => 0, speed: 2 });
    const command = controller.update(0.1, { actions: { forward: true } });
    const result = controller.simulateStep(0.5, command);

    assert.ok(result.motion.bodyPos.z > 0);
    assert.equal(result.motion.bodyPos.y, 0);
    assert.equal(result.motion.currentYaw, 0);
});

test('playerController strafes right with D without rotating', () => {
    const controller = createPlayerController({ groundAt: () => 0, speed: 2 });
    const command = controller.update(0.1, { actions: { right: true } });
    const result = controller.simulateStep(0.5, command);

    assert.ok(result.motion.bodyPos.x > 0);
    assert.ok(Math.abs(result.motion.bodyPos.z) < 1e-6);
    assert.equal(result.motion.currentYaw, 0);
});

test('playerController follows terrain height and crouch action', () => {
    const controller = createPlayerController({ groundAt: (x, z) => (x + z) * 0.5, speed: 2 });
    const command = controller.update(0.1, { actions: { forward: true, crouchDown: true } });
    const result = controller.simulateStep(1, command);

    assert.ok(result.motion.bodyPos.y > 0);
    assert.equal(result.motion.crouch, 1);
});

test('playerController applies gravity and lands on the terrain', () => {
    const controller = createPlayerController({
        groundAt: () => 0,
        spawnPosition: { x: 0, y: 2, z: 0 }
    });
    const command = controller.update(0.016, { actions: {} });
    const airborne = controller.simulateStep(0.1, command);
    assert.ok(airborne.motion.bodyPos.y < 2);
    assert.equal(airborne.support.plantedCount, 0);

    const landed = controller.simulateStep(1, controller.update(1, { actions: {} }));
    assert.equal(landed.motion.bodyPos.y, 0);
    assert.equal(landed.support.plantedCount, 2);
});

test('playerController moves relative to cameraAzimuth and turns towards movement in third-person mode', () => {
    // Camera looking along -Z (azimuth = Math.PI)
    const cameraAzimuth = Math.PI;

    // Pressing forward (W) should move along -Z in world space
    const ctrlFwd = createPlayerController({ groundAt: () => 0, speed: 2 });
    const cmdFwd = ctrlFwd.update(0.1, { actions: { forward: true }, cameraAzimuth });
    const resFwd = ctrlFwd.simulateStep(0.5, cmdFwd);
    assert.ok(resFwd.motion.bodyPos.z < 0, 'W must move into screen (-Z)');

    // Pressing D (right) should move to screen right (+X in world space when looking -Z)
    const ctrlRight = createPlayerController({ groundAt: () => 0, speed: 2 });
    const cmdRight = ctrlRight.update(0.1, { actions: { right: true }, cameraAzimuth });
    const resRight = ctrlRight.simulateStep(0.5, cmdRight);
    assert.ok(resRight.motion.bodyPos.x > 0, 'D must move to screen right (+X)');

    // Pressing A (left) should move to screen left (-X in world space when looking -Z)
    const ctrlLeft = createPlayerController({ groundAt: () => 0, speed: 2 });
    const cmdLeft = ctrlLeft.update(0.1, { actions: { left: true }, cameraAzimuth });
    const resLeft = ctrlLeft.simulateStep(0.5, cmdLeft);
    assert.ok(resLeft.motion.bodyPos.x < 0, 'A must move to screen left (-X)');
});

test('playerController supports jumping with vertical velocity', () => {
    const controller = createPlayerController({ groundAt: () => 0, speed: 2 });
    const command = controller.update(0.016, { actions: { jump: true } });
    const airborne = controller.simulateStep(0.1, command);

    assert.ok(airborne.motion.bodyPos.y > 0, 'Cosmo must gain altitude during jump');
    assert.equal(airborne.support.plantedCount, 0, 'Airborne state has 0 planted feet');
});

test('playerController provides smooth render interpolation with alpha', () => {
    const controller = createPlayerController({ groundAt: () => 0, speed: 2 });
    const cmd = controller.update(0.016, { actions: { forward: true } });
    
    // Initial state
    const p0 = controller.getVisualPose(0.0).position.clone();
    
    // Simulate one step
    controller.simulateStep(0.016, cmd);
    
    // Midpoint interpolation
    const pMid = controller.getVisualPose(0.5).position.clone();
    const pEnd = controller.getVisualPose(1.0).position.clone();
    
    assert.ok(pEnd.z > p0.z, 'Step advances forward');
    assert.ok(Math.abs(pMid.z - (p0.z + pEnd.z) * 0.5) < 1e-4, 'Alpha 0.5 must yield exact midpoint');
});

test('playerController applies spring-damper suspension over height changes', () => {
    let groundHeight = 0;
    const controller = createPlayerController({ groundAt: () => groundHeight, speed: 2 });
    
    // Ground suddenly steps up by 0.2m
    groundHeight = 0.2;
    const cmd = controller.update(0.016, { actions: { forward: true } });
    
    // One physics substep should smoothly move upward without instant hard snapping
    const res = controller.simulateStep(0.016, cmd);
    assert.ok(res.motion.bodyPos.y > 0, 'Suspension must push body upward');
    assert.ok(res.motion.bodyPos.y < 0.2, 'Suspension must not snap to full height in a single 16ms step');
});

test('playerController calculates dynamic banking roll into turns', () => {
    const controller = createPlayerController({ groundAt: () => 0, speed: 2 });
    
    // Run forward while steering right
    const cmd = controller.update(0.05, { actions: { forward: true, right: true }, cameraAzimuth: 0 });
    controller.simulateStep(0.05, cmd);
    
    const state = controller.getState();
    assert.ok(Math.abs(state.bankingRoll) > 0.001, 'Banking roll must engage during steering on the run');
});


test('playerController with Rapier physics world moves forward and collides with obstacles', async () => {
    const world = await createPhysicsWorld();
    // Пол
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), groundBody);

    // Препятствие на пути (скала) на z = 1.5
    const rockBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0.5, 1.5));
    world.createCollider(RAPIER.ColliderDesc.cuboid(1.0, 0.5, 0.5), rockBody);

    world.updateSceneQueries();

    const controller = createPlayerController({
        world,
        speed: 2.0,
        spawnPosition: { x: 0, y: 0, z: 0 }
    });

    const cmd = controller.update(0.1, { actions: { forward: true }, cameraAzimuth: 0 });
    
    // Делаем несколько шагов вперед к препятствию
    for (let i = 0; i < 20; i++) {
        controller.simulateStep(0.05, cmd);
        world.step();
    }

    const finalPose = controller.getPose();
    // Препятствие на z=1.5, halfZ=0.5 -> передняя грань на z=1.0. С учетом радиуса капсулы 0.28: z <= 1.0 - 0.28 = 0.72
    assert.ok(finalPose.position.z < 0.85, `Controller position z (${finalPose.position.z}) must stop before obstacle`);
    assert.ok(finalPose.position.z > 0.4, 'Controller must advance towards obstacle');

    controller.dispose();
    world.free();
});

test('playerController with Rapier physics supports jumping and landing on ground', async () => {
    const world = await createPhysicsWorld();
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), groundBody);
    world.updateSceneQueries();

    const controller = createPlayerController({
        world,
        speed: 2.0,
        spawnPosition: { x: 0, y: 0, z: 0 }
    });

    // Прыжок
    const jumpCmd = controller.update(0.016, { actions: { jump: true } });
    const airborne = controller.simulateStep(0.05, jumpCmd);
    assert.ok(airborne.motion.bodyPos.y > 0.05, 'Cosmo must rise during jump in Rapier');

    // Симулируем падение обратно на землю
    const fallCmd = controller.update(0.016, { actions: {} });
    for (let i = 0; i < 30; i++) {
        controller.simulateStep(0.03, fallCmd);
        world.step();
    }

    const landedPose = controller.getPose();
    assert.ok(Math.abs(landedPose.position.y) < 0.05, `Cosmo must land back near ground (y=${landedPose.position.y})`);

    controller.dispose();
    world.free();
});

test('playerController accelerates on sprint action and does not trigger jump', () => {
    const controller = createPlayerController({ groundAt: () => 0, speed: 2.8, runSpeed: 5.4 });

    const walkCmd = controller.update(0.1, { actions: { forward: true } });
    assert.equal(walkCmd.isSprinting, false);
    assert.ok(Math.abs(walkCmd.speed - 2.8 * 0.9) < 0.01);

    const sprintCmd = controller.update(0.1, { actions: { forward: true, sprint: true } });
    assert.equal(sprintCmd.isSprinting, true);
    assert.ok(sprintCmd.speed > walkCmd.speed);
    assert.ok(Math.abs(sprintCmd.speed - 5.4 * 0.9) < 0.01);

    const stepRes = controller.simulateStep(0.1, sprintCmd);
    assert.equal(stepRes.motion.bodyPos.y, 0, 'Sprinting must remain grounded on flat terrain, not jump');
    assert.equal(stepRes.support.plantedCount, 2);
});

