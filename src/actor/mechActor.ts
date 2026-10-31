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

    let currentChunks: any = null;
    let currentSampler: any = null;
    const granulesEnv = {
        windX: 0,
        windZ: 0,
        sampleHeight: (x: number, z: number) => currentChunks.sandField.sampleHeight(x, z),
        sampleGround: (x: number, z: number) => currentSampler ? currentSampler.sample(x, z) : null,
        depositMass: (x: number, z: number, amount: number) => currentChunks.sandField.depositMass(x, z, amount),
        addReserve: (amount: number) => currentChunks.sandField.addReserve(amount)
    };
    const poseResult: any = {
        position: null,
        currentYaw: 0,
        flatFwd: null
    };

    return {
        id: 'mech',
        contextId: 'mech',
        hintsKey,
        controller,
        cameraConfig,
        getPose() {
            const state = locomotion.readBodyState();
            poseResult.position = state.bodyPos;
            poseResult.currentYaw = state.currentYaw;
            poseResult.flatFwd = state.flatFwd;
            return poseResult;
        },
        simulateStep,
        onDeactivate() {
            // Park the mech: lock translations/rotations on the dynamic body so Rapier keeps it in
            // the active solver island while preventing collapse or drift when Cosmo is active.
            if (controller && typeof controller.reset === 'function') {
                controller.reset();
            }
            if (rig && rig.body) {
                if (typeof rig.body.resetForces === 'function') rig.body.resetForces(true);
                if (typeof rig.body.resetTorques === 'function') rig.body.resetTorques(true);
                rig.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                rig.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
                if (typeof rig.body.lockTranslations === 'function' && typeof rig.body.lockRotations === 'function') {
                    rig.body.lockTranslations(true, true);
                    rig.body.lockRotations(true, true);
                } else if (typeof rig.body.setBodyType === 'function') {
                    rig.body.setBodyType(1, true);
                }
            }
        },
        onActivate() {
            // Unpark the mech: unlock translations/rotations and wake up the dynamic body
            if (controller && typeof controller.reset === 'function') {
                controller.reset();
            }
            if (rig && rig.body) {
                if (typeof rig.body.lockTranslations === 'function' && typeof rig.body.lockRotations === 'function') {
                    rig.body.lockTranslations(false, true);
                    rig.body.lockRotations(false, true);
                } else if (typeof rig.body.setBodyType === 'function') {
                    rig.body.setBodyType(0, true);
                }
                if (typeof rig.body.resetForces === 'function') rig.body.resetForces(true);
                if (typeof rig.body.resetTorques === 'function') rig.body.resetTorques(true);
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
                currentChunks = chunks;
                currentSampler = sampler;
                granulesEnv.windX = weatherState.windX;
                granulesEnv.windZ = weatherState.windZ;
                granules.update(frameDt, granulesEnv);
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

