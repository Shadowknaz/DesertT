import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPhysicsWorld, RAPIER } from '../src/world/physics.ts';
import { createPlayerRig } from '../src/character/playerRig.ts';
import { COSMO, COLLISION_GROUPS } from '../src/config.ts';

test('playerRig initializes body, capsule collider and KCC correctly', async () => {
    const world = await createPhysicsWorld();
    const spawnPos = new THREE.Vector3(5, 1, 10);
    const rig = createPlayerRig({ world, spawnPosition: spawnPos });

    assert.ok(rig.body);
    assert.ok(rig.collider);
    assert.ok(rig.characterController);

    const feet = rig.getFeetPosition();
    assert.ok(Math.abs(feet.x - 5) < 1e-4);
    assert.ok(Math.abs(feet.y - 1) < 1e-4);
    assert.ok(Math.abs(feet.z - 10) < 1e-4);

    rig.dispose();
    world.free();
});

test('playerRig collides with static obstacle and prevents penetration', async () => {
    const world = await createPhysicsWorld();
    // Создаем горизонтальный пол
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), groundBody);

    // Создаем статичный каменный куб-препятствие на x = 2.0
    const rockBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(2.0, 0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), rockBody);

    const rig = createPlayerRig({
        world,
        spawnPosition: new THREE.Vector3(0, 0, 0)
    });

    world.updateSceneQueries();

    // Пытаемся сделать большой шаг в сторону камня (+X на 3 метра)
    const { movement, grounded } = rig.computeMovement({ x: 3.0, y: 0.0, z: 0.0 });

    // Движение должно быть остановлено препятствием до x = 2 - halfExtent(0.5) - radius(0.28) ~ 1.22
    assert.ok(movement.x < 1.35, `Movement.x (${movement.x}) must stop before the rock obstacle at x=2.0`);
    assert.ok(movement.x > 0.5, 'Character must still advance towards obstacle');

    rig.applyMovement(movement);
    world.step();

    const newFeet = rig.getFeetPosition();
    assert.ok(newFeet.x < 1.35, `Feet position (${newFeet.x}) must remain outside obstacle`);

    rig.dispose();
    world.free();
});

test('playerRig detects grounded status when standing on a surface', async () => {
    const world = await createPhysicsWorld();
    // Горизонтальный пол
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.5, 10), groundBody);

    const rig = createPlayerRig({
        world,
        spawnPosition: new THREE.Vector3(0, 0.05, 0)
    });

    world.updateSceneQueries();

    // Опускаем под силой тяжести
    const { movement, grounded } = rig.computeMovement({ x: 0, y: -0.2, z: 0 });
    assert.ok(grounded, 'KCC must report grounded=true when touching ground surface');

    rig.dispose();
    world.free();
});

test('playerRig pushes dynamic debris bodies on collision', async () => {
    const world = await createPhysicsWorld();
    // Пол
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), groundBody);

    // Легкий динамический камень-шар на пути
    const debrisBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(1.0, 0.3, 0)
    );
    world.createCollider(RAPIER.ColliderDesc.ball(0.3).setMass(10.0), debrisBody);

    const rig = createPlayerRig({
        world,
        spawnPosition: new THREE.Vector3(0, 0, 0)
    });

    world.updateSceneQueries();

    // Двигаемся насквозь шара (+X)
    const { movement } = rig.computeMovement({ x: 1.5, y: 0, z: 0 });
    rig.applyMovement(movement);
    world.step();

    // Динамическое тело должно получить скорость / сместиться
    const debrisPos = debrisBody.translation();
    assert.ok(debrisPos.x > 1.0, 'Dynamic debris must be pushed forward by Cosmo');

    rig.dispose();
    world.free();
});
