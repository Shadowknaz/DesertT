// Реестр актеров: строгий контракт управляемой сущности, управление активным актером,
// циклический переключатель (по V/switchActor) и синхронизация контекста ввода.
import { CAMERA } from '../config.ts';
import type { CameraConfig } from '../control/cameraDirector.ts';
import type { InputRouter } from '../input/inputRouter.ts';
import type { IActor } from '../types/index.ts';

export interface ActorRegistration extends IActor {
    hintsKey?: string;
    cameraConfig?: Partial<CameraConfig>;
    onActivate?(): void;
    onDeactivate?(): void;
}

export type Actor = ActorRegistration;

export interface RegisteredActor extends ActorRegistration {
    cameraConfig: CameraConfig;
}

export interface ActorRegistryOptions {
    inputRouter?: InputRouter | null;
    onActorChange?: ((actor: RegisteredActor) => void) | null;
}

export interface ActorRegistry {
    registerActor(actorConfig: ActorRegistration): RegisteredActor;
    setActiveActor(id: string): RegisteredActor;
    cycleActor(): RegisteredActor | null;
    getActiveActor(): RegisteredActor | null;
    getActor(id: string): RegisteredActor | null;
    getAllActors(): RegisteredActor[];
    dispose(): void;
}

export function createActorRegistry({ inputRouter = null, onActorChange = null }: ActorRegistryOptions = {}): ActorRegistry {
    const actors = new Map<string, RegisteredActor>();
    const actorOrder: string[] = [];
    let activeActorId: string | null = null;
    let unsubAction: (() => void) | null = null;

    function validateActor(actor: any): asserts actor is ActorRegistration {
        if (!actor || typeof actor !== 'object') {
            throw new Error('Actor must be an object');
        }
        if (!actor.id || typeof actor.id !== 'string') {
            throw new Error('Actor must have a non-empty string "id"');
        }
        if (!actor.controller || typeof actor.controller.update !== 'function') {
            throw new Error(`Actor "${actor.id}" controller must have an "update(dt, ctx)" method`);
        }
        if (typeof actor.getPose !== 'function') {
            throw new Error(`Actor "${actor.id}" must provide a "getPose()" method`);
        }
        for (const hook of ['simulateStep', 'syncVisuals', 'updateWorld', 'getDebug']) {
            if (typeof actor[hook] !== 'function') {
                throw new Error(`Actor "${actor.id}" must provide an "${hook}()" method`);
            }
        }
    }

    function registerActor(actorConfig: ActorRegistration): RegisteredActor {
        validateActor(actorConfig);

        const actor: RegisteredActor = {
            ...actorConfig,
            id: actorConfig.id,
            contextId: actorConfig.contextId || actorConfig.id,
            hintsKey: actorConfig.hintsKey || actorConfig.contextId || actorConfig.id,
            controller: actorConfig.controller,
            getPose: actorConfig.getPose,
            cameraConfig: {
                focusHeight: actorConfig.cameraConfig?.focusHeight ?? CAMERA.focusHeight,
                followGain: actorConfig.cameraConfig?.followGain ?? CAMERA.followGain,
                groundClearance: actorConfig.cameraConfig?.groundClearance ?? CAMERA.groundClearance,
                minDistance: actorConfig.cameraConfig?.minDistance,
                maxDistance: actorConfig.cameraConfig?.maxDistance,
                defaultDistance: actorConfig.cameraConfig?.defaultDistance
            },
        };

        actors.set(actor.id, actor);
        if (!actorOrder.includes(actor.id)) {
            actorOrder.push(actor.id);
        }

        if (!activeActorId) {
            setActiveActor(actor.id);
        }
        return actor;
    }

    function setActiveActor(id: string): RegisteredActor {
        const actor = actors.get(id);
        if (!actor) {
            throw new Error(`Actor "${id}" is not registered`);
        }
        const previousActor = activeActorId ? actors.get(activeActorId) : null;
        if (previousActor && previousActor.id !== id && typeof previousActor.onDeactivate === 'function') {
            previousActor.onDeactivate();
        }

        activeActorId = id;

        if (inputRouter && actor.contextId) {
            inputRouter.setContext(actor.contextId);
        }

        if (typeof actor.onActivate === 'function') {
            actor.onActivate();
        }

        if (onActorChange) {
            onActorChange(actor);
        }
        return actor;
    }

    function cycleActor(): RegisteredActor | null {
        if (actorOrder.length <= 1) return getActiveActor();
        const currentIndex = actorOrder.indexOf(activeActorId!);
        const nextIndex = (currentIndex + 1) % actorOrder.length;
        return setActiveActor(actorOrder[nextIndex]);
    }

    function getActiveActor(): RegisteredActor | null {
        return activeActorId ? (actors.get(activeActorId) || null) : null;
    }

    function getActor(id: string): RegisteredActor | null {
        return actors.get(id) || null;
    }

    function getAllActors(): RegisteredActor[] {
        return Array.from(actors.values());
    }

    // Автоматическая подписка на переключение по глобальному действию switchActor (V)
    if (inputRouter && typeof inputRouter.onAction === 'function') {
        unsubAction = inputRouter.onAction(({ name, phase }) => {
            if (name === 'switchActor' && phase === 'down') {
                cycleActor();
            }
        });
    }

    function dispose(): void {
        if (unsubAction) {
            unsubAction();
            unsubAction = null;
        }
        for (const actor of actors.values()) {
            if (typeof actor.dispose === 'function') {
                actor.dispose();
            }
        }
        actors.clear();
        actorOrder.length = 0;
        activeActorId = null;
    }

    return {
        registerActor,
        setActiveActor,
        cycleActor,
        getActiveActor,
        getActor,
        getAllActors,
        dispose
    };
}
