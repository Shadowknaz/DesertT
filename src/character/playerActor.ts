import * as THREE from 'three';
import { COSMO } from '../config.ts';
import type { PlayerModel } from './playerModel.ts';
import type {
    CosmoContactEvent,
    GroundQuery,
    PlayerController,
    PlayerVisualState
} from './playerController.ts';
import type { SandField } from '../world/sandField.ts';
import {
    createDefaultGroundSample,
    resolveGroundSample,
    type GroundSample
} from '../world/groundSampler.ts';
import type { ActorRegistration } from '../actor/actorRegistry.ts';

const _ejectVel = new THREE.Vector3();
const _landingEjectVel = new THREE.Vector3(0, 0.5, 0);

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
    let currentChunks: any = null;
    let currentSampler: any = null;

    const leftSampleScratch = createDefaultGroundSample();
    const rightSampleScratch = createDefaultGroundSample();
    const eventSampleScratch = createDefaultGroundSample();

    const withdrawMassFn = (x: number, z: number, a: number) => boundSandField.withdrawMass(x, z, a);
    const granulesEnv = {
        windX: 0,
        windZ: 0,
        sampleHeight: (x: number, z: number) => currentChunks.sandField.sampleHeight(x, z),
        sampleGround: (x: number, z: number) => (currentSampler ? currentSampler.sample(x, z) : null),
        depositMass: (x: number, z: number, amount: number) => currentChunks.sandField.depositMass(x, z, amount),
        addReserve: (amount: number) => currentChunks.sandField.addReserve(amount)
    };
    const locomotionInput = {
        phase: 0,
        amount: 0,
        moveX: 0,
        moveZ: 0,
        bankingRoll: 0,
        isSliding: false,
        slideSpeed: 0,
        isSprinting: false,
        slopeAngle: 0,
        uphillAngle: 0,
        downhillAngle: 0,
        crossSlopeAngle: 0,
        forwardAccel: 0,
        grounded: true
    };

    const footprintRadius: number = COSMO.footprintRadius ?? 0.16;
    const footprintDepth: number = COSMO.footprintDepth ?? 0.035;
    const footWidth: number = COSMO.footWidth ?? 0.14;
    const footLength: number = COSMO.footLength ?? 0.24;
    const baseWeightForce: number = (COSMO.mass ?? 85.0) * Math.abs(COSMO.gravity ?? -18.0);

    function isSolidSurface(surfaceType?: string, materialId?: string): boolean {
        return surfaceType === 'solid' || materialId === 'stone' || materialId === 'bedrock';
    }

    function computeFootprintResponse(
        baseDepth: number,
        baseCompaction: number,
        normalLoad: number,
        speedVal: number,
        sample: GroundSample
    ): { depth: number; compaction: number } {
        const loadRatio = normalLoad > 0 ? THREE.MathUtils.clamp(normalLoad / baseWeightForce, 0.6, 2.2) : 1.0;
        const speedBonus = 1.0 + THREE.MathUtils.clamp(speedVal / 6.0, 0, 0.35);
        const packingResistance = 1.0 - 0.45 * THREE.MathUtils.clamp(sample.packing || 0, 0, 1);
        const sinkSaturation = 1.0 / (1.0 + (sample.sink || 0) * 3.0);
        const depth = baseDepth * loadRatio * speedBonus * packingResistance * sinkSaturation;
        const compaction = THREE.MathUtils.clamp(
            baseCompaction * loadRatio * (1.0 - 0.3 * (sample.packing || 0)),
            0.04,
            0.35
        );
        return { depth, compaction };
    }

    function stampFoot(
        foot: any,
        depth: number = footprintDepth,
        compaction: number = 0.12,
        yaw: number = 0,
        overrideSample?: GroundSample
    ) {
        const surfaceType = overrideSample?.surfaceType ?? foot.surfaceType;
        const materialId = overrideSample?.materialId ?? foot.materialId;
        if (isSolidSurface(surfaceType, materialId)) return;
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

    function resolveEventGround(x: number, z: number, fallbackSample: GroundSample): GroundSample {
        if (typeof groundAt === 'function') {
            return resolveGroundSample(groundAt, x, z, eventSampleScratch, true);
        }
        return fallbackSample;
    }

    function processSimulationEvents(events: CosmoContactEvent[], state: PlayerVisualState, lf: any, rf: any) {
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            if (ev.type === 'landing') {
                const lSample = resolveEventGround(lf.position.x, lf.position.z, ev.leftGround || ev.ground);
                const rSample = resolveEventGround(rf.position.x, rf.position.z, ev.rightGround || ev.ground);

                if (!isSolidSurface(lSample.surfaceType, lSample.materialId)) {
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(lf.position, 4, 0.34);
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        granules.spawnFootEjection(lf.position, _landingEjectVel, 6, 0.34, withdrawMassFn);
                    }
                    const lResp = computeFootprintResponse(
                        footprintDepth * 1.3,
                        0.16,
                        ev.normalLoad,
                        ev.impactSpeed,
                        lSample
                    );
                    stampFoot(lf, lResp.depth, lResp.compaction, state.yaw, lSample);
                }

                if (!isSolidSurface(rSample.surfaceType, rSample.materialId)) {
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(rf.position, 4, 0.34);
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        granules.spawnFootEjection(rf.position, _landingEjectVel, 6, 0.34, withdrawMassFn);
                    }
                    const rResp = computeFootprintResponse(
                        footprintDepth * 1.3,
                        0.16,
                        ev.normalLoad,
                        ev.impactSpeed,
                        rSample
                    );
                    stampFoot(rf, rResp.depth, rResp.compaction, state.yaw, rSample);
                }
            } else if (ev.type === 'left_touchdown') {
                const lSample = resolveEventGround(lf.position.x, lf.position.z, ev.ground);
                if (!isSolidSurface(lSample.surfaceType, lSample.materialId)) {
                    const isSprint = ev.isSprinting || Boolean(state.isSprinting);
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(lf.position, isSprint ? 5 : 3, isSprint ? 0.38 : 0.26);
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        const ejectMult = isSprint ? 2.0 : 1.35;
                        _ejectVel.set(-Math.sin(state.yaw) * ejectMult, 0.35, -Math.cos(state.yaw) * ejectMult);
                        granules.spawnFootEjection(
                            lf.position,
                            _ejectVel,
                            isSprint ? 8 : 5,
                            isSprint ? 0.40 : 0.28,
                            withdrawMassFn
                        );
                    }
                    const baseD = isSprint ? footprintDepth * 1.35 : footprintDepth;
                    const baseC = isSprint ? 0.16 : 0.12;
                    const resp = computeFootprintResponse(baseD, baseC, ev.normalLoad, ev.speed, lSample);
                    stampFoot(lf, resp.depth, resp.compaction, state.yaw, lSample);
                }
            } else if (ev.type === 'right_touchdown') {
                const rSample = resolveEventGround(rf.position.x, rf.position.z, ev.ground);
                if (!isSolidSurface(rSample.surfaceType, rSample.materialId)) {
                    const isSprint = ev.isSprinting || Boolean(state.isSprinting);
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(rf.position, isSprint ? 5 : 3, isSprint ? 0.38 : 0.26);
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        const ejectMult = isSprint ? 2.0 : 1.35;
                        _ejectVel.set(-Math.sin(state.yaw) * ejectMult, 0.35, -Math.cos(state.yaw) * ejectMult);
                        granules.spawnFootEjection(
                            rf.position,
                            _ejectVel,
                            isSprint ? 8 : 5,
                            isSprint ? 0.40 : 0.28,
                            withdrawMassFn
                        );
                    }
                    const baseD = isSprint ? footprintDepth * 1.35 : footprintDepth;
                    const baseC = isSprint ? 0.16 : 0.12;
                    const resp = computeFootprintResponse(baseD, baseC, ev.normalLoad, ev.speed, rSample);
                    stampFoot(rf, resp.depth, resp.compaction, state.yaw, rSample);
                }
            } else if (ev.type === 'slide') {
                const lSample = resolveEventGround(lf.position.x, lf.position.z, ev.leftGround || ev.ground);
                const rSample = resolveEventGround(rf.position.x, rf.position.z, ev.rightGround || ev.ground);
                if (!isSolidSurface(lSample.surfaceType, lSample.materialId)) {
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(lf.position, 2, 0.20);
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        _ejectVel.set(-Math.sin(state.yaw) * 2.0, 0.4, -Math.cos(state.yaw) * 2.0);
                        granules.spawnFootEjection(lf.position, _ejectVel, 3, 0.24, withdrawMassFn);
                    }
                    stampFoot(lf, 0.022, 0.10, state.yaw, lSample);
                }
                if (!isSolidSurface(rSample.surfaceType, rSample.materialId)) {
                    if (dust && typeof dust.spawnSplash === 'function') {
                        dust.spawnSplash(rf.position, 2, 0.20);
                    }
                    if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                        _ejectVel.set(-Math.sin(state.yaw) * 2.0, 0.4, -Math.cos(state.yaw) * 2.0);
                        granules.spawnFootEjection(rf.position, _ejectVel, 3, 0.24, withdrawMassFn);
                    }
                    stampFoot(rf, 0.022, 0.10, state.yaw, rSample);
                }
            }
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
            if (typeof (model as any).isSeated === 'function' && (model as any).isSeated()) {
                return;
            }
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
                locomotionInput.phase = state.walkPhase;
                locomotionInput.amount = state.walkAmount;
                locomotionInput.moveX = state.moveX;
                locomotionInput.moveZ = state.moveZ;
                locomotionInput.bankingRoll = state.bankingRoll || 0;
                locomotionInput.isSliding = state.isSliding;
                locomotionInput.slideSpeed = state.slideSpeed;
                locomotionInput.isSprinting = state.isSprinting;
                locomotionInput.slopeAngle = state.slopeAngle || 0;
                locomotionInput.uphillAngle = state.uphillAngle || 0;
                locomotionInput.downhillAngle = state.downhillAngle || 0;
                locomotionInput.crossSlopeAngle = state.crossSlopeAngle || 0;
                locomotionInput.forwardAccel = state.forwardAccel || 0;
                locomotionInput.grounded = state.grounded !== false;
                model.setLocomotion(locomotionInput);
            }

            // IK targets are world-space points. Rebuild the stance after every
            // move so the legs do not remain anchored at the spawn position.
            model.resetTargetsToStance();
            const lf = model.ikTargets.leftFoot;
            const rf = model.ikTargets.rightFoot;

            if (typeof groundAt === 'function') {
                const rawLeft = groundAt(lf.position.x, lf.position.z);
                const rawRight = groundAt(rf.position.x, rf.position.z);
                resolveGroundSample(groundAt, lf.position.x, lf.position.z, leftSampleScratch, true);
                resolveGroundSample(groundAt, rf.position.x, rf.position.z, rightSampleScratch, true);

                lf.position.y = (rawLeft !== null && rawLeft !== undefined) ? leftSampleScratch.y : state.position.y;
                lf.normal = (rawLeft && typeof rawLeft === 'object' && rawLeft.normal) ? rawLeft.normal : null;
                lf.surfaceType = leftSampleScratch.surfaceType;
                lf.materialId = leftSampleScratch.materialId;
                lf.packing = leftSampleScratch.packing;
                lf.sink = leftSampleScratch.sink;

                rf.position.y = (rawRight !== null && rawRight !== undefined) ? rightSampleScratch.y : state.position.y;
                rf.normal = (rawRight && typeof rawRight === 'object' && rawRight.normal) ? rawRight.normal : null;
                rf.surfaceType = rightSampleScratch.surfaceType;
                rf.materialId = rightSampleScratch.materialId;
                rf.packing = rightSampleScratch.packing;
                rf.sink = rightSampleScratch.sink;
            } else {
                lf.position.y = state.position.y;
                lf.surfaceType = 'sand';
                rf.position.y = state.position.y;
                rf.surfaceType = 'sand';
            }

            // Передаем groundAt в model.update() для точного сэмплирования рельефа
            // на фактическом шаге (stride), исключая проваливание и зависание стоп
            model.update(groundAt);

            if (typeof model.getModelDebug === 'function' && typeof controller.setModelDebug === 'function') {
                controller.setModelDebug(model.getModelDebug());
            }

            // === Обработка эффектов контакта с поверхностью ===
            // Если контроллер поддерживает буфер симуляционных событий (consumeContactEvents),
            // эффекты срабатывают строго по событиям симуляции и никогда не дублируются при повторных syncVisuals(alpha).
            if (typeof controller.consumeContactEvents === 'function') {
                const simEvents = controller.consumeContactEvents();
                if (simEvents.length > 0) {
                    processSimulationEvents(simEvents, state, lf, rf);
                }
                prevGrounded = state.grounded !== false;
                prevLeftLift = lf.contactWeight < 0.9 ? 1 : 0;
                prevRightLift = rf.contactWeight < 0.9 ? 1 : 0;
            } else {
                // Резервный путь для легковесных unit-тестов с мок-контроллером без simulateStep
                const curGrounded = state.grounded !== false;
                if (!prevGrounded && curGrounded) {
                    if (!isSolidSurface(lf.surfaceType, lf.materialId)) {
                        if (dust && typeof dust.spawnSplash === 'function') {
                            dust.spawnSplash(lf.position, 4, 0.34);
                            dust.spawnSplash(rf.position, 4, 0.34);
                        }
                        if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                            granules.spawnFootEjection(lf.position, _landingEjectVel, 6, 0.34, withdrawMassFn);
                            granules.spawnFootEjection(rf.position, _landingEjectVel, 6, 0.34, withdrawMassFn);
                        }
                        stampFoot(lf, footprintDepth * 1.3, 0.16, state.yaw);
                        stampFoot(rf, footprintDepth * 1.3, 0.16, state.yaw);
                    }
                }
                prevGrounded = curGrounded;

                if (state.walkAmount > 0.15) {
                    const curLeftLift = lf.contactWeight < 0.9 ? 1 : 0;
                    const curRightLift = rf.contactWeight < 0.9 ? 1 : 0;
                    const isSprinting = Boolean(state.isSprinting);

                    if (prevLeftLift > 0 && curLeftLift === 0) {
                        if (!isSolidSurface(lf.surfaceType, lf.materialId)) {
                            if (dust && typeof dust.spawnSplash === 'function') {
                                dust.spawnSplash(lf.position, isSprinting ? 5 : 3, isSprinting ? 0.38 : 0.26);
                            }
                            if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                                const ejectMult = isSprinting ? 2.0 : 1.35;
                                _ejectVel.set(-Math.sin(state.yaw) * ejectMult, 0.35, -Math.cos(state.yaw) * ejectMult);
                                granules.spawnFootEjection(
                                    lf.position,
                                    _ejectVel,
                                    isSprinting ? 8 : 5,
                                    isSprinting ? 0.40 : 0.28,
                                    withdrawMassFn
                                );
                            }
                            const curDepth = isSprinting ? footprintDepth * 1.35 : footprintDepth;
                            stampFoot(lf, curDepth, isSprinting ? 0.16 : 0.12, state.yaw);
                        }
                    }

                    if (prevRightLift > 0 && curRightLift === 0) {
                        if (!isSolidSurface(rf.surfaceType, rf.materialId)) {
                            if (dust && typeof dust.spawnSplash === 'function') {
                                dust.spawnSplash(rf.position, isSprinting ? 5 : 3, isSprinting ? 0.38 : 0.26);
                            }
                            if (granules && typeof granules.spawnFootEjection === 'function' && boundSandField) {
                                const ejectMult = isSprinting ? 2.0 : 1.35;
                                _ejectVel.set(-Math.sin(state.yaw) * ejectMult, 0.35, -Math.cos(state.yaw) * ejectMult);
                                granules.spawnFootEjection(
                                    rf.position,
                                    _ejectVel,
                                    isSprinting ? 8 : 5,
                                    isSprinting ? 0.40 : 0.28,
                                    withdrawMassFn
                                );
                            }
                            const curDepth = isSprinting ? footprintDepth * 1.35 : footprintDepth;
                            stampFoot(rf, curDepth, isSprinting ? 0.16 : 0.12, state.yaw);
                        }
                    }

                    prevLeftLift = curLeftLift;
                    prevRightLift = curRightLift;
                } else {
                    prevLeftLift = 0;
                    prevRightLift = 0;
                }
            }
        },
        updateWorld({ motion, frameDt, weatherState, chunks, sampler }: any) {
            if (!boundSandField && chunks?.sandField) {
                boundSandField = chunks.sandField;
            }
            if (!syncSand && chunks?.syncSandAt) {
                syncSand = chunks.syncSandAt;
            }
            const focusPos = motion?.bodyPos || motion?.position || controller.getPose().position;
            if (dust && typeof dust.updateAmbient === 'function' && focusPos) {
                dust.updateAmbient(focusPos, frameDt, weatherState);
            }
            if (granules && typeof granules.update === 'function' && chunks?.sandField) {
                currentChunks = chunks;
                currentSampler = sampler;
                granulesEnv.windX = weatherState.windX;
                granulesEnv.windZ = weatherState.windZ;
                granules.update(frameDt, granulesEnv);
            }
        },
        getDebug() {
            if (typeof model.getModelDebug === 'function' && typeof controller.setModelDebug === 'function') {
                controller.setModelDebug(model.getModelDebug());
            }
            const ctrlDebug = controller.getDebug() || {};
            if (typeof model.getModelDebug === 'function') {
                ctrlDebug.model = model.getModelDebug();
            }
            return ctrlDebug;
        },
        dispose() {
            if (model?.dispose) model.dispose();
            if (controller?.dispose) controller.dispose();
        }
    };
}
