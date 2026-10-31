import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayerController } from '../src/character/playerController.ts';
import { createPlayerActor } from '../src/character/playerActor.ts';
import { createPlayerModel } from '../src/character/playerModel.ts';
import { createSandField } from '../src/world/sandField.ts';
import { COSMO } from '../src/config.ts';

test('playerController reduces speed when climbing steep uphill slopes', () => {
    // Плоская поверхность для сравнения
    const ctrlFlat = createPlayerController({ groundAt: () => 0, speed: 2.8 });
    const cmdFlat = ctrlFlat.update(0.1, { actions: { forward: true } });

    // Крутой подъем вперед (+Z) с уклоном ~30° (высота возрастает на 0.57м на каждый метр пути)
    const ctrlUphill = createPlayerController({
        groundAt: (x, z) => z * 0.57,
        speed: 2.8
    });
    const cmdUphill = ctrlUphill.update(0.1, { actions: { forward: true } });

    assert.ok(
        cmdUphill.speed < cmdFlat.speed,
        `Uphill speed (${cmdUphill.speed}) must be strictly slower than flat speed (${cmdFlat.speed})`
    );
    assert.ok(cmdUphill.speed > 1.2, `Uphill speed (${cmdUphill.speed}) must retain viable forward momentum`);
});

test('playerController accelerates when running downhill on moderate slopes', () => {
    const ctrlFlat = createPlayerController({ groundAt: () => 0, speed: 2.8 });
    const cmdFlat = ctrlFlat.update(0.1, { actions: { forward: true } });

    // Спуск под гору (~18° уклон вниз при движении +Z)
    const ctrlDownhill = createPlayerController({
        groundAt: (x, z) => -z * 0.32,
        speed: 2.8
    });
    const cmdDownhill = ctrlDownhill.update(0.1, { actions: { forward: true } });

    assert.ok(
        cmdDownhill.speed > cmdFlat.speed,
        `Downhill speed (${cmdDownhill.speed}) must be faster than flat speed (${cmdFlat.speed})`
    );
});

test('playerController modulates speed based on soil material classification', () => {
    const ctrlLoose = createPlayerController({
        groundAt: (x, z) => ({ y: 0, normal: new THREE.Vector3(0, 1, 0), surfaceType: 'sand', materialId: 'loose_sand' }),
        speed: 2.8
    });
    const cmdLoose = ctrlLoose.update(0.1, { actions: { forward: true } });

    const ctrlStone = createPlayerController({
        groundAt: (x, z) => ({ y: 0, normal: new THREE.Vector3(0, 1, 0), surfaceType: 'solid', materialId: 'stone' }),
        speed: 2.8
    });
    const cmdStone = ctrlStone.update(0.1, { actions: { forward: true } });

    assert.ok(
        cmdStone.speed > cmdLoose.speed,
        `Firm stone grip (${cmdStone.speed}) must provide higher speed than loose sand (${cmdLoose.speed})`
    );
});

test('playerController enters sand sliding (dune surfing) on steep sand dunes with crouch', () => {
    // Дюна с крутым уклоном вниз вдоль оси +Z (уклон 30°, тангаж вниз)
    // нормаль наклонена назад: nx=0, ny=0.866, nz=0.5 -> спуск по +Z
    const duneNormal = new THREE.Vector3(0, 0.866, 0.5).normalize();
    const ctrl = createPlayerController({
        groundAt: (x, z) => ({
            y: -z * 0.58,
            normal: duneNormal,
            surfaceType: 'sand',
            materialId: 'loose_sand'
        }),
        speed: 2.8,
        spawnPosition: new THREE.Vector3(0, 0, 0)
    });

    // Нажатие приседания (Crouch) на крутом спуске активирует серфинг
    const cmdSlide = ctrl.update(0.1, {
        actions: { crouchDown: true, forward: true }
    });

    assert.equal(cmdSlide.isSliding, true, 'Sand sliding must engage on steep sand dune with crouch');
    assert.ok(cmdSlide.speed > 2.8, `Slide speed (${cmdSlide.speed}) must exceed standard speed`);
    assert.equal(cmdSlide.walkAmount, 0, 'Feet must remain planted during slide (no walking cycles)');

    // Симулируем несколько шагов ускорения вниз по дюне
    let lastResult;
    for (let i = 0; i < 5; i++) {
        lastResult = ctrl.simulateStep(0.05, cmdSlide);
    }

    assert.equal(lastResult.motion.isSliding, true);
    assert.ok(lastResult.motion.slideSpeed > 3.0, 'Cosmo must accelerate down the dune');
});

test('playerActor uses stampSole for oriented footprints and ignores solid rock', () => {
    const position = new THREE.Vector3(2, 0, 2);
    const controller = {
        update: () => ({}),
        getPose: () => ({ position, currentYaw: Math.PI / 4, flatFwd: new THREE.Vector3(1, 0, 1).normalize() }),
        getState: () => ({ position, yaw: Math.PI / 4, crouch: 0, walkAmount: 0.6, walkPhase: 0 }),
        simulateStep: () => ({ motion: { bodyPos: position } }),
        getDebug: () => ({})
    };

    const model = {
        pose: { rootPosition: new THREE.Vector3(), rootYaw: Math.PI / 4, pelvisOffset: new THREE.Vector3() },
        ikTargets: {
            leftFoot: { position: new THREE.Vector3(1.8, 0, 2), contactWeight: 0.0, pitch: 0.05, roll: 0.01 },
            rightFoot: { position: new THREE.Vector3(2.2, 0, 2), contactWeight: 1.0, pitch: 0.0, roll: 0.0 }
        },
        resetTargetsToStance() {},
        update() {},
        setLocomotion() {}
    };

    const stampedSoles = [];
    const sandField = {
        stampSole: (x, z, width, length, heading, pitch, roll, depth, compaction) => {
            stampedSoles.push({ x, z, width, length, heading, pitch, roll, depth, compaction });
        }
    };

    // Случай 1: песок
    const groundAtSand = (x, z) => ({ y: 0, surfaceType: 'sand' });
    const actorSand = createPlayerActor({ model, controller, sandField, groundAt: groundAtSand });

    // Кадр 1: нога в воздухе
    actorSand.syncVisuals();
    assert.equal(stampedSoles.length, 0);

    // Кадр 2: касание стопой песка
    model.ikTargets.leftFoot.contactWeight = 1.0;
    actorSand.syncVisuals();
    assert.equal(stampedSoles.length, 1, 'Oriented sole footprint must be stamped into sand');
    assert.ok(stampedSoles[0].width > 0);
    assert.ok(stampedSoles[0].length > 0);
    assert.equal(stampedSoles[0].heading, Math.PI / 4);

    // Случай 2: твердый камень (solid rock) — кратеры не создаются
    stampedSoles.length = 0;
    const groundAtRock = (x, z) => ({ y: 0, surfaceType: 'solid' });
    const actorRock = createPlayerActor({ model, controller, sandField, groundAt: groundAtRock });

    // Касание на камне
    model.ikTargets.leftFoot.contactWeight = 0.0;
    actorRock.syncVisuals();
    model.ikTargets.leftFoot.contactWeight = 1.0;
    actorRock.syncVisuals();

    assert.equal(stampedSoles.length, 0, 'No footprints must be stamped on solid rock');
});

test('playerActor deforms real sandField during walking and sprinting', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene });
    const controller = createPlayerController({ groundAt: () => 0, speed: 2.8, runSpeed: 5.4 });
    const sandField = createSandField();
    sandField.attachChunk(0, 0);

    let syncCount = 0;
    const actor = createPlayerActor({
        model,
        controller,
        sandField,
        syncSand: () => { syncCount++; },
        groundAt: () => ({ y: 0, surfaceType: 'sand' })
    });

    // Шагаем вперед 2 секунды
    const dt = 1 / 60;
    for (let f = 0; f < 120; f++) {
        const cmd = controller.update(dt, { actions: { forward: true } });
        controller.simulateStep(dt, cmd);
        actor.syncVisuals(1.0);
    }

    const stats = sandField.getStats();
    assert.ok(stats.deformed > 0, `Walking must create deformed footprints in sand: ${stats.deformed}`);
    assert.ok(stats.dirty > 0, 'Chunks must be marked dirty for mesh redraw');
    assert.ok(syncCount > 0, 'Physics sync must be triggered for stamped footsteps');

    // Спринт: шагаем еще 1 секунду на спринте
    const deformedBeforeSprint = stats.deformed;
    for (let f = 0; f < 60; f++) {
        const cmd = controller.update(dt, { actions: { forward: true, sprint: true } });
        controller.simulateStep(dt, cmd);
        actor.syncVisuals(1.0);
    }

    assert.ok(sandField.getStats().deformed > deformedBeforeSprint, 'Sprinting must add more footprint deformations');
});

test('playerActor leaves footprints and dust on landing from a jump', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene });
    const controller = createPlayerController({ groundAt: () => 0, speed: 2.8 });
    const sandField = createSandField();
    sandField.attachChunk(0, 0);

    const splashes = [];
    const dust = {
        spawnSplash: (pos, count, intensity) => splashes.push({ pos: pos.clone(), count, intensity })
    };

    const actor = createPlayerActor({
        model,
        controller,
        sandField,
        dust,
        groundAt: () => ({ y: 0, surfaceType: 'sand' })
    });

    // 1. Прыжок (Cosmo в воздухе)
    const dt = 1 / 60;
    const jumpCmd = controller.update(dt, { actions: { jump: true } });
    controller.simulateStep(dt, jumpCmd);
    actor.syncVisuals(1.0);

    // 2. Несколько кадров полета
    for (let i = 0; i < 15; i++) {
        const fallCmd = controller.update(dt, { actions: {} });
        controller.simulateStep(dt, fallCmd);
        actor.syncVisuals(1.0);
    }

    // 3. Симулируем приземление на землю
    for (let i = 0; i < 30; i++) {
        const landCmd = controller.update(dt, { actions: {} });
        controller.simulateStep(dt, landCmd);
        actor.syncVisuals(1.0);
    }

    assert.ok(splashes.length > 0, 'Landing on sand must spawn dust splash');
    const landingStats = sandField.getStats();
    assert.ok(landingStats.deformed > 0, 'Landing on sand must stamp impact footprints');
});

test('playerRig climbs sloped terrain with smooth progression without sawtooth oscillation', async () => {
    const { createPhysicsWorld, RAPIER } = await import('../src/world/physics.ts');
    const world = await createPhysicsWorld();

    const n = 10;
    const heights = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            heights[i * n + j] = j * 0.35; // uphill slope
        }
    }
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
    world.createCollider(RAPIER.ColliderDesc.heightfield(n - 1, n - 1, heights, { x: 20, y: 1, z: 20 }), groundBody);
    world.updateSceneQueries();

    const controller = createPlayerController({
        world,
        speed: 2.8,
        runSpeed: 4.8,
        spawnPosition: new THREE.Vector3(0, 1.0, -5)
    });

    const dt = 1 / 60;
    const dyHistory = [];
    for (let f = 0; f < 30; f++) {
        const cmd = controller.update(dt, { actions: { forward: true, sprint: true } });
        const posBefore = controller.getPose().position.clone();
        controller.simulateStep(dt, cmd);
        world.step();
        const posAfter = controller.getPose().position.clone();
        if (f >= 15) {
            dyHistory.push(posAfter.y - posBefore.y);
        }
    }

    // Uphill vertical progression must be consistently upward (dy >= 0) without alternating negative sawtooth drops
    for (let i = 0; i < dyHistory.length; i++) {
        assert.ok(dyHistory[i] >= 0, `dy at step ${i} (${dyHistory[i]}) must not drop downhill during steady uphill sprint`);
    }

    controller.dispose();
    world.free();
});

test('playerModel calculates smooth pelvis adaptation on slope without swing foot spikes', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    const slopeGround = (x, z) => ({
        y: -z * 0.25, // downhill slope
        normal: new THREE.Vector3(0, 0.968, 0.25).normalize()
    });

    // Step through several walk phases: phase 0 to PI
    const pelvisYList = [];
    for (let p = 0; p <= 10; p++) {
        const phase = (p / 10) * Math.PI;
        model.setLocomotion({ phase, amount: 1.0, moveZ: 1 });
        model.update(slopeGround);
        pelvisYList.push(model.joints.pelvisGroup.position.y);
    }

    // Check that pelvis height difference between adjacent frames is smooth and bounded
    for (let i = 1; i < pelvisYList.length; i++) {
        const delta = Math.abs(pelvisYList[i] - pelvisYList[i - 1]);
        assert.ok(delta < 0.03, `Pelvis delta between gait phases (${delta}m) must be smooth and bounded`);
    }

    model.dispose();
});


