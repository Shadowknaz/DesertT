import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CELL_SIZE,
    FOUND_HEIGHT,
    WALL_HEIGHT,
    PIECE_CATALOG,
    PIECE_ORDER,
    World,
    canPlace,
    cellKey,
    BuildingChunkRenderer,
    getBakedPrefabAsset
} from '../src/building/index.ts';

test('PIECE_CATALOG defines all 7 modular prefabs with sockets and compatibility rules', () => {
    assert.equal(PIECE_ORDER.length, 7);
    for (const type of PIECE_ORDER) {
        const def = PIECE_CATALOG[type];
        assert.ok(def, `Missing PieceDef for ${type}`);
        assert.equal(def.type, type);
        assert.ok(def.sockets.length > 0, `PieceDef ${type} must have sockets`);
        assert.deepEqual(def.size, { x: 1, y: 1, z: 1 });
    }
    assert.equal(PIECE_CATALOG.foundation.requiresGround, true);
    assert.equal(PIECE_CATALOG.solid_wall.requiresGround, false);
    assert.equal(PIECE_CATALOG.window_wall.requiresGround, false);
    assert.equal(PIECE_CATALOG.door_wall.requiresGround, false);
    assert.equal(PIECE_CATALOG.ceiling.requiresGround, false);
    assert.equal(PIECE_CATALOG.staircase_railed.requiresGround, false);
    assert.equal(PIECE_CATALOG.staircase_open.requiresGround, false);
});

test('World stores cells as Map<string, Piece[]> and validates foundation placement with canPlace', () => {
    const world = new World(() => 1.25);
    assert.ok(world.cells instanceof Map);

    // Фундамент ставится на землю (y = 0)
    assert.equal(canPlace(PIECE_CATALOG.foundation, { x: 0, y: 0, z: 0 }, 0), true);
    // Фундамент нельзя поставить в воздухе (y = 1)
    assert.equal(canPlace(PIECE_CATALOG.foundation, { x: 0, y: 1, z: 0 }, 0), false);

    // Стены, потолки и лестницы нельзя ставить в пустом мире без опоры и сокетов
    assert.equal(canPlace(PIECE_CATALOG.solid_wall, { x: 0, y: 0, z: 0 }, 0), false);
    assert.equal(canPlace(PIECE_CATALOG.ceiling, { x: 0, y: 0, z: 0 }, 0), false);
    assert.equal(canPlace(PIECE_CATALOG.staircase_railed, { x: 0, y: 0, z: 0 }, 0), false);

    // Размещаем фундамент в (0, 0, 0)
    const placedFound = world.placePiece('foundation', { x: 0, y: 0, z: 0 }, 0, 1);
    assert.ok(placedFound);
    assert.equal(world.cells.get(cellKey(0, 0, 0))?.length, 1);

    // Повторно фундамент в ту же клетку поставить нельзя
    assert.equal(canPlace(PIECE_CATALOG.foundation, { x: 0, y: 0, z: 0 }, 0), false);
});

test('Socket validation: walls, ceilings, stairs, and 2nd story require compatible sockets and check intersections', () => {
    const world = new World(() => 0);

    // Ставим фундамент в (0, 0, 0)
    assert.ok(world.placePiece('foundation', { x: 0, y: 0, z: 0 }, 0, 1));

    // На всех 4 гранях фундамента теперь доступны сокеты wall_bottom
    for (const rot of [0, 1, 2, 3] as const) {
        assert.equal(world.canPlace('solid_wall', { x: 0, y: 0, z: 0 }, rot), true);
    }

    // Ставим северную глухую стену (rot = 0) и южную гермодверь (rot = 2)
    assert.ok(world.placePiece('solid_wall', { x: 0, y: 0, z: 0 }, 0, 1));
    assert.ok(world.placePiece('door_wall', { x: 0, y: 0, z: 0 }, 2, 1));

    // На занятую северную грань (rot = 0) больше нельзя поставить ни глухую стену, ни окно
    assert.equal(world.canPlace('solid_wall', { x: 0, y: 0, z: 0 }, 0), false);
    assert.equal(world.canPlace('window_wall', { x: 0, y: 0, z: 0 }, 0), false);

    // Проверяем защиту от пересечения со смежной клеткой:
    // Северная грань клетки (0,0,0) (rot=0) — это южная грань клетки (0,0,-1) (rot=2)
    assert.ok(world.placePiece('foundation', { x: 0, y: 0, z: -1 }, 0, 1));
    assert.equal(world.canPlace('solid_wall', { x: 0, y: 0, z: -1 }, 2), false);

    // Потолок теперь можно положить в (0, 0, 0), так как есть несущая стена с сокетом ceiling_support
    assert.equal(world.canPlace('ceiling', { x: 0, y: 0, z: 0 }, 0), true);
    assert.ok(world.placePiece('ceiling', { x: 0, y: 0, z: 0 }, 0, 1));
    assert.equal(world.canPlace('ceiling', { x: 0, y: 0, z: 0 }, 0), false);

    // На 2-м ярусе (y = 1) теперь можно поставить стену с окном над северной стеной или на край потолка
    assert.equal(world.canPlace('window_wall', { x: 0, y: 1, z: 0 }, 0), true);
    assert.ok(world.placePiece('window_wall', { x: 0, y: 1, z: 0 }, 0, 2));

    // Лестницу можно поставить на фундамент (0, 0, 0)
    assert.equal(world.canPlace('staircase_railed', { x: 0, y: 0, z: 0 }, 0), true);
    assert.ok(world.placePiece('staircase_railed', { x: 0, y: 0, z: 0 }, 0, 1));
});

test('findBestSnap snaps ghost to nearest compatible socket and aligns wall rotation', () => {
    const world = new World(() => 0);
    world.placePiece('foundation', { x: 3, y: 0, z: 4 }, 0, 1);

    const centerX = 3 * CELL_SIZE;
    const centerZ = 4 * CELL_SIZE;

    // Прицеливаемся около восточного края фундамента (x + 1.35, z) с выбранным поворотом rot = 0.
    // findBestSnap должен найти восточный сокет 'found_wall_e' и автоматически повернуть стену в rot = 1.
    const snapEast = world.findBestSnap(
        'window_wall',
        { x: centerX + 1.3, y: 0.64, z: centerZ + 0.1 },
        0
    );
    assert.equal(snapEast.snappedToSocket, true);
    assert.equal(snapEast.validation.valid, true);
    assert.deepEqual(snapEast.cell, { x: 3, y: 0, z: 4 });
    assert.equal(snapEast.rot, 1);

    // Прицеливаемся далеко от построек со стеной — нет сокета, валидация false, привязка к сетке
    const snapFarWall = world.findBestSnap(
        'solid_wall',
        { x: 10 * CELL_SIZE + 0.2, y: 0, z: 10 * CELL_SIZE - 0.3 },
        0
    );
    assert.equal(snapFarWall.snappedToSocket, false);
    assert.equal(snapFarWall.validation.valid, false);
    assert.deepEqual(snapFarWall.cell, { x: 10, y: 0, z: 10 });
});

test('BuildingChunkRenderer builds one InstancedMesh per PieceType per chunk and rebuilds only dirty chunks', () => {
    const world = new World(() => 0);
    const renderer = new BuildingChunkRenderer(world, null, true);

    // Размещаем 2 фундамента и 3 глухие стены в чанке "0,0"
    world.placePiece('foundation', { x: 0, y: 0, z: 0 }, 0, 1);
    world.placePiece('foundation', { x: 1, y: 0, z: 0 }, 0, 1);
    world.placePiece('solid_wall', { x: 0, y: 0, z: 0 }, 0, 1);
    world.placePiece('solid_wall', { x: 0, y: 0, z: 0 }, 3, 1);
    world.placePiece('solid_wall', { x: 1, y: 0, z: 0 }, 0, 2);

    assert.deepEqual(world.getDirtyChunks(), ['0,0']);
    const rebuilt1 = renderer.syncDirtyChunks();
    assert.equal(rebuilt1, 1);
    assert.equal(renderer.getChunkCount(), 1);
    // 2 типа модулей (foundation и solid_wall) -> ровно 2 InstancedMesh
    assert.equal(renderer.getInstancedMeshCount(), 2);

    const meshes = renderer.getPickableMeshes();
    assert.equal(meshes.length, 2);
    const hit0 = renderer.resolveInstanceHit(meshes[0], 0);
    assert.ok(hit0);
    assert.equal(hit0.piece.type, 'foundation');

    // Размещаем фундамент в другом чанке (клетка x=10, z=0 -> чанк "1,0")
    world.placePiece('foundation', { x: 10, y: 0, z: 0 }, 0, 1);
    assert.deepEqual(world.getDirtyChunks(), ['1,0']);
    const rebuilt2 = renderer.syncDirtyChunks();
    assert.equal(rebuilt2, 1); // Пересобрался только 1 измененный чанк!
    assert.equal(renderer.getChunkCount(), 2);

    // Проверяем запеченные геометрии всех 7 префабов
    for (const type of PIECE_ORDER) {
        const asset = getBakedPrefabAsset(type, true);
        assert.ok(asset.geometry.getAttribute('position').count > 20);
        assert.ok(asset.materials.length >= 1);
    }

    renderer.dispose();
});

test('World enforces MAX_BUILD_DISTANCE and rejects placing blocks too far from builder position', () => {
    const world = new World(() => 0);
    // Устанавливаем позицию игрока в (0, 0, 0) с максимальной дистанцией строительства 12.0 м
    world.setBuilderPosition({ x: 0, y: 0, z: 0 }, 12.0);

    // Клетка (2, 0, 0) -> мировая позиция x = 6.4 м (<= 12.0 м) — размещение разрешено
    const nearVal = world.validatePlacement('foundation', { x: 2, y: 0, z: 0 }, 0);
    assert.equal(nearVal.valid, true);
    assert.ok(world.placePiece('foundation', { x: 2, y: 0, z: 0 }, 0, 1));

    // Клетка (5, 0, 0) -> мировая позиция x = 16.0 м (> 12.0 м) — слишком далеко!
    const farVal = world.validatePlacement('foundation', { x: 5, y: 0, z: 0 }, 0);
    assert.equal(farVal.valid, false);
    assert.equal(farVal.reason, 'too_far');
    assert.equal(world.canPlace('foundation', { x: 5, y: 0, z: 0 }, 0), false);
    assert.equal(world.placePiece('foundation', { x: 5, y: 0, z: 0 }, 0, 1), null);

    // findBestSnap на далекой точке (16.0, 0, 0) также возвращает reason === 'too_far' и distance > 12
    const farSnap = world.findBestSnap('foundation', { x: 16.0, y: 0, z: 0 }, 0);
    assert.equal(farSnap.validation.valid, false);
    assert.equal(farSnap.validation.reason, 'too_far');
    assert.ok(farSnap.distance > 12.0);
});

test('Functional doors: door_wall toggles open/closed, animates sliding leaf, and updates physics collider', async t => {
    const { createPhysicsWorld } = await import('../src/world/physics.ts');
    const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
    const physWorld = await createPhysicsWorld();
    t.after(() => physWorld.free());

    const world = new World(() => 0);
    const renderer = new BuildingChunkRenderer(world, physWorld, true);

    // 1. Размещаем фундамент и гермодверь (rot = 0 -> северная грань z = -1.6)
    world.placePiece('foundation', { x: 0, y: 0, z: 0 }, 0, 1);
    const door = world.placePiece('door_wall', { x: 0, y: 0, z: 0 }, 0, 1);
    assert.ok(door);
    assert.equal(door.isOpen, false);
    assert.equal(door.openProgress, 0);

    renderer.syncDirtyChunks();

    // Для чанка с фундаментом + дверью создаются:
    // 2 базовых InstancedMesh (foundation + рама door_wall) и 1 отдельный InstancedMesh для створки doorLeavesMesh
    assert.equal(renderer.getInstancedMeshCount(), 2);
    assert.equal(renderer.getPickableMeshes().length, 3);

    // Проверяем физический рейкаст сквозь центр дверного проема (x = 0, y = 1.6, z от -3.0 до +1.0):
    // Когда дверь закрыта (isOpen = false), луч упирается в коллайдер створки около z ≈ -1.6
    physWorld.step();
    const rayThroughDoorway = new RAPIER.Ray({ x: 0, y: 1.5, z: -3.0 }, { x: 0, y: 0, z: 1 });
    const hitClosed = physWorld.castRay(rayThroughDoorway, 5.0, true);
    assert.ok(hitClosed, 'Closed door leaf must block raycast through the doorway');
    assert.ok(hitClosed.toi < 2.0, `Expected hit near z=-1.6, got toi=${hitClosed.toi}`);

    // 2. Находим ближайшую дверь и открываем её через toggleDoorAt
    const foundDoor = world.findNearestDoor({ x: 0, y: 1.0, z: -1.2 }, 4.0);
    assert.ok(foundDoor);
    assert.equal(foundDoor.piece.id, door.id);

    const toggledOpen = world.toggleDoorAt({ x: 0, y: 0, z: 0 }, 0);
    assert.ok(toggledOpen);
    assert.equal(toggledOpen.isOpen, true);

    // 3. Прокручиваем анимацию открытия двери (updateDoors)
    for (let i = 0; i < 10; i++) {
        renderer.updateDoors(0.1);
    }
    assert.equal(door.openProgress, 1);

    // Проверяем, что проем теперь физически свободен для прохода (луч не задевает створку в проеме)
    physWorld.step();
    const hitOpen = physWorld.castRay(rayThroughDoorway, 5.0, true);
    assert.equal(hitOpen, null, 'Opened door must unblock the doorway for character passage');

    // Боковые стойки дверной коробки (x = -1.16) по-прежнему имеют физический коллайдер
    const raySideFrame = new RAPIER.Ray({ x: -1.16, y: 1.5, z: -3.0 }, { x: 0, y: 0, z: 1 });
    const hitFrame = physWorld.castRay(raySideFrame, 5.0, true);
    assert.ok(hitFrame, 'Door frame side pillar must remain solid when door is open');

    // 4. Закрываем дверь обратно
    const toggledClosed = world.toggleDoorAt({ x: 0, y: 0, z: 0 }, 0);
    assert.ok(toggledClosed);
    assert.equal(toggledClosed.isOpen, false);
    for (let i = 0; i < 10; i++) {
        renderer.updateDoors(0.1);
    }
    assert.equal(door.openProgress, 0);

    physWorld.step();
    const hitReclosed = physWorld.castRay(rayThroughDoorway, 5.0, true);
    assert.ok(hitReclosed, 'Re-closed door leaf must block doorway again');

    renderer.dispose();
});

test('Staircase can attach to foundation edge, sinking into foundation without modifying terrain', async t => {
    const { createPhysicsWorld } = await import('../src/world/physics.ts');
    const physWorld = await createPhysicsWorld();
    t.after(() => physWorld.free());

    let terrainSamples = 0;
    const terrainHeightFn = (wx: number, wz: number) => {
        terrainSamples++;
        return -1.2 + Math.sin(wx * 0.05) * 0.02 + Math.cos(wz * 0.05) * 0.02;
    };
    const world = new World(terrainHeightFn);
    const renderer = new BuildingChunkRenderer(world, physWorld, true);

    const beforeTerrainY = terrainHeightFn(0, CELL_SIZE);

    // 1. Ставим фундамент в (0, 0, 0)
    const found = world.placePiece('foundation', { x: 0, y: 0, z: 0 }, 0, 1);
    assert.ok(found);
    const baseY = found.baseY ?? 0;

    // 2. Прицеливаемся к южному краю фундамента (z = +1.6) — findBestSnap должен привязать лестницу к сокету 'found_stair_s'
    // в соседнюю клетку (0, 0, 1) с поворотом rot = 0 (подъем на Север к фундаменту) и утопить её в фундамент
    const snapSouth = world.findBestSnap(
        'staircase_railed',
        { x: 0, y: baseY + FOUND_HEIGHT * 0.5, z: CELL_SIZE * 0.5 + 0.15 },
        2
    );
    assert.equal(snapSouth.snappedToSocket, true);
    assert.equal(snapSouth.validation.valid, true);
    assert.equal(snapSouth.socket?.type, 'foundation_stair');
    assert.deepEqual(snapSouth.cell, { x: 0, y: 0, z: 1 });
    assert.equal(snapSouth.rot, 0);

    // Проверяем, что верх лестницы находится на уровне настила фундамента (baseY + FOUND_HEIGHT),
    // а сама лестница утоплена вниз и внутрь края фундамента
    assert.ok(
        Math.abs((snapSouth.worldPos.y + WALL_HEIGHT) - (baseY + FOUND_HEIGHT)) < 0.05,
        'Top of foundation-attached staircase must align with foundation deck'
    );
    assert.ok(
        snapSouth.worldPos.z < CELL_SIZE - 0.5,
        'Foundation-attached staircase must be recessed into the foundation edge'
    );

    const placedStair = world.placePiece('staircase_railed', snapSouth.cell, snapSouth.rot, 1, snapSouth.baseY);
    assert.ok(placedStair);
    assert.equal(placedStair.sunkInFoundation, true);

    // Террейн при установке утопленной лестницы не изменяется
    assert.equal(terrainHeightFn(0, CELL_SIZE), beforeTerrainY);
    assert.ok(terrainSamples > 0);

    // Утопленная входная лестница не создает сокетов 2-го этажа в воздухе
    assert.equal(world.getSocketsForPiece({ x: 0, y: 0, z: 1 }, placedStair).length, 0);

    // При этом на самом фундаменте (0, 0, 0) по-прежнему можно поставить обычную межэтажную лестницу
    const interiorStair = world.placePiece('staircase_open', { x: 0, y: 0, z: 0 }, 0, 1);
    assert.ok(interiorStair);
    assert.equal(Boolean(interiorStair.sunkInFoundation), false);

    renderer.syncDirtyChunks();
    renderer.dispose();
});

test('Cosmo steps off foundation onto ground smoothly without upward bounce or pelvis pop', async t => {
    const THREE = await import('three');
    const { createPhysicsWorld, RAPIER } = await import('../src/world/physics.ts');
    const { createGroundSampler } = await import('../src/world/groundSampler.ts');
    const { createPlayerController } = await import('../src/character/playerController.ts');
    const { createPlayerModel } = await import('../src/character/playerModel.ts');
    const { createPlayerActor } = await import('../src/character/playerActor.ts');

    const physWorld = await createPhysicsWorld();
    t.after(() => physWorld.free());

    // Плоский коллайдер грунта на y = 0
    const groundBody = physWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0),
        groundBody
    );

    const world = new World(() => 0);
    const renderer = new BuildingChunkRenderer(world, physWorld, true);
    world.placePiece('foundation', { x: 0, y: 0, z: 0 }, 0, 1);
    renderer.syncDirtyChunks();
    physWorld.step();

    const sampler = createGroundSampler({ world: physWorld });
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });
    const controller = createPlayerController({
        world: physWorld,
        groundAt: (x: number, z: number) => sampler.sample(x, z),
        speed: 2.8,
        spawnPosition: new THREE.Vector3(0, FOUND_HEIGHT, 0.2)
    });
    if (controller.rig?.body) {
        sampler.ignoreBody(controller.rig.body);
    }

    const actor = createPlayerActor({
        model,
        controller,
        groundAt: (x: number, z: number) => sampler.sample(x, z),
        worldStep: () => physWorld.step()
    });
    actor.syncVisuals();

    let prevRootY = actor.getPose().position.y;
    let maxUpwardStepRoot = 0;

    // Шагаем вперед (+Z) с настила фундамента (z = 0.2 .. 1.6) на землю (z > 1.6)
    const dt = 1 / 60;
    for (let step = 0; step < 90; step++) {
        const cmd = controller.update(dt, { actions: { forward: true } });
        actor.simulateStep(dt, cmd);
        physWorld.step();
        actor.syncVisuals(1.0);

        const curRootY = actor.getPose().position.y;
        const dy = curRootY - prevRootY;
        if (dy > maxUpwardStepRoot) {
            maxUpwardStepRoot = dy;
        }
        prevRootY = curRootY;
    }

    // Cosmo должен сойти на уровень земли (~0.0) без единого подскока вверх (> 3 мм)
    assert.ok(actor.getPose().position.z > 2.2, 'Cosmo must walk past the foundation edge');
    assert.ok(Math.abs(actor.getPose().position.y) < 0.06, 'Cosmo must settle on ground y=0');
    assert.ok(
        maxUpwardStepRoot <= 0.004,
        `Cosmo must not bounce upward when stepping off foundation (maxUpwardStepRoot=${maxUpwardStepRoot.toFixed(4)})`
    );

    renderer.dispose();
});

test('Cosmo walks straight through an opened door_wall without bouncing or teleporting upward', async t => {
    const THREE = await import('three');
    const { createPhysicsWorld, RAPIER } = await import('../src/world/physics.ts');
    const { createGroundSampler } = await import('../src/world/groundSampler.ts');
    const { createPlayerController } = await import('../src/character/playerController.ts');
    const { createPlayerModel } = await import('../src/character/playerModel.ts');
    const { createPlayerActor } = await import('../src/character/playerActor.ts');

    const physWorld = await createPhysicsWorld();
    t.after(() => physWorld.free());

    const groundBody = physWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0),
        groundBody
    );

    const world = new World(() => 0);
    const renderer = new BuildingChunkRenderer(world, physWorld, true);

    // Два смежных фундамента: (0, 0, 0) и (0, 0, -1), между ними door_wall на северной грани (rot = 0, z = -1.6)
    world.placePiece('foundation', { x: 0, y: 0, z: 0 }, 0, 1);
    world.placePiece('foundation', { x: 0, y: 0, z: -1 }, 0, 1);
    world.placePiece('door_wall', { x: 0, y: 0, z: 0 }, 0, 1);
    renderer.syncDirtyChunks();

    // Открываем дверь
    world.toggleDoorAt({ x: 0, y: 0, z: 0 }, 0);
    for (let i = 0; i < 10; i++) {
        renderer.updateDoors(0.1);
    }
    physWorld.step();

    const sampler = createGroundSampler({ world: physWorld });
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });
    const controller = createPlayerController({
        world: physWorld,
        groundAt: (x: number, z: number, refY?: number) => sampler.sample(x, z, refY),
        speed: 2.8,
        spawnPosition: new THREE.Vector3(0, FOUND_HEIGHT, 0.0)
    });
    if (controller.rig?.body) {
        sampler.ignoreBody(controller.rig.body);
    }

    const actor = createPlayerActor({
        model,
        controller,
        groundAt: (x: number, z: number, refY?: number) => sampler.sample(x, z, refY),
        worldStep: () => physWorld.step()
    });
    actor.syncVisuals();

    let maxY = actor.getPose().position.y;
    const dt = 1 / 60;
    // Двигаемся на Север (-Z) сквозь открытую дверь при z = -1.6
    for (let step = 0; step < 90; step++) {
        const cmd = controller.update(dt, {
            cameraAzimuth: Math.PI,
            actions: { forward: true }
        });
        actor.simulateStep(dt, cmd);
        physWorld.step();
        actor.syncVisuals(1.0);

        const curY = actor.getPose().position.y;
        if (curY > maxY) maxY = curY;
    }

    const finalPos = actor.getPose().position;
    assert.ok(
        finalPos.z < -2.4,
        `Cosmo must walk all the way through the open doorway (finalPos.z=${finalPos.z.toFixed(2)})`
    );
    assert.ok(
        maxY <= FOUND_HEIGHT + 0.08,
        `Cosmo must not bounce or teleport onto the door lintel (maxY=${maxY.toFixed(3)}, expected ~${FOUND_HEIGHT})`
    );

    renderer.dispose();
});

test('Cosmo climbs both a foundation-attached sunken staircase and an interior staircase smoothly', async t => {
    const THREE = await import('three');
    const { createPhysicsWorld, RAPIER } = await import('../src/world/physics.ts');
    const { createGroundSampler } = await import('../src/world/groundSampler.ts');
    const { createPlayerController } = await import('../src/character/playerController.ts');
    const { createPlayerModel } = await import('../src/character/playerModel.ts');
    const { createPlayerActor } = await import('../src/character/playerActor.ts');

    const physWorld = await createPhysicsWorld();
    t.after(() => physWorld.free());

    const groundBody = physWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0),
        groundBody
    );

    const world = new World(() => 0);
    const renderer = new BuildingChunkRenderer(world, physWorld, true);

    // 1. Фундамент в (0, 0, 0) и утопленная лестница с юга в (0, 0, 1) (rot = 0 -> подъем на Север -Z)
    world.placePiece('foundation', { x: 0, y: 0, z: 0 }, 0, 1);
    const snapStair = world.findBestSnap(
        'staircase_railed',
        { x: 0, y: FOUND_HEIGHT * 0.5, z: CELL_SIZE * 0.5 + 0.15 },
        0
    );
    assert.equal(snapStair.snappedToSocket, true);
    world.placePiece('staircase_railed', snapStair.cell, snapStair.rot, 1, snapStair.baseY);

    // 2. Второй фундамент в (0, 0, -1) с полноразмерной межэтажной лестницей на 2-й этаж (rot = 0 -> подъем на Север -Z)
    world.placePiece('foundation', { x: 0, y: 0, z: -1 }, 0, 1);
    world.placePiece('staircase_railed', { x: 0, y: 0, z: -1 }, 0, 1);

    renderer.syncDirtyChunks();
    physWorld.step();

    const sampler = createGroundSampler({ world: physWorld });
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });
    // Спавним Cosmo на земле (y = 0, z = +3.2) перед утопленной лестницей
    const controller = createPlayerController({
        world: physWorld,
        groundAt: (x: number, z: number, refY?: number) => sampler.sample(x, z, refY),
        speed: 2.8,
        spawnPosition: new THREE.Vector3(0, 0, 3.2)
    });
    if (controller.rig?.body) {
        sampler.ignoreBody(controller.rig.body);
    }

    const actor = createPlayerActor({
        model,
        controller,
        groundAt: (x: number, z: number, refY?: number) => sampler.sample(x, z, refY),
        worldStep: () => physWorld.step()
    });
    actor.syncVisuals();

    const dt = 1 / 60;
    // Этап 1: Поднимаемся с земли по утопленной лестнице на фундамент (0, 0, 0)
    for (let step = 0; step < 90; step++) {
        const cmd = controller.update(dt, {
            cameraAzimuth: Math.PI,
            actions: { forward: true }
        });
        actor.simulateStep(dt, cmd);
        physWorld.step();
        actor.syncVisuals(1.0);
    }

    const posOnFoundation = actor.getPose().position.clone();
    assert.ok(
        posOnFoundation.z < 1.2,
        `Cosmo must climb onto the foundation (z=${posOnFoundation.z.toFixed(2)})`
    );
    assert.ok(
        Math.abs(posOnFoundation.y - FOUND_HEIGHT) < 0.12,
        `Cosmo must reach foundation deck height ${FOUND_HEIGHT} (got y=${posOnFoundation.y.toFixed(3)})`
    );

    // Этап 2: Идем дальше на Север (-Z) и поднимаемся по межэтажной лестнице в (0, 0, -1) на 2-й этаж
    for (let step = 0; step < 150; step++) {
        const cmd = controller.update(dt, {
            cameraAzimuth: Math.PI,
            actions: { forward: true }
        });
        actor.simulateStep(dt, cmd);
        physWorld.step();
        actor.syncVisuals(1.0);
    }

    const posTopStair = actor.getPose().position.clone();
    assert.ok(
        posTopStair.y > FOUND_HEIGHT + WALL_HEIGHT - 0.25,
        `Cosmo must climb the interior staircase to the 2nd floor (~${(FOUND_HEIGHT + WALL_HEIGHT).toFixed(2)}m, got y=${posTopStair.y.toFixed(3)})`
    );

    renderer.dispose();
});




