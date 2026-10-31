// Физический риг шестиногого шагохода: корпус в Rapier, визуальная модель
// прототипа и шесть кинематических тел стоп. Визуальный корень стоит на
// плоскости стоп (низ модели), поэтому syncVisuals опускает его на
// rideHeight ниже центра физического тела.
import * as THREE from 'three';
import { RAPIER } from '../world/physics.ts';
import { HEXAPOD, MECH } from '../config.ts';
import { getDuneHeight } from '../core/duneField.ts';
import { createHexapodMaterials, type HexapodMaterials } from './hexapodMaterials.ts';
import { buildHexapodModel, type HexapodModel, type HexapodLeg } from './hexapodModel.ts';

const upAxis = new THREE.Vector3(0, 1, 0);

export interface MechRigOptions {
    scene: THREE.Scene;
    world: any;
    spawnX?: number;
    spawnZ?: number;
    spawnYaw?: number;
}

export interface MechRig {
    body: any;
    root: THREE.Group;
    chassisGroup: THREE.Group;
    legs: HexapodLeg[];
    footBodyHandles: Set<number>;
    syncVisuals(): void;
    syncFromMotion(motion: { bodyPos: any; bodyQuat: any }): void;
    setDustCoat(amount: number): void;
    dispose(): void;
}

export function createMechRig({
    scene,
    world,
    spawnX = 0.0,
    spawnZ = 0.0,
    spawnYaw = 0.0
}: MechRigOptions): MechRig {
    const materials = createHexapodMaterials();
    const { root, chassisGroup, legs } = buildHexapodModel(materials);
    root.scale.setScalar(HEXAPOD.scale);
    scene.add(root);

    // Физический корпус: центр масс на высоте корпуса над песком.
    // Демпфирование слабое: скорость корпуса теперь задают силы лап,
    // а не прямое управление, и вязкость не должна съедать динамику.
    //
    // Высота считается по средней высоте грунта под всеми шестью стопами,
    // а не по точке спавна: на склоне и на седловине это разные числа, и
    // ошибка в 0.2 м сразу превращается в бросок корпуса пружинами.
    // Ориентация остается по курсу: стойки вертикальны, и корпус обязан
    // быть ровным, иначе подвес получает фиктивное сжатие в метр.
    let sumGround = 0.0;
    for (const leg of legs) {
        sumGround += getDuneHeight(spawnX + leg.restLocal.x, spawnZ + leg.restLocal.z);
    }
    const startY = sumGround / Math.max(1, legs.length) + MECH.rideHeight;

    const yawQuat = new THREE.Quaternion().setFromAxisAngle(upAxis, spawnYaw);

    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(spawnX, startY, spawnZ)
            .setRotation({ x: yawQuat.x, y: yawQuat.y, z: yawQuat.z, w: yawQuat.w })
            .setLinearDamping(0.05)
            .setAngularDamping(1.2)
            .setCanSleep(false)
    );

    // Группы столкновений: корпус и собственные стопы не сталкиваются.
    // Иначе опрокинутый мех падает на свои кинематические лапы, и Rapier
    // выбрасывает корпус в сторону с чудовищной скоростью.
    const CHASSIS_GROUP = 0x0001FFFD;   // membership 0x0001, filter без стоп
    const FOOT_GROUP = 0x0002FFFE;      // membership 0x0002, filter без корпуса

    world.createCollider(
        RAPIER.ColliderDesc.cuboid(HEXAPOD.hullHalfX, HEXAPOD.hullHalfY, HEXAPOD.hullHalfZ)
            .setTranslation(0, HEXAPOD.hullOffsetY, 0)
            .setMass(MECH.mass)
            .setFriction(0.6)
            .setCollisionGroups(CHASSIS_GROUP),
        body
    );

    // Кинематические тела стоп: расталкивают камни, но не держат корпус
    const footBodyHandles = new Set<number>();
    const cosYaw = Math.cos(spawnYaw);
    const sinYaw = Math.sin(spawnYaw);
    for (const leg of legs) {
        const lx = leg.restLocal.x;
        const lz = leg.restLocal.z;
        const footX = spawnX + lx * cosYaw + lz * sinYaw;
        const footZ = spawnZ - lx * sinYaw + lz * cosYaw;
        const footY = getDuneHeight(footX, footZ);

        const footRb = world.createRigidBody(
            RAPIER.RigidBodyDesc.kinematicPositionBased()
                .setTranslation(footX, footY + 0.2, footZ)
        );
        world.createCollider(
            RAPIER.ColliderDesc.ball(HEXAPOD.footRadius)
                .setFriction(0.8)
                .setCollisionGroups(FOOT_GROUP),
            footRb
        );

        leg.footRb = footRb;
        leg.currentFootPos.set(footX, footY, footZ);
        leg.stepStartPos.copy(leg.currentFootPos);
        leg.stepTargetPos.copy(leg.currentFootPos);
        leg.groundNormal.set(0, 1, 0);
        footBodyHandles.add(footRb.handle);
    }

    // The chassis origin is rideHeight above the model root in BODY axes.
    // Rotating that offset keeps every visual mount at bodyPos + R * hipLocal.
    const rootOffset = new THREE.Vector3();
    function syncRoot(position: { x: number; y: number; z: number }, rotation: { x: number; y: number; z: number; w: number }): void {
        root.quaternion.copy(rotation as THREE.Quaternion);
        rootOffset.set(0, MECH.rideHeight, 0).applyQuaternion(root.quaternion);
        root.position.set(position.x, position.y, position.z).sub(rootOffset);
        root.updateMatrixWorld(true);
    }

    function syncVisuals(): void {
        syncRoot(body.translation(), body.rotation());
    }

    // IK uses the current pre-step pose, not the preceding rendered frame.
    function syncFromMotion(motion: { bodyPos: any; bodyQuat: any }): void {
        syncRoot(motion.bodyPos, motion.bodyQuat);
    }

    syncVisuals();

    function setDustCoat(amount: number): void {
        materials.setDustCoat(amount);
    }

    return {
        body, root, chassisGroup, legs, footBodyHandles,
        syncVisuals, syncFromMotion, setDustCoat,
        dispose: () => {
            if (root.parent) root.parent.remove(root);
            root.traverse(child => {
                if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
                    (child as THREE.Mesh).geometry.dispose();
                }
            });
            if ((materials as any)?.dispose) (materials as any).dispose();
        }
    };
}

