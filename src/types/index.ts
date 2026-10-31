// Общие типы данных и интерфейсы проекта

export interface Vector2Like {
    x: number;
    y: number;
}

export interface Vector3Like {
    x: number;
    y: number;
    z: number;
    set?(x: number, y: number, z: number): this;
}

export interface QuaternionLike {
    x: number;
    y: number;
    z: number;
    w: number;
}

export type SoilClassification =
    | 'loose_sand'
    | 'compacted_sand'
    | 'hardpan'
    | 'rubble'
    | 'solid_rock';

export interface GroundSample {
    height: number;
    normal: Vector3Like;
    soilType?: SoilClassification;
    material?: string;
    friction?: number;
    bearing?: number;
}

export interface Pose {
    position: Vector3Like;
    quaternion?: QuaternionLike;
    velocity?: Vector3Like;
    yaw?: number;
    currentYaw?: number;
    pitch?: number;
    roll?: number;
    flatFwd?: Vector3Like;
}

export interface ActorDebugInfo {
    [key: string]: unknown;
}

export interface ActorWorldContext {
    motion?: any;
    frameDt: number;
    simulatedDt: number;
    weatherState?: any;
    chunks?: any;
    sampler?: any;
}

export interface ActorStepResult {
    motion?: any;
    support?: any;
    [key: string]: any;
}

export interface IActor {
    id: string;
    contextId: string;
    controller: {
        update(dt: number, ctx: unknown): any;
        onAction?(name: string, phase: string): void;
        [key: string]: any;
    };
    getPose(): Pose;
    getVisualPose?(alpha?: number): Pose | any;
    simulateStep(dt: number, command?: any, weatherState?: any): ActorStepResult | any;
    syncVisuals(alpha?: number): void;
    updateWorld(context: ActorWorldContext): void;
    getDebug(params?: any): ActorDebugInfo;
    dispose?(): void;
}
