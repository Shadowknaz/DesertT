// Типы данных модульной системы строительства с сокетами и чанковым рендером.
import type * as THREE from 'three';

export type PieceType =
    | 'foundation'
    | 'solid_wall'
    | 'window_wall'
    | 'door_wall'
    | 'ceiling'
    | 'staircase_railed'
    | 'staircase_open';

export type Rotation = 0 | 1 | 2 | 3;

export type PieceCategory = 'foundation' | 'wall' | 'ceiling' | 'stairs';

export type SocketType =
    | 'foundation_side'
    | 'foundation_stair'
    | 'wall_bottom'
    | 'wall_top'
    | 'wall_side'
    | 'ceiling_support'
    | 'ceiling_edge'
    | 'stair_bottom'
    | 'stair_top';

export interface GridCell {
    x: number;
    y: number;
    z: number;
}

export interface Piece {
    type: PieceType;
    rot: Rotation;
    tier: number;
    baseY?: number;
    isOpen?: boolean;
    openProgress?: number;
    sunkInFoundation?: boolean;
}

export interface SocketDef {
    id: string;
    label: string;
    type: SocketType;
    // Локальная позиция сокета в метрах относительно базовой точки клетки (при rot = 0)
    position: { x: number; y: number; z: number };
    // Направление сокета (нормаль привязки при rot = 0)
    direction: { x: number; y: number; z: number };
    // Смещение целевой клетки сетки (при rot = 0), куда встанет примагниченный модуль
    cellOffset: { dx: number; dy: number; dz: number };
    // Какие категории и типы модулей могут примагнититься к этому сокету
    compatibleCategories: PieceCategory[];
    compatibleTypes: PieceType[];
    // Правило ориентации примагничиваемого элемента:
    // - 'edge': фиксированная грань (для стен на краю фундамента/потолка)
    // - 'same': наследует ориентацию родительского элемента (стена на стену, лестница на лестницу)
    // - 'free': сохраняет выбранный игроком поворот
    rotRule: 'edge' | 'same' | 'free';
    // Локальный индекс грани (0=N, 1=E, 2=S, 3=W) при rot = 0
    localEdgeRot?: Rotation;
}

export interface PieceDef {
    type: PieceType;
    name: string;
    shortName: string;
    description: string;
    hotkey: string;
    category: PieceCategory;
    // Размер в целочисленных клетках сетки
    size: { x: number; y: number; z: number };
    // Физические габариты модели в метрах
    dimensions: { width: number; height: number; depth: number };
    // Фундамент ставится на землю (true), все остальные элементы — только к существующим (false)
    requiresGround: boolean;
    sockets: SocketDef[];
}

export interface WorldSocket {
    id: string;
    label: string;
    type: SocketType;
    sourceCell: GridCell;
    sourcePiece: Piece;
    targetCell: GridCell;
    recommendedRot: Rotation;
    rotRule: 'edge' | 'same' | 'free';
    worldPos: { x: number; y: number; z: number };
    worldDir: { x: number; y: number; z: number };
    compatibleCategories: PieceCategory[];
    compatibleTypes: PieceType[];
    baseY: number;
}

export type PlacementFailureReason =
    | 'ok'
    | 'too_far'
    | 'invalid_level'
    | 'cell_occupied'
    | 'intersection'
    | 'no_ground'
    | 'no_socket'
    | 'no_support';

export interface PlacementValidation {
    valid: boolean;
    reason: PlacementFailureReason;
    message: string;
    matchedSocket: WorldSocket | null;
}

export interface SnapCandidate {
    cell: GridCell;
    rot: Rotation;
    baseY: number;
    worldPos: THREE.Vector3;
    rotationY: number;
    snappedToSocket: boolean;
    socket: WorldSocket | null;
    validation: PlacementValidation;
}
