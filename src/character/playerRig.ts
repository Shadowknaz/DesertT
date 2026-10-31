import * as THREE from 'three';
import { RAPIER } from '../world/physics.ts';
import { COSMO, COLLISION_GROUPS } from '../config.ts';

export interface PlayerRigOptions {
    world: any;
    spawnPosition?: THREE.Vector3;
    spawnYaw?: number;
    config?: Partial<typeof COSMO> & {
        enableAutostep?: boolean;
        autostepMaxHeight?: number;
        autostepMinWidth?: number;
        maxSlopeClimbAngle?: number;
        minSlopeSlideAngle?: number;
        snapToGroundDistance?: number;
        [key: string]: any;
    };
}

export interface PlayerRigMovementResult {
    movement: { x: number; y: number; z: number };
    grounded: boolean;
}

export interface PlayerRig {
    body: any;
    collider: any;
    characterController: any;
    capsuleOffsetY: number;
    computeMovement(desiredTranslation: { x: number; y: number; z: number }): PlayerRigMovementResult;
    applyMovement(movement: { x: number; y: number; z: number }): void;
    getFeetPosition(): { x: number; y: number; z: number };
    setFeetPosition(x: number, y: number, z: number): void;
    isGrounded(): boolean;
    numCollisions(): number;
    getCollision(idx: number): any;
    dispose(): void;
}

/**
 * Физический риг двуногого персонажа Cosmo на базе Rapier 3D.
 * Инкапсулирует kinematicPositionBased тело, капсульный коллайдер и KinematicCharacterController.
 */
export function createPlayerRig({
    world,
    spawnPosition = new THREE.Vector3(0, 0, 0),
    spawnYaw = 0,
    config = COSMO
}: PlayerRigOptions = {} as PlayerRigOptions): PlayerRig {
    if (!world) {
        throw new Error('playerRig requires a Rapier physics world');
    }

    const capsuleHalfHeight = config.capsuleHalfHeight ?? 0.52;
    const capsuleRadius = config.capsuleRadius ?? 0.28;
    const capsuleOffsetY = config.capsuleOffsetY ?? 0.80;
    const mass = config.mass ?? 85.0;

    const initialY = (spawnPosition.y || 0) + capsuleOffsetY;
    const initialX = spawnPosition.x || 0;
    const initialZ = spawnPosition.z || 0;

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(initialX, initialY, initialZ)
        .setCanSleep(false);

    const body = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, capsuleRadius)
        .setCollisionGroups(COLLISION_GROUPS.COSMO)
        .setFriction(0.5)
        .setRestitution(0.0);

    const collider = world.createCollider(colliderDesc, body);

    // Создаем KinematicCharacterController с запасом (skin offset) 4 см для плавного скольжения по склонам дюн
    const characterController = world.createCharacterController(0.04);
    characterController.setUp({ x: 0.0, y: 1.0, z: 0.0 });
    characterController.setSlideEnabled(true);
    characterController.setMaxSlopeClimbAngle(config.maxSlopeClimbAngle ?? (50 * Math.PI / 180));
    characterController.setMinSlopeSlideAngle(config.minSlopeSlideAngle ?? (32 * Math.PI / 180));
    if (config.enableAutostep) {
        characterController.enableAutostep(
            config.autostepMaxHeight ?? 0.25,
            config.autostepMinWidth ?? 0.20,
            false
        );
    }
    characterController.enableSnapToGround(config.snapToGroundDistance ?? 0.35);
    characterController.setApplyImpulsesToDynamicBodies(true);
    characterController.setCharacterMass(mass);

    let disposed = false;
    let isGroundedCache = false;

    /**
     * Вычисляет допустимое физическое перемещение капсулы с учетом препятствий и склонов.
     * @param {Object} desiredTranslation {x, y, z} в метрах за подшаг
     * @returns {Object} { movement: {x, y, z}, grounded: boolean }
     */
    function computeMovement(desiredTranslation: { x: number; y: number; z: number }): PlayerRigMovementResult {
        if (disposed) return { movement: { x: 0, y: 0, z: 0 }, grounded: false };

        characterController.computeColliderMovement(collider, desiredTranslation);
        const movement = characterController.computedMovement();
        isGroundedCache = characterController.computedGrounded();

        return {
            movement,
            grounded: isGroundedCache
        };
    }

    /**
     * Применяет вычисленное перемещение к физическому телу (nextKinematicTranslation).
     * @param {Object} movement {x, y, z}
     */
    function applyMovement(movement: { x: number; y: number; z: number }): void {
        if (disposed) return;
        const currentTra = body.translation();
        const nextTra = {
            x: currentTra.x + movement.x,
            y: currentTra.y + movement.y,
            z: currentTra.z + movement.z
        };
        body.setNextKinematicTranslation(nextTra);
        body.setTranslation(nextTra, true);
    }

    /**
     * Возвращает позицию подошвы стоп персонажа (центр капсулы минус capsuleOffsetY).
     */
    function getFeetPosition(): { x: number; y: number; z: number } {
        if (disposed) return { x: 0, y: 0, z: 0 };
        const tra = body.translation();
        return {
            x: tra.x,
            y: tra.y - capsuleOffsetY,
            z: tra.z
        };
    }

    /**
     * Непосредственно телепортирует персонажа в заданную мировую точку подошвы.
     */
    function setFeetPosition(x: number, y: number, z: number): void {
        if (disposed) return;
        body.setTranslation({
            x,
            y: y + capsuleOffsetY,
            z
        }, true);
    }

    /**
     * Освобождает связанные ресурсы Rapier в WASM памяти.
     */
    function dispose(): void {
        if (disposed) return;
        disposed = true;
        if (characterController && typeof characterController.free === 'function') {
            characterController.free();
        }
        if (world && collider) {
            world.removeCollider(collider, false);
        }
        if (world && body) {
            world.removeRigidBody(body);
        }
    }

    return {
        body,
        collider,
        characterController,
        capsuleOffsetY,
        computeMovement,
        applyMovement,
        getFeetPosition,
        setFeetPosition,
        isGrounded: () => isGroundedCache,
        numCollisions: () => (disposed ? 0 : characterController.numComputedCollisions()),
        getCollision: (idx: number) => (disposed ? null : characterController.computedCollision(idx)),
        dispose
    };
}
