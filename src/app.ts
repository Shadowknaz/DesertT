// Композиционный корень приложения: собирает бесконечный мир, физику и
// подсистемы, затем крутит главный цикл в строго заданном порядке фаз.
// Боя и врагов нет — только шестиногий шагоход, погода и песок.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

import { CAMERA, CHUNK, PALETTE, PHYSICS, RENDER, SAND, WEATHER } from './config.ts';
import { createPlayerActor } from './character/playerActor.ts';
import { createPlayerController } from './character/playerController.ts';
import { createPlayerModel } from './character/playerModel.ts';
import { getDuneHeight } from './core/duneField.ts';
import { createActorRegistry, type ActorRegistry, type RegisteredActor } from './actor/actorRegistry.ts';
import { createMechActor } from './actor/mechActor.ts';
import { createCameraDirector, type CameraDirector } from './control/cameraDirector.ts';
import { createMechDirector } from './control/mechDirector.ts';
import { createDeviceState } from './input/deviceState.ts';
import { createInputRouter, type InputRouter } from './input/inputRouter.ts';
import { createGaitController, type GaitController } from './mech/gait.ts';
import { createLegContacts, type LegContacts, type LegContactsDebug } from './mech/legContacts.ts';
import { computeFootSupport, type FootSupportResult } from './mech/legSupport.ts';
import { createLocomotion, type Locomotion } from './mech/locomotion.ts';
import { createMechRig, type MechRig } from './mech/mechRig.ts';
import { createDesertLighting } from './render/lighting.ts';
import { createPS1Pipeline } from './render/ps1Pipeline.ts';
import { createSkyDome, type SkyDome } from './render/skyDome.ts';
import { createHud } from './ui/hud.ts';
import { createChunkWorld, type ChunkWorld } from './world/chunkWorld.ts';
import { createDayCycle, type DayCycle } from './world/dayCycle.ts';
import { createDustSystem, type DustSystem } from './world/dustParticles.ts';
import { createGroundSampler, type GroundSampler } from './world/groundSampler.ts';
import { createPhysicsWorld } from './world/physics.ts';
import { createSandGranules, type SandGranules, type GranulesStats } from './world/sandGranules.ts';
import { createSandStorm } from './world/sandStorm.ts';
import { createWeather, type Weather, type WeatherState } from './world/weather.ts';
import type { SandFieldStats } from './world/sandField.ts';

export interface PhysicsStepParams {
    rig: MechRig;
    locomotion: Locomotion;
    gait: GaitController;
    contacts: LegContacts;
    world: RAPIER.World;
}

export interface PhysicsTiming {
    accumulator: number;
    substeps: number;
    droppedSteps: number;
    droppedTime: number;
}

export interface DioramaDiagnostics {
    totalVolume: number;
    fieldVolume: number;
    granulesVolume: number;
    worldReserve: number;
    granules: GranulesStats;
    field: SandFieldStats;
    contacts: LegContactsDebug | Record<string, unknown>;
    timing: PhysicsTiming;
}

export interface DioramaApp {
    start: () => void;
    dispose: () => void;
    getPhysicsTiming: () => PhysicsTiming;
    getDiagnostics: () => DioramaDiagnostics;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    world: RAPIER.World;
    chunks: ChunkWorld;
    weather: Weather;
    day: DayCycle;
    sky: SkyDome;
    rig: MechRig;
    granules: SandGranules;
    dust: DustSystem;
    actorRegistry: ActorRegistry;
    inputRouter: InputRouter;
    cameraDirector: CameraDirector;
}

// Shared with headless regressions: this is the application's actual substep.
export function simulatePhysicsStep(
    { rig, locomotion, gait, contacts, world }: PhysicsStepParams,
    dt: number,
    command: any,
    weatherState: any = null
) {
    const state = locomotion.readBodyState();
    const geometry = computeFootSupport(rig.legs, state.bodyPos.x, state.bodyPos.z, {
        y: state.bodyPos.y,
        quat: state.bodyQuat,
        com: state.bodyCom,
        vel: state.bodyVel,
        angVel: state.bodyAngVel,
        solveLoads: false
    });
    const planned = locomotion.plan(dt, geometry, command, state, weatherState);
    const result = gait.update(dt, planned);
    if (result.finishedStep) locomotion.registerStepImpact();
    if (result.stomped) locomotion.registerStompImpact();

    // Impulses change CoM/angular velocity immediately, recovery changes pose.
    // Keep plan flags/drive targets but refresh the physical snapshot before
    // the single post-gait load solve, attitude damping and sand interaction.
    Object.assign(planned, locomotion.readBodyState());
    const support = computeFootSupport(rig.legs, planned.bodyPos.x, planned.bodyPos.z, {
        y: planned.bodyPos.y,
        quat: planned.bodyQuat,
        com: planned.bodyCom,
        vel: planned.bodyVel,
        angVel: planned.bodyAngVel,
        landingGear: planned.landingGear,
        commitSupport: true
    });
    const motion = locomotion.finalize(support, planned, weatherState);
    contacts.solve(motion, support, dt);
    gait.applySand(dt, motion);
    world.step();
    return { motion, support };
}

// Only whole excess physics steps are discarded. The fractional remainder
// survives overloads and the frame clamp used by weather/rendering.
export function advancePhysicsAccumulator(timing: PhysicsTiming, elapsedDt: number): number {
    const total = timing.accumulator + elapsedDt;
    const available = Math.floor(total / PHYSICS.fixedDt + 1e-10);
    timing.substeps = Math.min(available, PHYSICS.maxSubsteps);
    const dropped = available - timing.substeps;
    timing.accumulator = Math.max(0.0, total - available * PHYSICS.fixedDt);
    timing.droppedSteps += dropped;
    timing.droppedTime += dropped * PHYSICS.fixedDt;
    return timing.substeps;
}

export async function createDioramaApp(): Promise<DioramaApp> {
    const world = await createPhysicsWorld();

    // --- Сцена, камера, рендерер ---
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.background);
    scene.fog = new THREE.FogExp2(PALETTE.fog, 0.012);

    const camera = new THREE.PerspectiveCamera(RENDER.fov, window.innerWidth / window.innerHeight, RENDER.near, RENDER.far);
    // Ниже прежней орбиты: в кадр попадает горизонт и полоса неба над ним
    camera.position.set(13, 4.0, 15);

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap; // Грубые пиксельные тени PS1
    document.body.appendChild(renderer.domElement);

    const pipeline = createPS1Pipeline({ renderer });

    // Директор камеры: прямое управление мышью (Pointer Lock / Drag), зум колесом,
    // кинематическое слежение и поддержка Third-Person Action для Cosmo и диорамы для меха.
    const cameraDirector = createCameraDirector({
        camera,
        domElement: renderer.domElement,
        getGroundHeight: getDuneHeight
    });

    const lighting = createDesertLighting(scene);

    // Сутки: солнце и луна ходят по небу, палитра неба и света берется
    // из ключевых кадров, а купол рисует градиент, светила и облака.
    const day = createDayCycle();
    const sky = createSkyDome({ scene });

    // Быстрый выбор погоды, суток и сида для демо и отладки:
    // ?weather=sandstorm&time=0.62&timeScale=0&clouds=0.6&seed=1337
    const query = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : new URLSearchParams();
    const requestedSeed = query.get('seed') ? Number.parseInt(query.get('seed')!, 10) : 1337;

    // Погода владеет ветром, порывами, туманом и облачностью: остальные системы
    // читают ее снимок, но не меняют его.
    const weather = createWeather({
        scene,
        seed: Number.isFinite(requestedSeed) ? requestedSeed : 1337
    });

    const requestedWeather = query.get('weather');
    if (requestedWeather) weather.setMode(requestedWeather, { instant: true });

    const requestedTime = Number.parseFloat(query.get('time') || '');
    if (Number.isFinite(requestedTime)) day.setTime(requestedTime);

    const requestedTimeScale = Number.parseFloat(query.get('timeScale') || '');
    if (Number.isFinite(requestedTimeScale)) day.setTimeScale(requestedTimeScale);

    const requestedClouds = Number.parseFloat(query.get('clouds') || '');
    if (Number.isFinite(requestedClouds)) weather.setCloudOverride(requestedClouds);

    // --- Бесконечный мир: сетка чанков-диорам вокруг меха ---
    const chunks = createChunkWorld({ scene, world });
    chunks.update(new THREE.Vector3(0, 0, 0), CHUNK.preloadBudget);

    const dust = createDustSystem({ scene, windAt: weather.sampleWindInto, rng: weather.rng });
    const sandStorm = createSandStorm({ scene, rng: weather.rng });
    let sampler: GroundSampler | null = null;
    const granules = createSandGranules({
        scene,
        rng: weather.rng,
        withdrawMass: (x: number, z: number, amount: number) => chunks.sandField.withdrawMass(x, z, amount),
        depositMass: (x: number, z: number, amount: number) => chunks.sandField.depositMass(x, z, amount),
        addReserve: (amount: number) => chunks.sandField.addReserve(amount),
        sampleHeight: (x: number, z: number) => chunks.sandField.sampleHeight(x, z),
        sampleGround: (x: number, z: number) => sampler ? sampler.sample(x, z) : null
    });

    // --- Шагоход: шестиногий промышленный мех ---
    const rig = createMechRig({ scene, world });
    sampler = createGroundSampler({
        world,
        mechBodies: [rig.body],
        ignoredBodyHandles: rig.footBodyHandles,
        sandField: chunks.sandField
    });

    const gait = createGaitController({
        legs: rig.legs,
        sampler,
        dust,
        granules,
        sandField: chunks.sandField,
        syncBody: rig.syncFromMotion,
        // Отпечаток стопы сразу уходит в физический heightfield.
        syncSand: (x: number, z: number, radius: number) => chunks.syncSandAt(x, z, radius)
    });
    const locomotion = createLocomotion({
        body: rig.body,
        // Высота под корпусом берется из того же пробника, что и под лапами:
        // просадка, валик и перенос песка сразу видны посадке и подъему.
        groundAt: (x: number, z: number) => sampler.sample(x, z).y
    });

    // Силовые контакты стоящих лап: пружина, демпфер и трение вместо
    // прямого управления скоростью корпуса.
    const contacts = createLegContacts({ body: rig.body, legs: rig.legs });

    // Стартовый курс меха: до первого кадра тело стоит по оси +Z
    const state0 = locomotion.readBodyState();
    let lastMotion: any = {
        ...state0,
        signedWalkSpeed: 0.0,
        desiredVelX: 0.0,
        desiredVelZ: 0.0,
        airborne: false
    };

    const hud = createHud();

    // --- Подсистема ввода: deviceState -> inputRouter -> actorRegistry -> controller ---
    const deviceState = createDeviceState();
    const inputRouter = createInputRouter({ deviceState });

    const actorRegistry = createActorRegistry({
        inputRouter,
        onActorChange: (actor: RegisteredActor) => {
            hud.updateHints(actor.hintsKey);
            if (cameraDirector && actor.cameraConfig) {
                cameraDirector.setActorCamera(actor.cameraConfig);
            }
        }
    });

    const mechDirector = createMechDirector();
    const cosmoSpawnX = 0;
    const cosmoSpawnZ = 4.8;
    const cosmoSpawnY = sampler ? sampler.sample(cosmoSpawnX, cosmoSpawnZ).y : 0;
    const playerModel = createPlayerModel({ scene, scale: 1.0 });
    const playerController = createPlayerController({
        world,
        groundAt: (x: number, z: number) => (sampler ? sampler.sample(x, z) : 0),
        speed: 2.8,
        // Персонаж появляется перед мехом на открытом песке, не заслоняя камеру.
        spawnPosition: new THREE.Vector3(cosmoSpawnX, cosmoSpawnY, cosmoSpawnZ)
    });
    if (playerController.rig?.body && typeof sampler?.ignoreBody === 'function') {
        sampler.ignoreBody(playerController.rig.body);
    }
    const simulation: PhysicsStepParams = { rig, locomotion, gait, contacts, world };

    actorRegistry.registerActor(createMechActor({
        controller: mechDirector,
        rig,
        locomotion,
        contacts,
        dust,
        granules,
        simulateStep: (dt: number = PHYSICS.fixedDt, command: any = null, weatherState: any = null) =>
            simulatePhysicsStep(simulation, dt, command, weatherState),
        cameraConfig: { ...CAMERA, minDistance: 8, maxDistance: 70, defaultDistance: 20.0, focusHeight: 0.5 }
    }));
    const playerActor = createPlayerActor({
        model: playerModel,
        controller: playerController,
        dust,
        granules,
        sandField: chunks.sandField,
        syncSand: (x: number, z: number, radius: number) => chunks.syncSandAt(x, z, radius),
        worldStep: () => world.step(),
        groundAt: (x: number, z: number) => (sampler ? sampler.sample(x, z) : 0),
        cameraConfig: { focusHeight: 1.25, followGain: 12.0, groundClearance: 0.8, minDistance: 1.8, maxDistance: 18.0, defaultDistance: 4.5 }
    });
    actorRegistry.registerActor(playerActor);
    // Сразу ставим модель в её отдельную стартовую точку, до первого кадра.
    playerActor.syncVisuals();

    const initialActor = actorRegistry.getActiveActor();
    if (initialActor) {
        hud.updateHints(initialActor.hintsKey);
        if (cameraDirector) cameraDirector.setActorCamera(initialActor.cameraConfig);
    }

    // Клик по песку больше не ставит точки и не деформирует рельеф.
    // Мышь используется исключительно для управления камерой (drag = look, wheel = zoom).

    inputRouter.onAction(({ name, context, phase }) => {
        if (context === 'global') {
            if (phase === 'down') {
                if (name === 'weatherPreset1') weather.setMode(WEATHER.order[0]);
                else if (name === 'weatherPreset2') weather.setMode(WEATHER.order[1]);
                else if (name === 'weatherPreset3') weather.setMode(WEATHER.order[2]);
                else if (name === 'weatherPreset4') weather.setMode(WEATHER.order[3]);
                else if (name === 'weatherCycle') weather.cycle();
                else if (name === 'timeToggle') day.cycleTimeScale();
            }
            return;
        }

        const activeActor = actorRegistry.getActiveActor();
        if (activeActor?.controller?.onAction) {
            activeActor.controller.onAction(name, phase);
        }
    });

    const clock = new THREE.Clock();
    const debugEnabled = query.has('debug');

    // Аккумулятор фиксированного шага: физика, походка и контакт с песком
    // всегда идут одинаковыми шагами, поэтому поведение не зависит от FPS.
    const physicsTiming: PhysicsTiming = { accumulator: 0.0, substeps: 0, droppedSteps: 0, droppedTime: 0.0 };
    let lastSupport: FootSupportResult | null = null;
    let substeps = 0;

    // --- Главный цикл симуляции и рендеринга ---
    let animId: number | null = null;
    function animate() {
        animId = requestAnimationFrame(animate);

        // Кадровое время обрезается: после фоновой вкладки физика
        // не должна догонять мир десятками подшагов.
        const elapsedDt = clock.getDelta();
        const frameDt = Math.min(elapsedDt, PHYSICS.maxFrameDt);
        const frameState = locomotion.readBodyState();

        // 1. Сутки и погода: положение светил, палитра неба, ветер, туман
        //    и облачность. Погода читает снимок суток, поэтому она вторая.
        const dayState = day.update(frameDt);
        const weatherState = weather.update(frameDt, frameState.bodyPos, dayState);

        // 2. Намерение активного актера на кадр
        const activeActor = actorRegistry.getActiveActor();
        if (!activeActor) return;
        const activePose = activeActor.getPose();
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        const cameraAzimuth = Math.atan2(camDir.x, camDir.z);

        const command = activeActor.controller.update(frameDt, {
            bodyPos: activePose.position,
            currentYaw: activePose.currentYaw ?? activePose.yaw ?? 0,
            flatFwd: activePose.flatFwd,
            cameraAzimuth,
            actions: inputRouter.getActions(activeActor.contextId)
        });

        // 3. Фиксированные подшаги: локомотив, походка, контакт с песком
        //    и world.step(). Аккумулятор убирает зависимость от FPS.
        substeps = advancePhysicsAccumulator(physicsTiming, elapsedDt);
        for (let i = 0; i < substeps; i++) {
            const result = activeActor.simulateStep(PHYSICS.fixedDt, command, weatherState);
            lastMotion = result.motion || result;
            lastSupport = result.support || lastSupport;
        }

        // 4. Синхронизация визуала с физикой (интерполяция для плавного рендера на 60-240 Гц)
        const alpha = Math.min(1.0, Math.max(0.0, physicsTiming.accumulator / PHYSICS.fixedDt));
        for (const actor of actorRegistry.getAllActors()) {
            if (typeof actor.syncVisuals === 'function') {
                actor.syncVisuals(alpha);
            }
        }

        // Песок и обломки живут ровно тем временем, которое отработала
        // физика: иначе при просадке FPS поле уезжает вперед тела.
        const simulatedDt = substeps * PHYSICS.fixedDt;

        // 5. Стриминг мира: подгрузка ближних чанков, выгрузка далеких,
        //    ветер переносит песок и толкает обломки
        chunks.update(lastMotion.bodyPos, CHUNK.buildBudget, {
            dt: simulatedDt,
            frameDt,
            weather: weatherState
        });

        // 6. Пыль, песчаная буря и actor-specific world effects
        activeActor.updateWorld({
            motion: lastMotion,
            frameDt,
            simulatedDt,
            weatherState,
            chunks,
            sampler
        });
        dust.update(frameDt);
        sandStorm.update(frameDt, lastMotion.bodyPos, weatherState, camera.position);

        // 7. Камера, небо, светила и рендер через PS1-конвейер
        const camConfig = activeActor.cameraConfig || CAMERA;
        const visualPose = typeof activeActor.getVisualPose === 'function'
            ? activeActor.getVisualPose(alpha)
            : activePose;
        cameraDirector.follow(frameDt, visualPose.position, camConfig.focusHeight, camConfig.followGain);
        cameraDirector.keepAboveGround(camConfig.groundClearance);
        lighting.update(visualPose.position, dayState, weatherState);
        sky.update(frameDt, camera, dayState, weatherState);
        const actorDebug = debugEnabled
            ? activeActor.getDebug({ lastSupport, physicsTiming })
            : {};
        hud.update(dayState, day.getTimeScale(), debugEnabled ? {
            substeps,
            planted: lastSupport ? lastSupport.plantedCount : 0,
            stability: lastSupport ? lastSupport.stability : 0,
            sink: lastSupport ? lastSupport.sink : 0,
            loadRatio: lastSupport ? lastSupport.loadRatio : 0,
            supported: lastSupport ? lastSupport.supportedLoads : 0,
            copValid: lastSupport ? lastSupport.copValid : false,
            ...actorDebug,
            field: chunks.sandField.getStats(),
            granules: granules.getStats(),
            physicsTiming: { ...physicsTiming },
            totalVolume: chunks.sandField.getTotalVolume() + granules.getTotalVolume()
        } : null);
        pipeline.setStorm(weatherState.intensity * WEATHER.screenTint);
        cameraDirector.applyShake(weatherState);
        pipeline.render(scene, camera);
        cameraDirector.revertShake();
    }

    const onResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        pipeline.resize(camera.aspect);
    };
    window.addEventListener('resize', onResize);

    function dispose() {
        if (animId !== null) cancelAnimationFrame(animId);
        window.removeEventListener('resize', onResize);
        if (inputRouter?.dispose) inputRouter.dispose();
        if (deviceState?.dispose) deviceState.dispose();
        if (actorRegistry?.dispose) actorRegistry.dispose();
        if (cameraDirector?.dispose) cameraDirector.dispose();
        if (hud?.dispose) hud.dispose();
        if (dust?.dispose) dust.dispose();
        if (sandStorm?.dispose) sandStorm.dispose();
        if (granules?.dispose) granules.dispose();
        if (chunks?.dispose) chunks.dispose();
        if (rig?.dispose) rig.dispose();
        if (sky?.dispose) sky.dispose();
        if (lighting?.dispose) lighting.dispose();
        if (weather?.dispose) weather.dispose();
        if (pipeline?.dispose) pipeline.dispose();
        if (renderer?.dispose) renderer.dispose();
        if (renderer.domElement?.parentNode) {
            renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
        if (world?.free) world.free();
    }

    return {
        start: animate,
        dispose,
        // On-demand numeric diagnostics only; no HUD or persistent panel.
        getPhysicsTiming: () => ({ ...physicsTiming }),
        getDiagnostics: () => ({
            totalVolume: chunks.sandField.getTotalVolume() + granules.getTotalVolume(),
            fieldVolume: chunks.sandField.getTotalVolume(),
            granulesVolume: granules.getTotalVolume(),
            worldReserve: chunks.sandField.getWorldReserve(),
            granules: granules.getStats(),
            field: chunks.sandField.getStats(),
            contacts: contacts.getDebug(),
            timing: { ...physicsTiming }
        }),
        scene, camera, renderer, world, chunks, weather, day, sky, rig, granules, dust,
        actorRegistry, inputRouter, cameraDirector
    };
}
