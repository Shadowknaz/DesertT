// Каталог строительных префабов (PieceDef): габариты, сокеты, правила совместимости
// и математика преобразования целочисленных координат сетки (x, y, z) и поворотов (0..3).
import type {
    GridCell,
    Piece,
    PieceCategory,
    PieceDef,
    PieceType,
    Rotation,
    SocketDef
} from './types.ts';

export const CELL_SIZE = 3.2;          // Горизонтальный шаг модульной сетки (3.2 × 3.2 м из module.html)
export const MODULE_WIDTH = 3.2;
export const MODULE_DEPTH = 3.2;
export const WALL_HEIGHT = 3.0;        // Высота одного строительного яруса (этажа), м
export const WALL_THICK = 0.38;        // Толщина бронестены, м
export const FOUND_HEIGHT = 0.64;      // Высота плиты фундамента над землей, м
export const CEILING_THICK = 0.22;     // Толщина плиты перекрытия (потолка), м
export const WALL_EDGE_OFFSET = 1.38;  // Смещение стены от центра клетки к посадочным гнездам быков фундамента
export const FOUND_STAIR_SINK_OFFSET = 0.72; // Горизонтальное утапливание верхней площадки входной лестницы в фундамент, м
export const BUILDING_CHUNK_SIZE = 8;  // Размер строительного чанка в клетках (8×8 = 25.6 × 25.6 м)
export const SOCKET_SNAP_RADIUS = 2.55; // Радиус примагничивания призрака к совместимому сокету, м
export const MAX_BUILD_DISTANCE = 12.0; // Максимальная дистанция строительства от персонажа/меха, м

export const WALL_TYPES: PieceType[] = ['solid_wall', 'window_wall', 'door_wall'];
export const STAIR_TYPES: PieceType[] = ['staircase_railed', 'staircase_open'];

export const PIECE_ORDER: PieceType[] = [
    'foundation',
    'solid_wall',
    'window_wall',
    'door_wall',
    'ceiling',
    'staircase_railed',
    'staircase_open'
];

export function normalizeRot(rot: number): Rotation {
    return (((Math.round(rot) % 4) + 4) % 4) as Rotation;
}

// Поворот 2D-вектора (x, z) вокруг оси Y по часовой стрелке на rot * 90 градусов:
// rot=0: Север (-Z), rot=1: Восток (+X), rot=2: Юг (+Z), rot=3: Запад (-X)
export function rotateVec2D(x: number, z: number, rot: Rotation): { x: number; z: number } {
    const r = normalizeRot(rot);
    if (r === 0) return { x, z };
    if (r === 1) return { x: -z, z: x };
    if (r === 2) return { x: -x, z: -z };
    return { x: z, z: -x };
}

export function rotateGridOffset(
    dx: number,
    dy: number,
    dz: number,
    rot: Rotation
): { dx: number; dy: number; dz: number } {
    const rotated = rotateVec2D(dx, dz, rot);
    return {
        dx: Math.round(rotated.x),
        dy: Math.round(dy),
        dz: Math.round(rotated.z)
    };
}

// Смещение соседней клетки через грань rot (0=N/-Z, 1=E/+X, 2=S/+Z, 3=W/-X)
export function getEdgeDelta(rot: Rotation): { dx: number; dz: number; oppositeRot: Rotation } {
    const r = normalizeRot(rot);
    if (r === 0) return { dx: 0, dz: -1, oppositeRot: 2 };
    if (r === 1) return { dx: 1, dz: 0, oppositeRot: 3 };
    if (r === 2) return { dx: 0, dz: 1, oppositeRot: 0 };
    return { dx: -1, dz: 0, oppositeRot: 1 };
}

export function rotToRadians(rot: Rotation): number {
    // rot=0 (N, -Z) -> 0; rot=1 (E, +X) -> -PI/2; rot=2 (S, +Z) -> PI; rot=3 (W, -X) -> PI/2
    const r = normalizeRot(rot);
    return -r * (Math.PI * 0.5);
}

export function cellKey(x: number, y: number, z: number): string {
    return `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
}

export function parseCellKey(key: string): GridCell {
    const parts = key.split(',');
    return {
        x: Number.parseInt(parts[0], 10) || 0,
        y: Number.parseInt(parts[1], 10) || 0,
        z: Number.parseInt(parts[2], 10) || 0
    };
}

export function chunkCoordForCell(coord: number): number {
    return Math.floor(coord / BUILDING_CHUNK_SIZE);
}

export function chunkKeyForCell(x: number, z: number): string {
    return `${chunkCoordForCell(x)},${chunkCoordForCell(z)}`;
}

export function worldToGridCell(
    wx: number,
    wy: number,
    wz: number,
    groundY = 0
): GridCell {
    const x = Math.round(wx / CELL_SIZE);
    const z = Math.round(wz / CELL_SIZE);
    const relY = Math.max(0, wy - groundY - FOUND_HEIGHT * 0.5);
    const y = Math.max(0, Math.floor((relY + 0.15) / WALL_HEIGHT));
    return { x, y, z };
}

export function cellToWorldBase(cell: GridCell, baseY = 0): { x: number; y: number; z: number } {
    return {
        x: cell.x * CELL_SIZE,
        y: baseY + FOUND_HEIGHT + cell.y * WALL_HEIGHT,
        z: cell.z * CELL_SIZE
    };
}

// Вычисляет точную мировую позицию и угол поворота префаба внутри клетки (x, y, z)
export function getPieceWorldTransform(
    piece: Pick<Piece, 'type' | 'rot' | 'baseY' | 'sunkInFoundation'>,
    cell: GridCell,
    fallbackBaseY = 0
): { position: { x: number; y: number; z: number }; rotationY: number } {
    const def = PIECE_CATALOG[piece.type];
    const baseY = typeof piece.baseY === 'number' && Number.isFinite(piece.baseY)
        ? piece.baseY
        : fallbackBaseY;
    const centerX = cell.x * CELL_SIZE;
    const centerZ = cell.z * CELL_SIZE;
    const rot = normalizeRot(piece.rot);
    const rotationY = rotToRadians(rot);

    if (def.category === 'foundation') {
        return {
            position: {
                x: centerX,
                y: baseY + cell.y * WALL_HEIGHT,
                z: centerZ
            },
            rotationY
        };
    }

    if (def.category === 'wall') {
        const edgeVec = rotateVec2D(0, -WALL_EDGE_OFFSET, rot);
        return {
            position: {
                x: centerX + edgeVec.x,
                y: baseY + FOUND_HEIGHT + cell.y * WALL_HEIGHT,
                z: centerZ + edgeVec.z
            },
            rotationY
        };
    }

    if (def.category === 'ceiling') {
        return {
            position: {
                x: centerX,
                y: baseY + FOUND_HEIGHT + (cell.y + 1) * WALL_HEIGHT,
                z: centerZ
            },
            rotationY
        };
    }

    // stairs ('staircase_railed' | 'staircase_open')
    // Если лестница прикреплена сбоку к фундаменту (входной трап на фундамент с земли),
    // она утапливается вниз (до уровня настила фундамента baseY + FOUND_HEIGHT) и внутрь края фундамента,
    // не изменяя при этом рельеф (террейн).
    if (piece.sunkInFoundation) {
        const sinkVec = rotateVec2D(0, -FOUND_STAIR_SINK_OFFSET, rot);
        return {
            position: {
                x: centerX + sinkVec.x,
                y: baseY + FOUND_HEIGHT - WALL_HEIGHT - 0.02,
                z: centerZ + sinkVec.z
            },
            rotationY
        };
    }

    return {
        position: {
            x: centerX,
            y: baseY + FOUND_HEIGHT + cell.y * WALL_HEIGHT,
            z: centerZ
        },
        rotationY
    };
}

// Сокеты для фундамента:
// - 4 боковых сокета ('foundation_side') для примагничивания соседних фундаментов в сетке
// - 4 краевых сокета ('wall_bottom') по периметру плиты («здесь может стоять стена»)
// - 4 краевых сокета ('foundation_stair') по торцам плиты для входной лестницы с утапливанием в фундамент
// - 1 центральный сокет ('stair_bottom') на настиле («здесь можно поставить межэтажную лестницу»)
const FOUNDATION_SOCKETS: SocketDef[] = [
    // Боковые сокеты для расширения фундамента
    {
        id: 'found_side_n',
        label: 'СОКЕТ ФУНДАМЕНТА (С)',
        type: 'foundation_side',
        position: { x: 0, y: FOUND_HEIGHT * 0.5, z: -CELL_SIZE * 0.5 },
        direction: { x: 0, y: 0, z: -1 },
        cellOffset: { dx: 0, dy: 0, dz: -1 },
        compatibleCategories: ['foundation'],
        compatibleTypes: ['foundation'],
        rotRule: 'free'
    },
    {
        id: 'found_side_e',
        label: 'СОКЕТ ФУНДАМЕНТА (В)',
        type: 'foundation_side',
        position: { x: CELL_SIZE * 0.5, y: FOUND_HEIGHT * 0.5, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        cellOffset: { dx: 1, dy: 0, dz: 0 },
        compatibleCategories: ['foundation'],
        compatibleTypes: ['foundation'],
        rotRule: 'free'
    },
    {
        id: 'found_side_s',
        label: 'СОКЕТ ФУНДАМЕНТА (Ю)',
        type: 'foundation_side',
        position: { x: 0, y: FOUND_HEIGHT * 0.5, z: CELL_SIZE * 0.5 },
        direction: { x: 0, y: 0, z: 1 },
        cellOffset: { dx: 0, dy: 0, dz: 1 },
        compatibleCategories: ['foundation'],
        compatibleTypes: ['foundation'],
        rotRule: 'free'
    },
    {
        id: 'found_side_w',
        label: 'СОКЕТ ФУНДАМЕНТА (З)',
        type: 'foundation_side',
        position: { x: -CELL_SIZE * 0.5, y: FOUND_HEIGHT * 0.5, z: 0 },
        direction: { x: -1, y: 0, z: 0 },
        cellOffset: { dx: -1, dy: 0, dz: 0 },
        compatibleCategories: ['foundation'],
        compatibleTypes: ['foundation'],
        rotRule: 'free'
    },
    // 4 сокета под установку стен по краям фундамента
    {
        id: 'found_wall_n',
        label: 'ПАЗ СТЕНЫ (СЕВЕР)',
        type: 'wall_bottom',
        position: { x: 0, y: FOUND_HEIGHT, z: -WALL_EDGE_OFFSET },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 0, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'edge',
        localEdgeRot: 0
    },
    {
        id: 'found_wall_e',
        label: 'ПАЗ СТЕНЫ (ВОСТОК)',
        type: 'wall_bottom',
        position: { x: WALL_EDGE_OFFSET, y: FOUND_HEIGHT, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 0, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'edge',
        localEdgeRot: 1
    },
    {
        id: 'found_wall_s',
        label: 'ПАЗ СТЕНЫ (ЮГ)',
        type: 'wall_bottom',
        position: { x: 0, y: FOUND_HEIGHT, z: WALL_EDGE_OFFSET },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 0, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'edge',
        localEdgeRot: 2
    },
    {
        id: 'found_wall_w',
        label: 'ПАЗ СТЕНЫ (ЗАПАД)',
        type: 'wall_bottom',
        position: { x: -WALL_EDGE_OFFSET, y: FOUND_HEIGHT, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 0, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'edge',
        localEdgeRot: 3
    },
    // 4 торцевых сокета для прикрепления входной лестницы с утапливанием в фундамент
    {
        id: 'found_stair_n',
        label: 'ТРАП К ФУНДАМЕНТУ (СЕВЕР)',
        type: 'foundation_stair',
        position: { x: 0, y: FOUND_HEIGHT * 0.65, z: -CELL_SIZE * 0.5 },
        direction: { x: 0, y: 0, z: -1 },
        cellOffset: { dx: 0, dy: 0, dz: -1 },
        compatibleCategories: ['stairs'],
        compatibleTypes: STAIR_TYPES,
        rotRule: 'edge',
        localEdgeRot: 2
    },
    {
        id: 'found_stair_e',
        label: 'ТРАП К ФУНДАМЕНТУ (ВОСТОК)',
        type: 'foundation_stair',
        position: { x: CELL_SIZE * 0.5, y: FOUND_HEIGHT * 0.65, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        cellOffset: { dx: 1, dy: 0, dz: 0 },
        compatibleCategories: ['stairs'],
        compatibleTypes: STAIR_TYPES,
        rotRule: 'edge',
        localEdgeRot: 3
    },
    {
        id: 'found_stair_s',
        label: 'ТРАП К ФУНДАМЕНТУ (ЮГ)',
        type: 'foundation_stair',
        position: { x: 0, y: FOUND_HEIGHT * 0.65, z: CELL_SIZE * 0.5 },
        direction: { x: 0, y: 0, z: 1 },
        cellOffset: { dx: 0, dy: 0, dz: 1 },
        compatibleCategories: ['stairs'],
        compatibleTypes: STAIR_TYPES,
        rotRule: 'edge',
        localEdgeRot: 0
    },
    {
        id: 'found_stair_w',
        label: 'ТРАП К ФУНДАМЕНТУ (ЗАПАД)',
        type: 'foundation_stair',
        position: { x: -CELL_SIZE * 0.5, y: FOUND_HEIGHT * 0.65, z: 0 },
        direction: { x: -1, y: 0, z: 0 },
        cellOffset: { dx: -1, dy: 0, dz: 0 },
        compatibleCategories: ['stairs'],
        compatibleTypes: STAIR_TYPES,
        rotRule: 'edge',
        localEdgeRot: 1
    },
    // Центральный сокет для межэтажного лестничного марша
    {
        id: 'found_stair_center',
        label: 'ОПОРА ЛЕСТНИЦЫ',
        type: 'stair_bottom',
        position: { x: 0, y: FOUND_HEIGHT, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 0, dz: 0 },
        compatibleCategories: ['stairs'],
        compatibleTypes: STAIR_TYPES,
        rotRule: 'free'
    }
];

// Сокеты для стены (при rot = 0 стена стоит на северной грани z = -WALL_EDGE_OFFSET):
// - верхний шип ('wall_top') для установки стены следующего этажа (dy = +1)
// - внутренний и внешний верхние сокеты ('ceiling_support') («здесь можно положить потолок»)
// - боковые замки ('wall_side') для продолжения стены влево/вправо
const WALL_SOCKETS: SocketDef[] = [
    {
        id: 'wall_top_stack',
        label: 'ВЕРХНИЙ ШИП СТЕНЫ',
        type: 'wall_top',
        position: { x: 0, y: WALL_HEIGHT, z: -WALL_EDGE_OFFSET },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 1, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'same'
    },
    {
        id: 'wall_ceiling_in',
        label: 'ОПОРА ПОТОЛКА (ВНУТР.)',
        type: 'ceiling_support',
        position: { x: 0, y: WALL_HEIGHT, z: -WALL_EDGE_OFFSET * 0.45 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 0, dz: 0 },
        compatibleCategories: ['ceiling'],
        compatibleTypes: ['ceiling'],
        rotRule: 'free'
    },
    {
        id: 'wall_ceiling_out',
        label: 'ОПОРА ПОТОЛКА (ВНЕШ.)',
        type: 'ceiling_support',
        position: { x: 0, y: WALL_HEIGHT, z: -CELL_SIZE + WALL_EDGE_OFFSET * 0.45 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 0, dz: -1 },
        compatibleCategories: ['ceiling'],
        compatibleTypes: ['ceiling'],
        rotRule: 'free'
    },
    {
        id: 'wall_side_left',
        label: 'ТОРЦЕВОЙ ЗАМОК (ЛЕВ.)',
        type: 'wall_side',
        position: { x: -CELL_SIZE, y: WALL_HEIGHT * 0.5, z: -WALL_EDGE_OFFSET },
        direction: { x: -1, y: 0, z: 0 },
        cellOffset: { dx: -1, dy: 0, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'same'
    },
    {
        id: 'wall_side_right',
        label: 'ТОРЦЕВОЙ ЗАМОК (ПРАВ.)',
        type: 'wall_side',
        position: { x: CELL_SIZE, y: WALL_HEIGHT * 0.5, z: -WALL_EDGE_OFFSET },
        direction: { x: 1, y: 0, z: 0 },
        cellOffset: { dx: 1, dy: 0, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'same'
    }
];

// Сокеты для потолка (перекрытия):
// - 4 боковых торца ('ceiling_edge') для стыковки соседних потолков на том же ярусе
// - 4 верхних краевых паза ('wall_bottom') для возведения стен следующего этажа (dy = +1)
// - 1 центральный сокет ('stair_bottom') для установки лестницы на следующий этаж (dy = +1)
const CEILING_SOCKETS: SocketDef[] = [
    {
        id: 'ceil_edge_n',
        label: 'ТОРЕЦ ПЕРЕКРЫТИЯ (С)',
        type: 'ceiling_edge',
        position: { x: 0, y: WALL_HEIGHT, z: -CELL_SIZE * 0.5 },
        direction: { x: 0, y: 0, z: -1 },
        cellOffset: { dx: 0, dy: 0, dz: -1 },
        compatibleCategories: ['ceiling'],
        compatibleTypes: ['ceiling'],
        rotRule: 'free'
    },
    {
        id: 'ceil_edge_e',
        label: 'ТОРЕЦ ПЕРЕКРЫТИЯ (В)',
        type: 'ceiling_edge',
        position: { x: CELL_SIZE * 0.5, y: WALL_HEIGHT, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        cellOffset: { dx: 1, dy: 0, dz: 0 },
        compatibleCategories: ['ceiling'],
        compatibleTypes: ['ceiling'],
        rotRule: 'free'
    },
    {
        id: 'ceil_edge_s',
        label: 'ТОРЕЦ ПЕРЕКРЫТИЯ (Ю)',
        type: 'ceiling_edge',
        position: { x: 0, y: WALL_HEIGHT, z: CELL_SIZE * 0.5 },
        direction: { x: 0, y: 0, z: 1 },
        cellOffset: { dx: 0, dy: 0, dz: 1 },
        compatibleCategories: ['ceiling'],
        compatibleTypes: ['ceiling'],
        rotRule: 'free'
    },
    {
        id: 'ceil_edge_w',
        label: 'ТОРЕЦ ПЕРЕКРЫТИЯ (З)',
        type: 'ceiling_edge',
        position: { x: -CELL_SIZE * 0.5, y: WALL_HEIGHT, z: 0 },
        direction: { x: -1, y: 0, z: 0 },
        cellOffset: { dx: -1, dy: 0, dz: 0 },
        compatibleCategories: ['ceiling'],
        compatibleTypes: ['ceiling'],
        rotRule: 'free'
    },
    // Стыковочные пазы под стены верхнего яруса (dy = +1)
    {
        id: 'ceil_wall_n',
        label: 'ПАЗ СТЕНЫ 2-ГО ЯРУСА (С)',
        type: 'wall_bottom',
        position: { x: 0, y: WALL_HEIGHT, z: -WALL_EDGE_OFFSET },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 1, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'edge',
        localEdgeRot: 0
    },
    {
        id: 'ceil_wall_e',
        label: 'ПАЗ СТЕНЫ 2-ГО ЯРУСА (В)',
        type: 'wall_bottom',
        position: { x: WALL_EDGE_OFFSET, y: WALL_HEIGHT, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 1, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'edge',
        localEdgeRot: 1
    },
    {
        id: 'ceil_wall_s',
        label: 'ПАЗ СТЕНЫ 2-ГО ЯРУСА (Ю)',
        type: 'wall_bottom',
        position: { x: 0, y: WALL_HEIGHT, z: WALL_EDGE_OFFSET },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 1, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'edge',
        localEdgeRot: 2
    },
    {
        id: 'ceil_wall_w',
        label: 'ПАЗ СТЕНЫ 2-ГО ЯРУСА (З)',
        type: 'wall_bottom',
        position: { x: -WALL_EDGE_OFFSET, y: WALL_HEIGHT, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 1, dz: 0 },
        compatibleCategories: ['wall'],
        compatibleTypes: WALL_TYPES,
        rotRule: 'edge',
        localEdgeRot: 3
    },
    {
        id: 'ceil_stair_top',
        label: 'ОПОРА ЛЕСТНИЦЫ ВЕРХНЕГО ЯРУСА',
        type: 'stair_bottom',
        position: { x: 0, y: WALL_HEIGHT, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 1, dz: 0 },
        compatibleCategories: ['stairs'],
        compatibleTypes: STAIR_TYPES,
        rotRule: 'free'
    }
];

// Сокеты для лестницы (при rot = 0 марш поднимается с +Z к верхней площадке на -Z):
// - выход с верхней площадки ('ceiling_support') позволяет пристегнуть потолок впереди (dz = -1)
// - продолжение лестницы вверх ('stair_top') на следующий этаж (dy = +1)
const STAIR_SOCKETS: SocketDef[] = [
    {
        id: 'stair_landing_ceiling_ahead',
        label: 'ПЛОЩАДКА ВЫХОДА (ПЕРЕКРЫТИЕ)',
        type: 'ceiling_support',
        position: { x: 0, y: WALL_HEIGHT, z: -CELL_SIZE * 0.5 },
        direction: { x: 0, y: 0, z: -1 },
        cellOffset: { dx: 0, dy: 0, dz: -1 },
        compatibleCategories: ['ceiling'],
        compatibleTypes: ['ceiling'],
        rotRule: 'free'
    },
    {
        id: 'stair_stack_up',
        label: 'ВЕРХНИЙ МАРШ ЛЕСТНИЦЫ',
        type: 'stair_top',
        position: { x: 0, y: WALL_HEIGHT, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
        cellOffset: { dx: 0, dy: 1, dz: 0 },
        compatibleCategories: ['stairs'],
        compatibleTypes: STAIR_TYPES,
        rotRule: 'same'
    }
];

export const PIECE_CATALOG: Record<PieceType, PieceDef> = {
    foundation: {
        type: 'foundation',
        name: 'ФУНДАМЕНТ',
        shortName: 'ФУНД.',
        description: 'Железобетонная плита 3.2×3.2 м с угловыми быками, рифленым настилом и люком',
        hotkey: '1',
        category: 'foundation',
        size: { x: 1, y: 1, z: 1 },
        dimensions: { width: MODULE_WIDTH, height: FOUND_HEIGHT, depth: MODULE_DEPTH },
        requiresGround: true,
        sockets: FOUNDATION_SOCKETS
    },
    solid_wall: {
        type: 'solid_wall',
        name: 'ГЛУХАЯ СТЕНА',
        shortName: 'СТЕНА',
        description: 'Профилированная бронестена 3.2×3.0 м с контрфорсами и ребрами жесткости',
        hotkey: '2',
        category: 'wall',
        size: { x: 1, y: 1, z: 1 },
        dimensions: { width: MODULE_WIDTH, height: WALL_HEIGHT, depth: WALL_THICK },
        requiresGround: false,
        sockets: WALL_SOCKETS
    },
    window_wall: {
        type: 'window_wall',
        name: 'СТЕНА С ОКНОМ',
        shortName: 'ОКНО',
        description: 'Бронированный оконный проем со скошенными откосами, импостом и бронестеклом',
        hotkey: '3',
        category: 'wall',
        size: { x: 1, y: 1, z: 1 },
        dimensions: { width: MODULE_WIDTH, height: WALL_HEIGHT, depth: WALL_THICK },
        requiresGround: false,
        sockets: WALL_SOCKETS
    },
    door_wall: {
        type: 'door_wall',
        name: 'ГЕРМОДВЕРЬ',
        shortName: 'ДВЕРЬ',
        description: 'Тяжелый гермошлюз с портальной коробкой, гидроприводом и смотровым окном',
        hotkey: '4',
        category: 'wall',
        size: { x: 1, y: 1, z: 1 },
        dimensions: { width: MODULE_WIDTH, height: WALL_HEIGHT, depth: WALL_THICK },
        requiresGround: false,
        sockets: WALL_SOCKETS
    },
    ceiling: {
        type: 'ceiling',
        name: 'ПОТОЛОК',
        shortName: 'ПОТОЛ.',
        description: 'Силовая плита перекрытия 3.2×3.2 м с двутавровыми балками и рифленым настилом',
        hotkey: '5',
        category: 'ceiling',
        size: { x: 1, y: 1, z: 1 },
        dimensions: { width: MODULE_WIDTH, height: CEILING_THICK, depth: MODULE_DEPTH },
        requiresGround: false,
        sockets: CEILING_SOCKETS
    },
    staircase_railed: {
        type: 'staircase_railed',
        name: 'ЛЕСТНИЦА С ПЕРИЛАМИ',
        shortName: 'ЛЕСТН.',
        description: 'Марш на зубчатых косоурах с верхней площадкой, подкосами и ограждением',
        hotkey: '6',
        category: 'stairs',
        size: { x: 1, y: 1, z: 1 },
        dimensions: { width: 1.8, height: WALL_HEIGHT, depth: MODULE_DEPTH },
        requiresGround: false,
        sockets: STAIR_SOCKETS
    },
    staircase_open: {
        type: 'staircase_open',
        name: 'ОТКРЫТЫЙ МАРШ',
        shortName: 'МАРШ',
        description: 'Открытый индустриальный лестничный марш с боковыми отбортовками ступеней',
        hotkey: '7',
        category: 'stairs',
        size: { x: 1, y: 1, z: 1 },
        dimensions: { width: 1.8, height: WALL_HEIGHT, depth: MODULE_DEPTH },
        requiresGround: false,
        sockets: STAIR_SOCKETS
    }
};

export function getPieceDef(typeOrDef: PieceType | PieceDef): PieceDef {
    if (typeof typeOrDef === 'string') {
        const def = PIECE_CATALOG[typeOrDef];
        if (!def) throw new Error(`Unknown PieceType: ${typeOrDef}`);
        return def;
    }
    return typeOrDef;
}

export function isSocketCompatible(socket: { compatibleCategories: PieceCategory[]; compatibleTypes: PieceType[] }, def: PieceDef): boolean {
    return socket.compatibleTypes.includes(def.type) || socket.compatibleCategories.includes(def.category);
}
