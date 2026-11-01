import { BUGGY } from '../config.ts';
import type { ActorRegistry } from '../actor/actorRegistry.ts';
import { createDefaultVehicleAttachPoints } from './buggyModel.ts';
import type {
    IVehicleController,
    IVehicleModel,
    IVehicleRider,
    TransportVehicleDefinition,
    VehicleAttachPoints,
    VehicleVisualState
} from './types.ts';
import { createVehicleActor, type CreateVehicleActorOptions, type VehicleActor } from './vehicleActor.ts';

export interface RegisterVehicleOptions extends Omit<
    CreateVehicleActorOptions,
    'onActivateVehicle' | 'onDeactivateVehicle' | 'onSyncSeatedRider'
> {
    id: string;
    kind?: string;
    name?: string;
    model: IVehicleModel;
    controller: IVehicleController;
    mountRadius?: number;
}

export interface TransportManagerOptions {
    actorRegistry?: ActorRegistry | null;
    rider?: IVehicleRider | null;
}

export interface TransportManager {
    registerVehicle(options: RegisterVehicleOptions): TransportVehicleDefinition;
    getVehicle(id: string): TransportVehicleDefinition | null;
    getAllVehicles(): TransportVehicleDefinition[];
    setRider(rider: IVehicleRider | null): void;
    getRider(): IVehicleRider | null;
    findNearestVehicle(maxRadius?: number): TransportVehicleDefinition | null;
    mountVehicle(vehicleId: string, options?: { activateActor?: boolean }): boolean;
    dismountVehicle(options?: { activateRiderActor?: boolean }): boolean;
    tryInteract(activeActorId?: string | null): boolean;
    simulateInactiveVehicles(dt: number, activeActorId?: string | null, weatherState?: any): void;
    isRiderMounted(): boolean;
    getMountedVehicleId(): string | null;
    dispose(): void;
}

/**
 * Независимый менеджер транспортной подсистемы.
 * Позволяет регистрировать произвольное количество разных транспортных средств
 * (мотоциклы, багги, квадроциклы, роверы) и управляет посадкой/высадкой пилота.
 */
export function createTransportManager({
    actorRegistry = null,
    rider: initialRider = null
}: TransportManagerOptions = {}): TransportManager {
    const vehicles = new Map<string, TransportVehicleDefinition>();
    let rider: IVehicleRider | null = initialRider;
    let mountedVehicleId: string | null = null;
    let isTransitioning = false;
    const attachScratch = createDefaultVehicleAttachPoints();
    const unmannedCommand = {
        throttleInput: 0,
        steerInput: 0,
        wantBoost: false,
        wantBrake: false,
        unmanned: true,
        dt: 1 / 60
    };

    function handleSyncSeatedRider(
        vehicleId: string,
        attachPoints: VehicleAttachPoints,
        state: VehicleVisualState
    ): void {
        if (!rider || mountedVehicleId !== vehicleId) return;
        rider.syncSeated(vehicleId, attachPoints, state);
    }

    function handleActivateVehicle(vehicleId: string): void {
        if (isTransitioning) return;
        if (mountedVehicleId !== vehicleId) {
            mountVehicle(vehicleId, { activateActor: false });
        }
    }

    function handleDeactivateVehicle(vehicleId: string): void {
        if (isTransitioning) return;
        if (mountedVehicleId === vehicleId) {
            dismountVehicle({ activateRiderActor: false });
        }
    }

    function registerVehicle(options: RegisterVehicleOptions): TransportVehicleDefinition {
        if (!options || !options.id) {
            throw new Error('TransportManager.registerVehicle requires a non-empty vehicle "id"');
        }
        if (vehicles.has(options.id)) {
            throw new Error(`Vehicle "${options.id}" is already registered in TransportManager`);
        }

        const actor: VehicleActor = createVehicleActor({
            ...options,
            id: options.id,
            contextId: options.contextId || 'transport',
            hintsKey: options.hintsKey || 'transport',
            onActivateVehicle: handleActivateVehicle,
            onDeactivateVehicle: handleDeactivateVehicle,
            onSyncSeatedRider: handleSyncSeatedRider
        });

        const entry: TransportVehicleDefinition = {
            id: options.id,
            kind: options.kind || options.id,
            name: options.name || options.id,
            model: options.model,
            controller: options.controller,
            actor,
            mountRadius: options.mountRadius ?? BUGGY.mountRadius
        };

        vehicles.set(entry.id, entry);

        if (actorRegistry) {
            actorRegistry.registerActor(actor);
        }

        // Синхронизируем стартовую визуальную позу транспорта на рельефе
        actor.syncVisuals(1.0);
        return entry;
    }

    function getVehicle(id: string): TransportVehicleDefinition | null {
        return vehicles.get(id) || null;
    }

    function getAllVehicles(): TransportVehicleDefinition[] {
        return Array.from(vehicles.values());
    }

    function setRider(newRider: IVehicleRider | null): void {
        rider = newRider;
    }

    function getRider(): IVehicleRider | null {
        return rider;
    }

    function findNearestVehicle(maxRadius?: number): TransportVehicleDefinition | null {
        if (!rider || vehicles.size === 0) return null;
        const riderPos = rider.getPosition();
        let best: TransportVehicleDefinition | null = null;
        let bestDist = Infinity;

        for (const entry of vehicles.values()) {
            const vPos = entry.controller.getPose().position;
            const dist = Math.hypot(vPos.x - riderPos.x, vPos.z - riderPos.z);
            const allowedRadius = maxRadius ?? entry.mountRadius ?? BUGGY.mountRadius;
            if (dist <= allowedRadius && dist < bestDist) {
                bestDist = dist;
                best = entry;
            }
        }
        return best;
    }

    function mountVehicle(vehicleId: string, options: { activateActor?: boolean } = {}): boolean {
        const entry = vehicles.get(vehicleId);
        if (!entry || !rider) return false;

        const { activateActor = true } = options;
        if (mountedVehicleId && mountedVehicleId !== vehicleId) {
            dismountVehicle({ activateRiderActor: false });
        }

        mountedVehicleId = vehicleId;
        const state = entry.controller.getVisualState(1.0);
        entry.model.pose.rootPosition.copy(state.position);
        entry.model.pose.rootYaw = state.yaw;
        entry.model.pose.chassisHeightOffset = state.chassisHeightOffset;
        entry.model.pose.chassisPitch = state.chassisPitch;
        entry.model.pose.chassisRoll = state.chassisRoll;
        entry.model.pose.steeringAngle = state.steeringAngle;
        entry.model.pose.frontGroundY = state.frontGroundY;
        entry.model.pose.rearGroundY = state.rearGroundY;
        entry.model.pose.frontWheelSpin = state.frontWheelSpin;
        entry.model.pose.rearWheelSpin = state.rearWheelSpin;
        entry.model.update();

        const attachPoints = entry.model.getAttachPoints(attachScratch);
        rider.onMount(vehicleId, attachPoints, state);

        if (activateActor && actorRegistry && actorRegistry.getActiveActor()?.id !== vehicleId) {
            isTransitioning = true;
            try {
                actorRegistry.setActiveActor(vehicleId);
            } finally {
                isTransitioning = false;
            }
        }
        return true;
    }

    function dismountVehicle(options: { activateRiderActor?: boolean } = {}): boolean {
        if (!mountedVehicleId) return false;
        const entry = vehicles.get(mountedVehicleId);
        const { activateRiderActor = true } = options;
        mountedVehicleId = null;

        if (entry && rider) {
            const state = entry.controller.getVisualState(1.0);
            entry.model.pose.rootPosition.copy(state.position);
            entry.model.pose.rootYaw = state.yaw;
            entry.model.pose.chassisHeightOffset = state.chassisHeightOffset;
            entry.model.pose.chassisPitch = state.chassisPitch;
            entry.model.pose.chassisRoll = state.chassisRoll;
            entry.model.pose.steeringAngle = state.steeringAngle;
            entry.model.pose.frontGroundY = state.frontGroundY;
            entry.model.pose.rearGroundY = state.rearGroundY;
            entry.model.pose.frontWheelSpin = state.frontWheelSpin;
            entry.model.pose.rearWheelSpin = state.rearWheelSpin;
            entry.model.update();
            const attachPoints = entry.model.getAttachPoints(attachScratch);
            rider.onDismount(attachPoints.dismountPosition, attachPoints.dismountYaw);
        }

        if (activateRiderActor && actorRegistry && rider && actorRegistry.getActor(rider.id)) {
            if (actorRegistry.getActiveActor()?.id !== rider.id) {
                isTransitioning = true;
                try {
                    actorRegistry.setActiveActor(rider.id);
                } finally {
                    isTransitioning = false;
                }
            }
        }
        return true;
    }

    function tryInteract(activeActorId?: string | null): boolean {
        if (mountedVehicleId) {
            return dismountVehicle({ activateRiderActor: true });
        }
        if (!rider) return false;
        if (activeActorId && activeActorId !== rider.id && !vehicles.has(activeActorId)) {
            return false;
        }
        const nearest = findNearestVehicle();
        if (!nearest) return false;
        return mountVehicle(nearest.id, { activateActor: true });
    }

    function simulateInactiveVehicles(dt: number, activeActorId?: string | null, weatherState?: any): void {
        const currentActiveId = activeActorId ?? actorRegistry?.getActiveActor()?.id ?? null;
        unmannedCommand.dt = dt;
        for (const entry of vehicles.values()) {
            if (entry.id === currentActiveId) continue;
            entry.controller.simulateStep(dt, unmannedCommand, weatherState);
        }
    }

    function dispose(): void {
        mountedVehicleId = null;
        vehicles.clear();
        rider = null;
    }

    return {
        registerVehicle,
        getVehicle,
        getAllVehicles,
        setRider,
        getRider,
        findNearestVehicle,
        mountVehicle,
        dismountVehicle,
        tryInteract,
        simulateInactiveVehicles,
        isRiderMounted: () => mountedVehicleId !== null,
        getMountedVehicleId: () => mountedVehicleId,
        dispose
    };
}
