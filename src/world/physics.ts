// Единственная точка входа в Rapier: инициализация WASM и создание мира,
// чтобы остальные модули не зависели от порядка загрузки бандла напрямую.
// Шаг мира фиксирован: его задаёт общий цикл симуляции, а не частота кадров.
import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS } from '../config.ts';

export async function createPhysicsWorld(): Promise<RAPIER.World> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0.0, y: PHYSICS.gravity, z: 0.0 });
    world.timestep = PHYSICS.fixedDt;
    return world;
}

export { RAPIER };

