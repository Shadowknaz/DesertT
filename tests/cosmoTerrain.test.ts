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

test('playerController multi-probe sampling separates uphill, downhill, and cross-slope and limits overly steep slopes with hysteresis', () => {
    // 1. Поперечный уклон (траверс вдоль +Z при наклоне вдоль X)
    const crossNormal = new THREE.Vector3(0.42, 0.90, 0).normalize();
    const ctrlCross = createPlayerController({
        groundAt: (x, _z) => ({
            y: -x * 0.46,
            normal: crossNormal,
            surfaceType: 'sand',
            materialId: 'loose_sand',
            packing: 0.1
        }),
        speed: 2.8
    });
    const cmdCross = ctrlCross.update(0.1, { actions: { forward: true } });
    assert.ok(cmdCross.crossSlopeAngle > 0.25, `Cross-slope angle (${cmdCross.crossSlopeAngle}) must be detected`);
    assert.ok(cmdCross.worldX > 0.01, 'Loose sand cross-slope must induce slight downhill lateral drift (+X)');

    // На камне при том же поперечном уклоне бокового сноса нет
    const ctrlCrossStone = createPlayerController({
        groundAt: (x, _z) => ({
            y: -x * 0.46,
            normal: crossNormal,
            surfaceType: 'solid',
            materialId: 'stone'
        }),
        speed: 2.8
    });
    const cmdCrossStone = ctrlCrossStone.update(0.1, { actions: { forward: true } });
    assert.equal(cmdCrossStone.worldX, 0, 'Solid stone must hold firm grip on cross-slope without lateral sand drift');

    // 2. Ограничение движения на слишком крутом склоне (> maxContactAngle) и гистерезис
    let slopeDeg = 46;
    const ctrlSteep = createPlayerController({
        groundAt: (_x, z) => {
            const rad = slopeDeg * Math.PI / 180;
            return {
                y: z * Math.tan(rad),
                normal: new THREE.Vector3(0, Math.cos(rad), -Math.sin(rad)).normalize(),
                surfaceType: 'sand',
                materialId: 'loose_sand',
                maxContactAngle: 40 * Math.PI / 180
            };
        },
        speed: 2.8
    });

    const cmdBlocked = ctrlSteep.update(0.1, { actions: { forward: true } });
    assert.equal(cmdBlocked.movementLimitReason, 'steep_sand_slip', 'Climbing slope steeper than maxContactAngle must trigger steep_sand_slip');
    assert.ok(cmdBlocked.speed < 1.2, 'Speed on blocked steep slope must be strongly limited');

    // Снижаем угол чуть ниже порога входа (39°), но выше порога выхода гистерезиса (37°): блокировка должна сохраняться
    slopeDeg = 38.5;
    const cmdHysteresisHold = ctrlSteep.update(0.016, { actions: { forward: true } });
    assert.equal(cmdHysteresisHold.movementLimitReason, 'steep_sand_slip', 'Hysteresis must prevent immediate mode flicker near threshold');

    // Снижаем угол ниже порога выхода (34°): блокировка снимается
    slopeDeg = 34;
    const cmdUnblocked = ctrlSteep.update(0.016, { actions: { forward: true } });
    assert.equal(cmdUnblocked.movementLimitReason, 'none', 'Slope below exit hysteresis threshold must restore normal climb');
});

test('playerController sand sliding hysteresis prevents frame-to-frame mode toggling on undulating dunes', () => {
    let slopeDeg = 25;
    const ctrl = createPlayerController({
        groundAt: (_x, z) => {
            const rad = slopeDeg * Math.PI / 180;
            return {
                y: -z * Math.tan(rad),
                normal: new THREE.Vector3(0, Math.cos(rad), Math.sin(rad)).normalize(),
                surfaceType: 'sand',
                materialId: 'loose_sand'
            };
        },
        speed: 2.8
    });

    // Вход в скольжение при 25° (>= 22°)
    const cmd1 = ctrl.update(0.05, { actions: { crouchDown: true, forward: true } });
    assert.equal(cmd1.isSliding, true);

    // Кратковременное выполаживание до 18° (между slideExitAngle=14° и slideMinAngle=22°) не должно выключать скольжение
    slopeDeg = 18;
    const cmd2 = ctrl.update(0.016, { actions: { forward: true } });
    assert.equal(cmd2.isSliding, true, 'Sliding must remain active in angular hysteresis band (14°..22°)');

    // Однокадровый провал до 12° на 16мс (< slideExitHysteresisTime=60мс) также удерживается таймером гистерезиса
    slopeDeg = 12;
    const cmd3 = ctrl.update(0.016, { actions: { forward: true } });
    assert.equal(cmd3.isSliding, true, 'Short 16ms dip below exit angle must not flicker sliding off');
});

test('playerModel locks stance foot in world space during locomotion and selects safe foothold on steep ledges', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    const flatGround = () => ({
        y: 0,
        normal: new THREE.Vector3(0, 1, 0),
        surfaceType: 'sand',
        materialId: 'loose_sand'
    });

    // 1. Проверка удержания опорной стопы (stance foot lock) при продвижении корня вперед
    // Правая стопа при phase = 0.2 * PI находится в фазе опоры (phiR = 1.2 * PI >= PI)
    model.pose.rootPosition.set(0, 0, 0);
    model.setLocomotion({ phase: 0.2 * Math.PI, amount: 1.0, moveZ: 1 });
    model.update(flatGround);
    const initialRightFootZ = model.ikTargets.rightFoot.position.z;
    assert.equal(model.ikTargets.rightFoot.state, 'stance');

    // Продвигаем персонажа вперед на 0.04м и сдвигаем фазу внутри stance (0.28 * PI -> phiR = 1.28 * PI)
    model.pose.rootPosition.set(0, 0, 0.04);
    model.setLocomotion({ phase: 0.28 * Math.PI, amount: 1.0, moveZ: 1 });
    model.update(flatGround);
    const nextRightFootZ = model.ikTargets.rightFoot.position.z;

    assert.ok(
        Math.abs(nextRightFootZ - initialRightFootZ) < 1e-4,
        `Stance foot must remain locked in world space (${nextRightFootZ} vs ${initialRightFootZ}) without sole skating`
    );

    // 2. Проверка выбора безопасного foothold, когда впереди обрыв/уступ глубиной 0.9м
    const cliffGround = (x: number, z: number) => ({
        y: z > 0.20 ? -0.90 : 0.0,
        normal: new THREE.Vector3(0, 1, 0),
        surfaceType: 'sand',
        materialId: 'loose_sand',
        maxContactAngle: 40 * Math.PI / 180
    });

    model.pose.rootPosition.set(0, 0, 0.05);
    // Левая стопа в фазе маха (phiL = 0.8 * PI < PI), тянется вперед за z > 0.20
    model.setLocomotion({ phase: 0.8 * Math.PI, amount: 1.0, moveZ: 1, isSprinting: true });
    model.update(cliffGround);

    const lf = model.ikTargets.leftFoot;
    assert.equal(lf.footholdSafe, false, 'Unsafe cliff edge foothold must be flagged as fallback');
    assert.ok(lf.foothold.z <= 0.20, `Safe fallback foothold z (${lf.foothold.z}) must step before the 0.9m cliff drop`);
    assert.equal(lf.foothold.y, 0.0, 'Selected safe foothold must remain on the safe upper shelf');

    model.dispose();
});

test('playerModel adapts foot roll, pelvis roll, and torso lean on cross-slopes without NaN or knee pop', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    // Поперечный склон с наклоном вправо (+X ниже, чем -X)
    const crossNormal = new THREE.Vector3(0.38, 0.925, 0).normalize();
    const crossGround = (x: number, _z: number) => ({
        y: -x * 0.41,
        normal: crossNormal,
        surfaceType: 'sand',
        materialId: 'loose_sand'
    });

    for (let step = 0; step < 12; step++) {
        model.pose.rootPosition.set(0, 0, step * 0.03);
        model.setLocomotion({
            phase: step * 0.25,
            amount: 1.0,
            moveZ: 1,
            slopeAngle: 0.39,
            crossSlopeAngle: 0.39,
            forwardAccel: 2.5
        });
        model.update(crossGround);
    }

    assert.ok(Math.abs(model.ikTargets.leftFoot.roll) > 0.05, 'Foot roll must adapt to cross-slope normal');
    assert.ok(Math.abs(model.joints.pelvisGroup.rotation.z) > 0.01, 'Pelvis roll must adapt to support plane');
    assert.ok(Number.isFinite(model.joints.leftLeg.thighBone.quaternion.w));
    assert.ok(Number.isFinite(model.joints.rightLeg.shinBone.quaternion.w));

    // Проверка устойчивости к NaN на входе
    model.pose.rootPosition.set(NaN, NaN, NaN);
    model.update(crossGround);
    assert.ok(Number.isFinite(model.joints.suitRoot.position.x), 'NaN rootPosition must be sanitized without breaking IK');
    assert.ok(Number.isFinite(model.joints.leftLeg.shinBone.position.y), 'Bones must remain finite after NaN recovery');

    model.dispose();
});

test('playerActor does not duplicate footprints or dust events on repeated syncVisuals calls between simulation steps', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene });
    const controller = createPlayerController({
        groundAt: () => ({ y: 0, normal: new THREE.Vector3(0, 1, 0), surfaceType: 'sand', materialId: 'loose_sand' }),
        speed: 2.8
    });

    let stampCount = 0;
    let dustCount = 0;
    const sandField: any = {
        stampSole: () => { stampCount++; }
    };
    const dust = {
        spawnSplash: () => { dustCount++; }
    };

    const actor = createPlayerActor({
        model,
        controller,
        sandField,
        dust,
        groundAt: () => ({ y: 0, normal: new THREE.Vector3(0, 1, 0), surfaceType: 'sand', materialId: 'loose_sand' })
    });

    const dt = 1 / 60;
    for (let f = 0; f < 90; f++) {
        const cmd = controller.update(dt, { actions: { forward: true } });
        actor.simulateStep(dt, cmd, { windX: 0, windZ: 0 });

        // Первый вызов syncVisuals после шага симуляции потребляет симуляционные события
        actor.syncVisuals(0.25);
        const stampsAfterFirst = stampCount;
        const dustAfterFirst = dustCount;

        // Повторные вызовы syncVisuals с разными alpha для рендер-интерполяции не должны дублировать эффекты
        actor.syncVisuals(0.5);
        actor.syncVisuals(0.75);
        actor.syncVisuals(1.0);

        assert.equal(stampCount, stampsAfterFirst, 'Repeated syncVisuals calls must never duplicate footprint stamps');
        assert.equal(dustCount, dustAfterFirst, 'Repeated syncVisuals calls must never duplicate dust splashes');
    }

    assert.ok(stampCount > 0, 'Walking across 90 simulation steps must produce real touchdown footprints');
    assert.ok(dustCount > 0, 'Walking across 90 simulation steps must produce real touchdown dust splashes');

    const dbg = actor.getDebug();
    assert.equal(dbg.actorType, 'cosmo');
    assert.ok((dbg.eventCounts.leftTouchdown + dbg.eventCounts.rightTouchdown) === stampCount);
    assert.ok(dbg.feet.left && dbg.feet.right);

    actor.dispose();
});

test('playerActor and groundSampler handle sand-to-stone transition and deformed sand synchronization with Rapier', async () => {
    const { createPhysicsWorld, RAPIER } = await import('../src/world/physics.ts');
    const { createGroundSampler, copyGroundSample } = await import('../src/world/groundSampler.ts');
    const { createChunkTerrain } = await import('../src/world/terrain.ts');
    const { createSandDeformer } = await import('../src/world/sandDeformation.ts');
    const { chunkKeyOf } = await import('../src/core/chunkCoords.ts');
    const { getDuneHeight } = await import('../src/core/duneField.ts');

    const world = await createPhysicsWorld();
    const scene = new THREE.Scene();
    const mat = new THREE.MeshBasicMaterial();
    const terrain = createChunkTerrain({
        scene,
        world,
        cx: 0,
        cz: 0,
        sandMaterial: mat,
        skirtMaterial: mat,
        frameMaterial: mat,
        frameGeometry: new THREE.BoxGeometry(1, 1, 1)
    });
    world.step();

    const sandField = createSandField();
    const deformer = createSandDeformer({ field: sandField });
    deformer.attachChunk(chunkKeyOf(0, 0), terrain.sandGeometry, 0, 0, terrain);

    const sampler = createGroundSampler({ world, sandField });

    // Деформируем песок в точке (0, 0) и синхронизируем физический heightfield через deformer.syncPhysicsAt
    const beforeSample = copyGroundSample(sampler.sample(0, 0));
    sandField.stampCrater(0, 0, 0.85, 0.14, 0.25);
    deformer.syncPhysicsAt(0, 0);
    const afterSample = copyGroundSample(sampler.sample(0, 0));

    assert.ok(afterSample.y < beforeSample.y, `Deformed sand height (${afterSample.y}) must be lower than original (${beforeSample.y})`);
    assert.ok(afterSample.sink > 0, 'Deformed crater must report positive sink depth');
    assert.ok(afterSample.packing > 0, 'Compacted crater must report positive packing');
    assert.ok(typeof afterSample.maxContactAngle === 'number' && afterSample.maxContactAngle > 0);

    // Каменная плита (solid) при z in [0.9, 3.1], уложенная вдоль уклона дюны с выступом ~6 см
    const centerRockSample = copyGroundSample(sampler.sample(0, 2.0));
    const slabQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        centerRockSample.normal
    );
    const slabHalfH = 0.20;
    const slabCenter = new THREE.Vector3(0, centerRockSample.y, 2.0)
        .addScaledVector(centerRockSample.normal, -slabHalfH + 0.07);
    const stone = world.createCollider(
        RAPIER.ColliderDesc.cuboid(2.5, slabHalfH, 1.2)
            .setTranslation(slabCenter.x, slabCenter.y, slabCenter.z)
            .setRotation({ x: slabQuat.x, y: slabQuat.y, z: slabQuat.z, w: slabQuat.w })
            .setFriction(0.95)
    );
    world.step();
    assert.equal(sampler.sample(0, 2.0).surfaceType, 'solid', 'Stone collider must be visible to groundSampler after world.step()');

    const model = createPlayerModel({ scene });
    const spawnY = sampler.sample(0, 0.3).y;
    const controller = createPlayerController({
        world,
        groundAt: (x, z) => sampler.sample(x, z),
        speed: 2.8,
        runSpeed: 4.8,
        spawnPosition: new THREE.Vector3(0, spawnY, 0.3)
    });
    const actor = createPlayerActor({
        model,
        controller,
        sandField,
        groundAt: (x, z) => sampler.sample(x, z)
    });

    const dt = 1 / 60;
    for (let f = 0; f < 25; f++) {
        const cmd = controller.update(dt, { actions: { forward: true, sprint: true } });
        actor.simulateStep(dt, cmd, { windX: 0, windZ: 0 });
        world.step();
        actor.syncVisuals(1.0);
    }

    const dbg = actor.getDebug();
    assert.equal(dbg.surfaceType, 'solid', 'Cosmo must transition onto solid stone surface');
    assert.equal(dbg.materialId, 'stone', 'Material must be classified as stone after transition');
    assert.ok(dbg.eventCounts.solidContact > 0, 'Stepping onto stone must record solid_contact events');

    world.removeCollider(stone, true);
    actor.dispose();
    terrain.dispose();
    world.free();
});

test('Cosmo uphill sprint (Shift held) on deformed sand heightfield remains grounded and free of vertical or pelvis jitter', async () => {
    const { createPhysicsWorld } = await import('../src/world/physics.ts');
    const { createGroundSampler } = await import('../src/world/groundSampler.ts');
    const { createChunkTerrain } = await import('../src/world/terrain.ts');
    const { createSandDeformer } = await import('../src/world/sandDeformation.ts');
    const { chunkKeyOf } = await import('../src/core/chunkCoords.ts');

    const world = await createPhysicsWorld();
    const scene = new THREE.Scene();
    const mat = new THREE.MeshBasicMaterial();
    const terrain = createChunkTerrain({
        scene,
        world,
        cx: 0,
        cz: 0,
        sandMaterial: mat,
        skirtMaterial: mat,
        frameMaterial: mat,
        frameGeometry: new THREE.BoxGeometry(1, 1, 1)
    });
    world.step();

    const sandField = createSandField();
    const deformer = createSandDeformer({ field: sandField });
    deformer.attachChunk(chunkKeyOf(0, 0), terrain.sandGeometry, 0, 0, terrain);
    const sampler = createGroundSampler({ world, sandField });

    const spawnX = 0;
    const spawnZ = 4.8;
    const spawnY = sampler.sample(spawnX, spawnZ).y;
    const model = createPlayerModel({ scene, scale: 1.0 });
    const controller = createPlayerController({
        world,
        groundAt: (x, z) => sampler.sample(x, z),
        speed: 2.8,
        runSpeed: 4.8,
        spawnPosition: new THREE.Vector3(spawnX, spawnY, spawnZ)
    });
    if (controller.rig?.body) {
        sampler.ignoreBody(controller.rig.body);
    }
    const actor = createPlayerActor({
        model,
        controller,
        sandField,
        syncSand: (x, z) => deformer.syncPhysicsAt(x, z),
        worldStep: () => world.step(),
        groundAt: (x, z) => sampler.sample(x, z)
    });

    const dt = 1 / 60;
    let prevDy = 0;
    let prevPelvisWorldY = 0;
    let ungroundedFrames = 0;

    for (let f = 0; f < 150; f++) {
        const poseBefore = actor.getPose().position.clone();
        const cmd = controller.update(dt, {
            bodyPos: poseBefore,
            currentYaw: actor.getPose().currentYaw,
            cameraAzimuth: Math.PI,
            actions: { forward: 1, sprint: 1 }
        });
        actor.simulateStep(dt, cmd, { windX: 0, windZ: 0 });
        deformer.update(dt, null);
        actor.syncVisuals(1.0);

        const poseAfter = actor.getPose().position;
        const dy = poseAfter.y - poseBefore.y;
        const pelvisWorldY = model.joints.suitRoot.position.y + model.joints.pelvisGroup.position.y;
        const vState = controller.getVisualState(1.0);

        if (f > 15) {
            if (!vState.grounded) ungroundedFrames++;
            assert.equal(vState.isSprinting, true, 'isSprinting must remain stable while Shift is held uphill');
            assert.ok(vState.walkAmount > 0.85, `walkAmount (${vState.walkAmount}) must not drop or stutter during uphill sprint`);
            assert.ok(
                Math.abs(dy - prevDy) < 0.025,
                `Vertical step acceleration |d2y| (${Math.abs(dy - prevDy).toFixed(4)}m) at frame ${f} must be smooth without jitter`
            );
            assert.ok(
                Math.abs(pelvisWorldY - prevPelvisWorldY) < 0.08,
                `Pelvis world Y delta (${Math.abs(pelvisWorldY - prevPelvisWorldY).toFixed(4)}m) at frame ${f} must not snap`
            );
        }
        prevDy = dy;
        prevPelvisWorldY = pelvisWorldY;
    }

    assert.equal(ungroundedFrames, 0, 'Cosmo must stay continuously grounded while sprinting uphill on sand dunes');

    actor.dispose();
    deformer.dispose();
    terrain.dispose();
    world.free();
});





