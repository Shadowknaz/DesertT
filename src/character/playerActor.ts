import * as THREE from 'three';
import { COSMO } from '../config.ts';
import type { PlayerModel } from './playerModel.ts';
import type { PlayerController, GroundQuery, PlayerVisualState } from './playerController.ts';
import type { SandField } from '../world/sandField.ts';
import type { GroundSamplerResult } from '../world/groundSampler.ts';
import type { ActorRegistration } from '../actor/actorRegistry.ts';

const _ejectVel = new THREE.Vector3();

export interface PlayerActorOptions {
    model: PlayerModel;
    controller: PlayerController;
    dust?: any;
    granules?: any;
    sandField?: SandField | null;
    syncSand?: ((x: number, z: number, radius: number) => void) | null;
    worldStep?: (() => void) | null;
    cameraConfig?: any;
    hintsKey?: string;
    groundAt?: GroundQuery;
}

export interface PlayerActor extends ActorRegistration {
    controller: PlayerController;
    model: PlayerModel;
    cameraConfig?: any;
    getVisualPose: (alpha?: number) => any;
    dispose: () => void;
}

export function createPlayerActor({
    model,
    controller,
    dust,
    granules = null,
    sandField = null,
    syncSand = null,
    worldStep = null,
    cameraConfig,
    hintsKey = 'cosmo',
    groundAt = null
}: PlayerActorOptions): PlayerActor {
    if (!model || !model.pose || typeof model.update !== 'function') {
        throw new Error('Player actor requires a player model');
    }

    let smoothCrouch = 0;
    let prevLeftLift = 0;
    let prevRightLift = 0;
    let prevGrounded = true;
    let boundSandField: any = sandField;

    const footprintRadius: number = COSMO.footprintRadius ?? 0.16;
    const footprintDepth: number = COSMO.footprintDepth ?? 0.035;
    const footWidth: number = COSMO.footWidth ?? 0.14;
    const footLength: number = COSMO.footLength ?? 0.24;

    function stampFoot(foot: any, depth: number = footprintDepth, compaction: number = 0.12, yaw: number = 0) {
        if (foot.surfaceType === 'solid') return;
        if (!boundSandField) return;

        if (typeof boundSandField.stampSole === 'function') {
            boundSandField.stampSole(
                foot.position.x,
                foot.position.z,
                footWidth,
                footLength,
                yaw + (foot.yawOffset || 0),
                foot.pitch || 0,
                foot.roll || 0,
                depth,
                compaction
            );
        } else if (typeof boundSandField.stampCrater === 'function') {
            boundSandField.stampCrater(
                foot.position.x,
                foot.position.z,
                footprintRadius,
                depth,
                compaction
            );
        }
        if (typeof syncSand === 'function') {
            syncSand(foot.position.x, foot.position.z, footprintRadius * 1.5);
        }
    }

    return {
        id: 'cosmo',
        contextId: 'cosmo',
        hintsKey,
        controller,
        model,
        cameraConfig,
        getPose: () => controller.getPose(),
        getVisualPose: (alpha = 1.0) => (typeof controller.getVisualPose === 'function'
            ? controller.getVisualPose(alpha)
            : controller.getPose()),
        simulateStep(dt: number, command: any, weatherState: any) {
            const result = controller.simulateStep(dt, command, weatherState);
            if (worldStep) worldStep();
            return result;
        },
        syncVisuals(alpha = 1.0) {
            const state: PlayerVisualState = typeof controller.getState === 'function'
                ? controller.getState(alpha)
                : {
                    position: controller.getPose().position,
                    yaw: controller.getPose().currentYaw,
                    crouch: 0,
                    walkPhase: 0,
                    walkAmount: 0,
                    moveX: 0,
                    moveZ: 0,
                    bankingRoll: 0,
                    isSliding: false,
                    slideSpeed: 0,
                    isSprinting: false,
                    grounded: true,
                    slopeAngle: 0
                };
            model.pose.rootPosition.copy(state.position);
            model.pose.rootYaw = state.yaw;

            // Плавное приседание корпуса (-0.24м) с естественным сгибанием коленей через IK
            smoothCrouch += ((state.crouch || 0) - smoothCrouch) * 0.25;
            model.pose.pelvisOffset.y = -0.24 * smoothCrouch;

            if (typeof model.setLocomotion === 'function') {
                model.setLocomotion({
                    phase: state.walkPhase,
                    amount: state.walkAmount,
                    moveX: state.moveX,
                    moveZ: state.moveZ,
                    bankingRoll: state.bankingRoll || 0,
                    isSliding: state.isSliding,
                    slideSpeed: state.slideSpeed,
                    isSprinting: state.isSprinting
                });
            }

            // IK targets are world-space points. Rebuild the stance after every
            // move so the legs do not remain anchored at the spawn position.
            model.resetTargetsToStance();
            const lf = model.ikTargets.leftFoot;
            const rf = model.ikTargets.rightFoot;

            if (typeof groundAt === 'function') {
                const leftSample = groundAt(lf.position.x, lf.position.z);
                const rightSample = groundAt(rf.position.x, rf.position.z);

                if (typeof leftSample === 'number') {
                    lf.position.y = leftSample;
                    lf.surfaceType = 'sand';
                } else if (leftSample && typeof leftSample.y === 'number') {
                    lf.position.y = leftSample.y;
                    lf.normal = leftSample.normal || null;
                    lf.surfaceType = leftSample.surfaceType || 'sand';
                } else {
                    lf.position.y = state.position.y;
                    lf.surfaceType = 'sand';
                }

                if (typeof rightSample === 'number') {
                    rf.position.y = rightSample;
                    rf.surfaceType = 'sand';
                } else if (rightSample && typeof rightSample.y === 'number') {
                    rf.position.y = rightSample.y;
                    rf.normal = rightSample.normal || null;
                    rf.surfaceType = rightSample.surfaceType || 'sand';
                } else {
                    rf.position.y = state.position.y;
                    rf.surfaceType = 'sand';
                }
            } else {
                lf.position.y = state.position.y;
                lf.surfaceType = 'sand';
                rf.position.y = state.position.y;
                rf.surfaceType = 'sand';
            }

            // Передаем groundAt в model.update() для точного сэмплирования рельефа
            // на фактическом шаге (stride), исключая проваливание и зависание стоп
            model.update(groundAt);

            // Обработка приземления после прыжка / падения
            const curGrounded = state.grounded !== false;
            if (!prevGrounded && curGrounded) {
                if (lf.surfaceType !== 'solid') {
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(lf.position, 3, 0.45);
                        dust.spawnSplash(rf.position, 3, 0.45);
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        granules.spawnFootEjection(lf.position, new THREE.Vector3(0, 0.5, 0), 4, 0.4, (x: number, z: number, a: number) => boundSandField.withdrawMass(x, z, a));
                        granules.spawnFootEjection(rf.position, new THREE.Vector3(0, 0.5, 0), 4, 0.4, (x: number, z: number, a: number) => boundSandField.withdrawMass(x, z, a));
                    }
                    stampFoot(lf, footprintDepth * 1.3, 0.16, state.yaw);
                    stampFoot(rf, footprintDepth * 1.3, 0.16, state.yaw);
                }
            }
            prevGrounded = curGrounded;

            // Клубы песчаной пыли и отпечатки стоп на песке при касании земли на бегу
            if (state.walkAmount > 0.15) {
                const curLeftLift = lf.contactWeight < 0.9 ? 1 : 0;
                const curRightLift = rf.contactWeight < 0.9 ? 1 : 0;
                const isSprinting = Boolean(state.isSprinting);

                // Касание левой стопой
                if (prevLeftLift > 0 && curLeftLift === 0) {
                    if (lf.surfaceType !== 'solid') {
                        if (dust && typeof dust.spawnSplash === 'function') {
                            dust.spawnSplash(lf.position, isSprinting ? 4 : 2, isSprinting ? 0.55 : 0.35);
                        }
                        if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                            const ejectMult = isSprinting ? 2.2 : 1.5;
                            _ejectVel.set(-Math.sin(state.yaw) * ejectMult, 0.4, -Math.cos(state.yaw) * ejectMult);
                            granules.spawnFootEjection(
                                lf.position,
                                _ejectVel,
                                isSprinting ? 6 : 4,
                                isSprinting ? 0.5 : 0.35,
                                (x: number, z: number, a: number) => boundSandField.withdrawMass(x, z, a)
                            );
                        }
                        const curDepth = isSprinting ? footprintDepth * 1.35 : footprintDepth;
                        stampFoot(lf, curDepth, isSprinting ? 0.16 : 0.12, state.yaw);
                    }
                }

                // Касание правой стопой
                if (prevRightLift > 0 && curRightLift === 0) {
                    if (rf.surfaceType !== 'solid') {
                        if (dust && typeof dust.spawnSplash === 'function') {
                            dust.spawnSplash(rf.position, isSprinting ? 4 : 2, isSprinting ? 0.55 : 0.35);
                        }
                        if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                            const ejectMult = isSprinting ? 2.2 : 1.5;
                            _ejectVel.set(-Math.sin(state.yaw) * ejectMult, 0.4, -Math.cos(state.yaw) * ejectMult);
                            granules.spawnFootEjection(
                                rf.position,
                                _ejectVel,
                                isSprinting ? 6 : 4,
                                isSprinting ? 0.5 : 0.35,
                                (x: number, z: number, a: number) => boundSandField.withdrawMass(x, z, a)
                            );
                        }
                        const curDepth = isSprinting ? footprintDepth * 1.35 : footprintDepth;
                        stampFoot(rf, curDepth, isSprinting ? 0.16 : 0.12, state.yaw);
                    }
                }

                prevLeftLift = curLeftLift;
                prevRightLift = curRightLift;
            } else if (state.isSliding) {
                // === ЭФФЕКТЫ ПЕСЧАНОГО СЕРФИНГА ===
                // Непрерывный шлейф песчаной поземки из-под подошв
                if (dust && typeof dust.spawnSplash === 'function') {
                    dust.spawnSplash(lf.position, 1, 0.20);
                    dust.spawnSplash(rf.position, 1, 0.20);
                }
                if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                    _ejectVel.set(-Math.sin(state.yaw) * 2.2, 0.5, -Math.cos(state.yaw) * 2.2);
                    granules.spawnFootEjection(
                        lf.position,
                        _ejectVel,
                        2,
                        0.25,
                        (x: number, z: number, a: number) => boundSandField.withdrawMass(x, z, a)
                    );
                    granules.spawnFootEjection(
                        rf.position,
                        _ejectVel,
                        2,
                        0.25,
                        (x: number, z: number, a: number) => boundSandField.withdrawMass(x, z, a)
                    );
                }
                // Непрерывная борозда в песке под скользящими стопами
                stampFoot(lf, 0.022, 0.10, state.yaw);
                stampFoot(rf, 0.022, 0.10, state.yaw);

                prevLeftLift = 0;
                prevRightLift = 0;
            } else {
                prevLeftLift = 0;
                prevRightLift = 0;
            }
        },
        updateWorld({ motion, frameDt, weatherState, chunks, sampler }: any) {
            if (!boundSandField && chunks?.sandField) {
                boundSandField = chunks.sandField;
            }
            if (!syncSand && chunks?.syncSandAt) {
                syncSand = chunks.syncSandAt;
            }
            if (dust && typeof dust.updateAmbient === 'function') {
                dust.updateAmbient(motion.bodyPos, frameDt, weatherState);
            }
            if (granules && typeof granules.update === 'function' && chunks?.sandField) {
                granules.update(frameDt, {
                    windX: weatherState.windX,
                    windZ: weatherState.windZ,
                    sampleHeight: (x: number, z: number) => chunks.sandField.sampleHeight(x, z),
                    sampleGround: (x: number, z: number) => (sampler ? sampler.sample(x, z) : null),
                    depositMass: (x: number, z: number, amount: number) => chunks.sandField.depositMass(x, z, amount),
                    addReserve: (amount: number) => chunks.sandField.addReserve(amount)
                });
            }
        },
        getDebug() {
            return controller.getDebug();
        },
        dispose() {
            if (model?.dispose) model.dispose();
            if (controller?.dispose) controller.dispose();
        }
    };
}
