// Директор управления шагоходом (мехом).
// Арбитраж режимов: ручное управление (клавиатура) против автопилота (клик по песку).
// Возвращает полную семипольную команду: { throttle, turnInput, desiredYawRate, yawError, isManual, stompHeld, jumpHeld }.
import * as THREE from 'three';
import { AUTOPILOT, INPUT } from '../config.ts';
import { createMechCommand, type MechCommand } from '../mech/mechCommand.ts';

export interface MechDirectorContext {
    bodyPos: THREE.Vector3;
    currentYaw: number;
    flatFwd: THREE.Vector3;
    actions?: Record<string, boolean>;
    keyState?: Record<string, boolean>;
}

export interface MechDirector {
    update(dt: number, ctx: MechDirectorContext): MechCommand;
    notifyManualInput(): void;
    setWaypoint(point: THREE.Vector3 | null): void;
    onAction(name: string, phase: string): void;
    reset(): void;
    getDebug(): {
        manualControlTimer: number;
        customWaypoint: THREE.Vector3 | null;
        waypointTimer: number;
        isManual: boolean;
    };
}

export function createMechDirector(): MechDirector {
    const toTarget = new THREE.Vector3();
    const desiredDir = new THREE.Vector3();

    let manualControlTimer = 0;  // > 0 — ручной режим активен
    let customWaypoint: THREE.Vector3 | null = null;   // Точка, указанная кликом по песку
    let waypointTimer = 0;

    function notifyManualInput(): void {
        manualControlTimer = INPUT.manualHoldDuration;
        customWaypoint = null;
        waypointTimer = 0;
    }

    function setWaypoint(point: THREE.Vector3 | null): void {
        if (!point) {
            customWaypoint = null;
            waypointTimer = 0;
            return;
        }
        customWaypoint = point.clone();
        waypointTimer = INPUT.waypointLifetime;
        manualControlTimer = 0;
    }

    function reset(): void {
        manualControlTimer = 0;
        customWaypoint = null;
        waypointTimer = 0;
    }

    function onAction(name: string, phase: string): void {
        if (phase !== 'down') return;
        const movementActions = ['forward', 'backward', 'left', 'right', 'stomp', 'jump'];
        if (movementActions.includes(name)) {
            notifyManualInput();
        }
    }

    function update(dt: number, ctx: MechDirectorContext): MechCommand {
        const { bodyPos, currentYaw, flatFwd } = ctx;
        const actions = ctx.actions || ctx.keyState || {};

        const moveInput = (actions.forward ? 1 : 0) - (actions.backward ? 1 : 0);
        const turnInput = (actions.left ? 1 : 0) - (actions.right ? 1 : 0);
        const isInputActive = moveInput !== 0 || turnInput !== 0;

        if (isInputActive) {
            manualControlTimer = INPUT.manualHoldDuration;
        } else if (manualControlTimer > 0) {
            manualControlTimer -= dt;
        }

        let yawError = 0;
        let desiredYawRate = 0;
        let throttle = 0;

        if (manualControlTimer > 0) {
            // Ручной режим управления
            throttle = moveInput;
            const reverseInvert = moveInput < 0 ? -1 : 1;
            desiredYawRate = turnInput * AUTOPILOT.manualYawRate * reverseInvert;
            yawError = desiredYawRate * AUTOPILOT.manualErrorGain;
        } else if (customWaypoint) {
            // Режим автопилота к точке
            if (waypointTimer > 0) {
                waypointTimer -= dt;
            } else {
                customWaypoint = null;
            }

            if (customWaypoint) {
                toTarget.set(customWaypoint.x - bodyPos.x, 0, customWaypoint.z - bodyPos.z);
                const distToTarget = toTarget.length();

                if (distToTarget < AUTOPILOT.arrivalRadius) {
                    customWaypoint = null;
                    waypointTimer = 0;
                    manualControlTimer = INPUT.arrivalPauseDuration;
                }

                if (distToTarget > 0.05) {
                    desiredDir.copy(toTarget).normalize();
                } else {
                    desiredDir.copy(flatFwd);
                }
                const targetYaw = Math.atan2(desiredDir.x, desiredDir.z);

                yawError = targetYaw - currentYaw;
                while (yawError > Math.PI) yawError -= Math.PI * 2;
                while (yawError < -Math.PI) yawError += Math.PI * 2;

                desiredYawRate = THREE.MathUtils.clamp(
                    yawError * AUTOPILOT.alignGain,
                    -AUTOPILOT.autopilotYawRate,
                    AUTOPILOT.autopilotYawRate
                );
                throttle = distToTarget > AUTOPILOT.stopRadius ? 1.0 : 0.0;
            }
        }

        return createMechCommand({
            throttle,
            turnInput,
            desiredYawRate,
            yawError,
            isManual: manualControlTimer > 0,
            stompHeld: Boolean(actions.stomp),
            jumpHeld: Boolean(actions.jump)
        });
    }

    function getDebug() {
        return {
            manualControlTimer,
            customWaypoint: customWaypoint ? customWaypoint.clone() : null,
            waypointTimer,
            isManual: manualControlTimer > 0
        };
    }

    return {
        update,
        notifyManualInput,
        setWaypoint,
        onAction,
        reset,
        getDebug
    };
}
