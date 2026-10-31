// Virtual stance contacts share normal loads with support geometry. Tangent
// forces use a full contact-plane ellipse; sand yielding is a bounded model
// for kinematic feet, not a physical sole/yaw friction solver.
import { MECH, PHYSICS, SANDFIELD, HEXAPOD } from '../config.ts';
import {
    hipOffset,
    legContactNormal,
    solveNormalLoads,
    type LegContactState,
    type QuaternionLike,
    type Vector3Like,
    type SupportPlaneLike
} from './contactModel.ts';
import { copyGroundSample, type GroundSample } from '../world/groundSampler.ts';
import { computeBulldozingResistance, getInterpolatedSandProperties } from '../world/terramechanics.ts';

export interface LegContactsDebug {
    normal: number;
    tangent: number;
    capacity: number;
    grip: number;
    saturation: number; // Mean rejected fraction of tangent force request, 0..1
    slip: number;       // Mean ACCEPTED anchor speed from the gait pass, m/s
    planted: number;
    stepDurationMs?: number;
}

export interface LegContactsMotion {
    bodyPos: Vector3Like;
    bodyQuat: QuaternionLike;
    bodyVel: Vector3Like;
    bodyAngVel: Vector3Like;
    flatFwd: Vector3Like;
    driveForceX: number;
    driveForceZ: number;
    attitudeTorqueX: number;
    attitudeTorqueZ: number;
    yawTorque: number;
    airborne?: boolean;
    landingGear?: boolean;
    recovery?: boolean;
    landed?: boolean;
    velocityGain?: number;
    bodyCom?: Vector3Like;
}

export interface LegContactsOptions {
    body: any;
    legs: any[];
}

export interface LegContacts {
    solve(motion: LegContactsMotion, plane: SupportPlaneLike, dt?: number): LegContactsDebug;
    getDebug(): LegContactsDebug;
}

export function createLegContacts({ body, legs }: LegContactsOptions): LegContacts {
    const bodyWeight = MECH.mass * Math.abs(PHYSICS.gravity);
    const normalLimit = bodyWeight * MECH.normalForceLimit;
    const debug: LegContactsDebug = {
        normal: 0, tangent: 0, capacity: 0, grip: 0,
        saturation: 0, // Mean rejected fraction of tangent force request, 0..1
        slip: 0,       // Mean ACCEPTED anchor speed from the gait pass, m/s
        planted: 0
    };
    const point: Vector3Like = { x: 0, y: 0, z: 0 };
    const force: Vector3Like = { x: 0, y: 0, z: 0 };
    const hipWorld: Vector3Like = { x: 0, y: 0, z: 0 };
    const normal: Vector3Like = { x: 0, y: 1, z: 0 };
    const tangentForward: Vector3Like = { x: 0, y: 0, z: 1 };

    function clearVector(leg: any, key: string): void {
        const v = leg[key] || (leg[key] = { x: 0, y: 0, z: 0 });
        v.x = v.y = v.z = 0;
    }

    function gripOf(packing: number | undefined): number {
        const p = Number.isFinite(packing) ? Math.max(0, Math.min(1, packing!)) : 0;
        return SANDFIELD.gripLoose + (SANDFIELD.gripPacked - SANDFIELD.gripLoose) * p;
    }

    function contactHeading(forward: Vector3Like): void {
        const into = forward.x * normal.x + forward.y * normal.y + forward.z * normal.z;
        tangentForward.x = forward.x - normal.x * into;
        tangentForward.y = forward.y - normal.y * into;
        tangentForward.z = forward.z - normal.z * into;
        let length = Math.hypot(tangentForward.x, tangentForward.y, tangentForward.z);
        if (!(length > MECH.contactTangentEpsilon)) {
            // The least parallel cardinal axis guarantees a well-conditioned
            // orthogonal projection, even for a zero or normal-aligned heading.
            const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
            const x = ax <= ay && ax <= az ? 1 : 0;
            const y = !x && ay <= az ? 1 : 0;
            const z = !x && !y ? 1 : 0;
            const dot = x * normal.x + y * normal.y + z * normal.z;
            tangentForward.x = x - normal.x * dot;
            tangentForward.y = y - normal.y * dot;
            tangentForward.z = z - normal.z * dot;
            length = Math.hypot(tangentForward.x, tangentForward.y, tangentForward.z);
        }
        tangentForward.x /= length;
        tangentForward.y /= length;
        tangentForward.z /= length;
    }

    // Forces and pending displacement belong to one physics substep. A second
    // solve replaces, rather than accumulates, an unconsumed yielding request.
    function solve(motion: LegContactsMotion, plane: SupportPlaneLike, dt = PHYSICS.fixedDt): LegContactsDebug {
        const { bodyPos, bodyQuat, bodyVel, bodyAngVel, flatFwd } = motion;
        const supportLimit = motion.landingGear
            ? bodyWeight * MECH.landingForceLimit : normalLimit;
        body.resetForces(true);
        body.resetTorques(true);
        for (const leg of legs) {
            leg.normalForce = 0;
            leg.normalLoad = 0; // Actual applied load; never overwrite supportForce.
            leg.tangentForce = 0;
            leg.forceSaturation = 0;
            leg.pendingAnchorShift = null;
            clearVector(leg, 'tangentRequested');
            clearVector(leg, 'tangentApplied');
            clearVector(leg, 'yieldVelocity');
            if (motion.airborne || !leg.isPlanted || leg.isStepping
                || leg.groundContact?.surfaceType === 'solid') leg.slip = 0;
        }
        debug.normal = debug.tangent = debug.capacity = debug.grip = 0;
        debug.saturation = debug.slip = debug.planted = 0;
        debug.stepDurationMs = 0;
        if (motion.airborne) return debug;
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

        if (!plane?.loadsSolved) {
            solveNormalLoads(legs, bodyPos, bodyQuat, bodyVel, bodyAngVel, plane,
                supportLimit, motion.bodyCom || body.worldCom());
        }
        // Preserve the existing active-load threshold and exclude stale stance
        // predictions. All shares use precisely the set of applied loads.
        let sumNormal = 0;
        for (const leg of legs) {
            if (leg.isPlanted && !leg.isStepping && Number.isFinite(leg.supportForce)
                && leg.supportForce > 1e-3) sumNormal += leg.supportForce;
        }
        if (!(sumNormal > SANDFIELD.loadEpsilon) || !Number.isFinite(sumNormal)) return debug;

        let packingSum = 0, saturationSum = 0, slipSum = 0, applied = 0;
        const gain = motion.velocityGain ?? MECH.velGainGround;
        for (const leg of legs) {
            const magnitude = leg.supportForce;
            if (!leg.isPlanted || leg.isStepping || !Number.isFinite(magnitude)
                || !(magnitude > 1e-3)) continue;
            leg.normalForce = leg.normalLoad = magnitude;
            legContactNormal(leg, normal);
            // Keep the force plane orthonormal, including vertical fallbacks.
            const nlen = Math.hypot(normal.x, normal.y, normal.z);
            normal.x /= nlen;
            normal.y /= nlen;
            normal.z /= nlen;
            const { x: nx, y: ny, z: nz } = normal;
            contactHeading(flatFwd);
            const { x: tx, y: ty, z: tz } = tangentForward;
            // Lateral tangent is n cross tf, NOT a world-horizontal right axis.
            const sx = ny * tz - nz * ty;
            const sy = nz * tx - nx * tz;
            const sz = nx * ty - ny * tx;

            const share = magnitude / sumNormal;
            const rx = motion.driveForceX * share;
            const rz = motion.driveForceZ * share;
            const into = rx * nx + rz * nz;
            const requested = leg.tangentRequested;
            requested.x = rx - into * nx;
            requested.y = -into * ny;
            requested.z = rz - into * nz;

            const surface = leg.groundContact;
            const rawMu = surface?.surfaceType === 'solid'
                ? surface.friction : gripOf(surface?.packing ?? leg.packing);
            const mu = Number.isFinite(rawMu) ? Math.max(0, rawMu) : 0;
            const capTraction = mu * magnitude;
            let maxActuatorForce = Infinity;
            if (leg.hipLocal && HEXAPOD.actuatorTorqueMax) {
                hipOffset(bodyQuat, leg.hipLocal, hipWorld);
                const hx = bodyPos.x + hipWorld.x;
                const hz = bodyPos.z + hipWorld.z;
                const dHip = Math.hypot(leg.currentFootPos.x - hx, leg.currentFootPos.z - hz);
                maxActuatorForce = HEXAPOD.actuatorTorqueMax / Math.max(0.35, dHip);
            }
            const capLong = Math.min(capTraction, maxActuatorForce);
            const capSide = capLong * SANDFIELD.lateralGrip;
            let scale = 1;
            if (capLong > 0 && capSide > 0) {
                const longitudinal = requested.x * tx + requested.y * ty + requested.z * tz;
                const lateral = requested.x * sx + requested.y * sy + requested.z * sz;
                const rho = Math.hypot(longitudinal / capLong, lateral / capSide);
                scale = 1 / Math.max(1, rho);
            } else if (Math.hypot(requested.x, requested.y, requested.z) > 0) {
                // No division by zero and no artificial minimum traction.
                scale = 0;
            }
            const tangent = leg.tangentApplied;
            tangent.x = requested.x * scale;
            tangent.y = requested.y * scale;
            tangent.z = requested.z * scale;
            leg.forceSaturation = 1 - scale;
            leg.tangentForce = Math.hypot(tangent.x, tangent.y, tangent.z);

            // Unmet force yields the sand anchor opposite the body demand.
            // This coefficient uses the exact velocity gain from locomotion.
            const coefficient = MECH.mass * gain * share;
            if (surface?.surfaceType === 'sand' && !motion.recovery && !motion.landed
                && share > SANDFIELD.yieldShareEpsilon
                && Number.isFinite(coefficient) && coefficient > SANDFIELD.yieldCoefficientEpsilon) {
                const v = leg.yieldVelocity;
                v.x = -(requested.x - tangent.x) / coefficient;
                v.y = -(requested.y - tangent.y) / coefficient;
                v.z = -(requested.z - tangent.z) / coefficient;
                const speed = Math.hypot(v.x, v.y, v.z);
                if (speed > SANDFIELD.maxSlipSpeed) {
                    const limit = SANDFIELD.maxSlipSpeed / speed;
                    v.x *= limit; v.y *= limit; v.z *= limit;
                }
                if (speed > 0 && Number.isFinite(dt) && dt > 0) {
                    leg.pendingAnchorShift = {
                        x: v.x * dt, y: v.y * dt, z: v.z * dt, dt,
                        origin: { ...leg.currentFootPos },
                        surface: copyGroundSample(surface)
                    };
                }
            }

            debug.tangent += leg.tangentForce;
            debug.capacity += capLong;
            packingSum += leg.packing || 0;
            saturationSum += leg.forceSaturation;
            slipSum += leg.slip || 0;
            applied++;

            // Preserve normal reaction at the foot and drive through the hip.
            point.x = leg.currentFootPos.x;
            point.y = leg.currentFootPos.y;
            point.z = leg.currentFootPos.z;
            force.x = nx * magnitude; force.y = ny * magnitude; force.z = nz * magnitude;
            body.addForceAtPoint(force, point, true);
            if (leg.hipLocal) {
                hipOffset(bodyQuat, leg.hipLocal, hipWorld);
                point.x = bodyPos.x + hipWorld.x;
                point.y = bodyPos.y + hipWorld.y;
                point.z = bodyPos.z + hipWorld.z;
            }
            body.addForceAtPoint(tangent, point, true);

            // Bulldozing drag from foot displacement into sand resisting chassis motion
            if (surface?.surfaceType === 'sand' && !motion.airborne) {
                const sinkage = leg.sinkage ?? surface?.sink ?? 0.0;
                const slipSpeed = Math.hypot(leg.yieldVelocity?.x || 0, leg.yieldVelocity?.z || 0);
                if (sinkage > 0.005 && slipSpeed > 0.005) {
                    const mat = getInterpolatedSandProperties(surface?.packing ?? leg.packing ?? 0);
                    const bdrag = computeBulldozingResistance(sinkage, HEXAPOD.footWidth || 0.82, mat) * (MECH.bulldozeDragGain ?? 0.45);
                    if (bdrag > 0) {
                        const dragClamped = Math.min(bdrag, magnitude * 0.5);
                        const bdx = -(leg.yieldVelocity.x / slipSpeed) * dragClamped;
                        const bdz = -(leg.yieldVelocity.z / slipSpeed) * dragClamped;
                        body.addForceAtPoint({ x: bdx, y: 0, z: bdz }, point, true);
                    }
                }
            }
        }

        // Existing attitude/yaw hydraulics remain independent of this model.
        const supportShare = Math.min(1, applied / 3);
        body.addTorque({
            x: motion.attitudeTorqueX * supportShare,
            y: motion.yawTorque * supportShare,
            z: motion.attitudeTorqueZ * supportShare
        }, true);
        debug.normal = sumNormal;
        debug.grip = applied ? packingSum / applied : 0;
        debug.saturation = applied ? saturationSum / applied : 0;
        debug.slip = applied ? slipSum / applied : 0;
        debug.planted = applied;
        debug.stepDurationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        return debug;
    }

    return { solve, getDebug: () => debug };
}

