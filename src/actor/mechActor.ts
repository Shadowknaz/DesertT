// Адаптер меха для общего actor pipeline.
// Здесь собраны только меховые pose/physics/visual hooks; маршрутизация ввода
// и главный цикл приложения остаются независимыми от конкретного типа актёра.
import type { Actor } from './actorRegistry.ts';
import type { MechRig } from '../mech/mechRig.ts';
import type { LocomotionController } from '../mech/locomotion.ts';
import type { LegContacts } from '../mech/legContacts.ts';
import type { DustSystem } from '../world/dustParticles.ts';
import type { SandGranules } from '../world/sandGranules.ts';

export interface MechActorOptions {
    controller: any;
    rig: MechRig;
    locomotion: LocomotionController;
    contacts?: LegContacts | null;
    dust?: DustSystem | null;
    granules?: SandGranules | null;
    simulateStep: (dt?: number, command?: any, weatherState?: any) => any;
    cameraConfig?: any;
    hintsKey?: string;
}

export function createMechActor({
    controller,
    rig,
    locomotion,
    contacts,
    dust,
    granules,
    simulateStep,
    cameraConfig,
    hintsKey = 'mech'
}: MechActorOptions): Actor {
    if (!controller || typeof controller.update !== 'function') {
        throw new Error('Mech actor requires a controller');
    }
    if (!locomotion || typeof locomotion.readBodyState !== 'function') {
        throw new Error('Mech actor requires locomotion.readBodyState()');
    }
    if (typeof simulateStep !== 'function') {
        throw new Error('Mech actor requires simulateStep()');
    }

    return {
        id: 'mech',
        contextId: 'mech',
        hintsKey,
        controller,
        cameraConfig,
        getPose() {
            const state = locomotion.readBodyState();
            return {
                position: state.bodyPos,
                currentYaw: state.currentYaw,
                flatFwd: state.flatFwd
            };
        },
        simulateStep,
        onDeactivate() {
            // Park the mech: lock rigid body so physics does not collapse or explode it while inactive
            if (rig && rig.body) {
                rig.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                rig.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
                if (typeof rig.body.setBodyType === 'function') {
                    rig.body.setBodyType(1, true); // 1 = Fixed in Rapier
                }
            }
        },
        onActivate() {
            // Unpark the mech: restore dynamic physics simulation
            if (rig && rig.body) {
                if (typeof rig.body.setBodyType === 'function') {
                    rig.body.setBodyType(0, true); // 0 = Dynamic in Rapier
                }
                rig.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                rig.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
                if (typeof rig.body.wakeUp === 'function') {
                    rig.body.wakeUp(true);
                }
            }
        },
        syncVisuals() {
            if (rig && typeof rig.syncVisuals === 'function') {
                rig.syncVisuals();
            }
        },
        updateWorld({ motion, frameDt, weatherState, chunks, sampler }: any) {
            if (dust && typeof dust.updateAmbient === 'function') {
                dust.updateAmbient(motion.bodyPos, frameDt, weatherState);
            }
            if (granules && typeof granules.update === 'function') {
                granules.update(frameDt, {
                    windX: weatherState.windX,
                    windZ: weatherState.windZ,
                    sampleHeight: (x: number, z: number) => chunks.sandField.sampleHeight(x, z),
                    sampleGround: (x: number, z: number) => sampler ? sampler.sample(x, z) : null,
                    depositMass: (x: number, z: number, amount: number) => chunks.sandField.depositMass(x, z, amount),
                    addReserve: (amount: number) => chunks.sandField.addReserve(amount)
                });
            }
            if (rig && typeof rig.setDustCoat === 'function') {
                rig.setDustCoat(weatherState.coat);
            }
        },
        getDebug({ lastSupport = null, physicsTiming = null }: any = {}) {
            return {
                legs: rig?.legs || [],
                loop: locomotion.getDebug ? locomotion.getDebug() : {},
                contact: contacts?.getDebug ? contacts.getDebug() : {},
                support: lastSupport,
                physicsTiming
            };
        }
    };
}

