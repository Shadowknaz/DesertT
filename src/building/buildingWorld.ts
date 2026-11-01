// Чистая модель данных строительного мира (отдельно от графики Three.js).
// Хранит мир как Map<string, Piece[]> по целочисленным координатам сетки "x,y,z",
// вычисляет мировые сокеты построенных частей, выполняет валидацию в одной функции
// canPlace(def, cell, rot) и ищет ближайший совместимый сокет для примагничивания призрака.
import {
    CELL_SIZE,
    FOUND_HEIGHT,
    MAX_BUILD_DISTANCE,
    PIECE_CATALOG,
    SOCKET_SNAP_RADIUS,
    WALL_HEIGHT,
    cellKey,
    chunkKeyForCell,
    getEdgeDelta,
    getPieceDef,
    getPieceWorldTransform,
    isSocketCompatible,
    normalizeRot,
    parseCellKey,
    rotateGridOffset,
    rotateVec2D,
    worldToGridCell
} from './catalog.ts';
import type {
    GridCell,
    Piece,
    PieceDef,
    PieceType,
    PlacementValidation,
    Rotation,
    WorldSocket
} from './types.ts';

export type GroundHeightFn = (wx: number, wz: number) => number;

let _activeWorldInstance: World | null = null;

export class World {
    // Мир хранится как Map<string, Piece[]> по ключу "x,y,z" в целочисленных координатах сетки
    public readonly cells = new Map<string, Piece[]>();
    private readonly dirtyChunks = new Set<string>();
    private groundHeightFn: GroundHeightFn;
    private builderOrigin: { x: number; y: number; z: number } | null = null;
    private maxBuildDistance: number = MAX_BUILD_DISTANCE;

    constructor(groundHeightFn: GroundHeightFn = () => 0) {
        this.groundHeightFn = groundHeightFn;
        _activeWorldInstance = this;
    }

    public setGroundHeightFn(fn: GroundHeightFn): void {
        this.groundHeightFn = fn;
    }

    public setBuilderPosition(
        origin: { x: number; y: number; z: number } | null,
        maxDistance: number = MAX_BUILD_DISTANCE
    ): void {
        this.builderOrigin = origin ? { x: origin.x, y: origin.y, z: origin.z } : null;
        if (Number.isFinite(maxDistance) && maxDistance > 0) {
            this.maxBuildDistance = maxDistance;
        }
    }

    public getBuilderPosition(): { x: number; y: number; z: number } | null {
        return this.builderOrigin ? { ...this.builderOrigin } : null;
    }

    public getMaxBuildDistance(): number {
        return this.maxBuildDistance;
    }

    public isStairSunkInFoundation(cell: GridCell, rot: number, piece?: Piece): boolean {
        if (piece && typeof piece.sunkInFoundation === 'boolean') {
            return piece.sunkInFoundation;
        }
        if (Math.round(cell.y) !== 0) return false;
        const x = Math.round(cell.x);
        const z = Math.round(cell.z);
        if (this.hasCategoryInCell(x, 0, z, 'foundation')) return false;
        const { dx, dz } = getEdgeDelta(normalizeRot(rot));
        return this.hasCategoryInCell(x + dx, 0, z + dz, 'foundation');
    }

    public getPlacementDistance(
        defOrType: PieceDef | PieceType,
        cell: GridCell,
        rot: number = 0,
        explicitBaseY?: number
    ): number {
        if (!this.builderOrigin) return 0;
        const def = getPieceDef(defOrType);
        const r = normalizeRot(rot);
        const baseY = this.resolveBaseY(cell, explicitBaseY);
        const sunkInFoundation = def.category === 'stairs' && this.isStairSunkInFoundation(cell, r);
        const tf = getPieceWorldTransform({ type: def.type, rot: r, baseY, sunkInFoundation }, cell, baseY);
        const dx = tf.position.x - this.builderOrigin.x;
        const dy = (tf.position.y - this.builderOrigin.y) * 0.6;
        const dz = tf.position.z - this.builderOrigin.z;
        return Math.hypot(dx, dy, dz);
    }

    public sampleGroundY(wx: number, wz: number): number {
        const y = this.groundHeightFn(wx, wz);
        return Number.isFinite(y) ? y : 0;
    }

    public getCell(x: number, y: number, z: number): Piece[] {
        return this.cells.get(cellKey(x, y, z)) || [];
    }

    public getCellByCoord(cell: GridCell): Piece[] {
        return this.getCell(cell.x, cell.y, cell.z);
    }

    public getTotalPieceCount(): number {
        let count = 0;
        for (const list of this.cells.values()) {
            count += list.length;
        }
        return count;
    }

    public getDirtyChunks(): string[] {
        return Array.from(this.dirtyChunks);
    }

    public clearDirtyChunk(chunkKey: string): void {
        this.dirtyChunks.delete(chunkKey);
    }

    public markChunkDirtyForCell(x: number, z: number): void {
        this.dirtyChunks.add(chunkKeyForCell(x, z));
    }

    // Определяет базовую высоту baseY (уровень земли под фундаментом) для клетки (x, y, z),
    // наследуя её от существующих или соседних элементов для идеальной стыковки по высоте.
    public resolveBaseY(cell: GridCell, explicitBaseY?: number): number {
        if (typeof explicitBaseY === 'number' && Number.isFinite(explicitBaseY)) {
            return explicitBaseY;
        }
        // 1. Проверяем текущую колонку (x, *, z)
        for (let cy = 0; cy <= cell.y + 1; cy++) {
            const pieces = this.getCell(cell.x, cy, cell.z);
            for (const p of pieces) {
                if (typeof p.baseY === 'number' && Number.isFinite(p.baseY)) {
                    return p.baseY;
                }
            }
        }
        // 2. Проверяем соседние клетки по горизонтали (для примагничивания фундамента/стен/потолков)
        const dirs = [
            { dx: 0, dz: -1 },
            { dx: 1, dz: 0 },
            { dx: 0, dz: 1 },
            { dx: -1, dz: 0 }
        ];
        for (const { dx, dz } of dirs) {
            for (let cy = 0; cy <= cell.y; cy++) {
                const neighborPieces = this.getCell(cell.x + dx, cy, cell.z + dz);
                for (const p of neighborPieces) {
                    if (typeof p.baseY === 'number' && Number.isFinite(p.baseY)) {
                        return p.baseY;
                    }
                }
            }
        }
        // 3. Берем высоту рельефа в центре клетки
        return this.sampleGroundY(cell.x * CELL_SIZE, cell.z * CELL_SIZE);
    }

    // Проверяет, есть ли на указанной грани клетки (x, y, z, rot) стена (в самой клетке или на смежной грани соседа)
    public hasWallOnEdge(x: number, y: number, z: number, rot: Rotation): boolean {
        const r = normalizeRot(rot);
        const pieces = this.getCell(x, y, z);
        for (const p of pieces) {
            const pDef = PIECE_CATALOG[p.type];
            if (pDef.category === 'wall' && normalizeRot(p.rot) === r) {
                return true;
            }
        }
        const { dx, dz, oppositeRot } = getEdgeDelta(r);
        const neighborPieces = this.getCell(x + dx, y, z + dz);
        for (const p of neighborPieces) {
            const pDef = PIECE_CATALOG[p.type];
            if (pDef.category === 'wall' && normalizeRot(p.rot) === oppositeRot) {
                return true;
            }
        }
        return false;
    }

    public hasCategoryInCell(x: number, y: number, z: number, category: PieceDef['category']): boolean {
        const pieces = this.getCell(x, y, z);
        return pieces.some(p => PIECE_CATALOG[p.type].category === category);
    }

    // Генерирует все мировые сокеты для одного размещенного элемента
    public getSocketsForPiece(cell: GridCell, piece: Piece): WorldSocket[] {
        const def = PIECE_CATALOG[piece.type];
        // Утопленная в фундамент входная лестница ведет с земли на настил фундамента (y=0) и не порождает сокетов 2-го этажа
        if (def.category === 'stairs' && piece.sunkInFoundation) {
            return [];
        }
        const baseY = this.resolveBaseY(cell, piece.baseY);
        const centerX = cell.x * CELL_SIZE;
        const centerZ = cell.z * CELL_SIZE;
        const storyBaseY = def.category === 'foundation'
            ? baseY + cell.y * WALL_HEIGHT
            : baseY + FOUND_HEIGHT + cell.y * WALL_HEIGHT;

        const rot = normalizeRot(piece.rot);
        const result: WorldSocket[] = [];

        for (const sock of def.sockets) {
            const rotPos = rotateVec2D(sock.position.x, sock.position.z, rot);
            const rotDir = rotateVec2D(sock.direction.x, sock.direction.z, rot);
            const rotCellOff = rotateGridOffset(
                sock.cellOffset.dx,
                sock.cellOffset.dy,
                sock.cellOffset.dz,
                rot
            );

            let recommendedRot: Rotation = rot;
            if (sock.rotRule === 'edge' && sock.localEdgeRot !== undefined) {
                recommendedRot = normalizeRot(sock.localEdgeRot + rot);
            } else if (sock.rotRule === 'same') {
                recommendedRot = rot;
            }

            result.push({
                id: `${cellKey(cell.x, cell.y, cell.z)}:${piece.type}:${rot}:${sock.id}`,
                label: sock.label,
                type: sock.type,
                sourceCell: { ...cell },
                sourcePiece: piece,
                targetCell: {
                    x: cell.x + rotCellOff.dx,
                    y: cell.y + rotCellOff.dy,
                    z: cell.z + rotCellOff.dz
                },
                recommendedRot,
                rotRule: sock.rotRule,
                worldPos: {
                    x: centerX + rotPos.x,
                    y: storyBaseY + sock.position.y,
                    z: centerZ + rotPos.z
                },
                worldDir: {
                    x: rotDir.x,
                    y: sock.direction.y,
                    z: rotDir.z
                },
                compatibleCategories: sock.compatibleCategories,
                compatibleTypes: sock.compatibleTypes,
                baseY
            });
        }

        return result;
    }

    // Возвращает все сокеты в окрестности клетки (centerCell) радиусом radiusCells
    public getNearbySockets(centerCell: GridCell, radiusCells = 2): WorldSocket[] {
        const sockets: WorldSocket[] = [];
        for (let dx = -radiusCells; dx <= radiusCells; dx++) {
            for (let dz = -radiusCells; dz <= radiusCells; dz++) {
                for (let dy = -1; dy <= 2; dy++) {
                    const cy = centerCell.y + dy;
                    if (cy < 0) continue;
                    const c = { x: centerCell.x + dx, y: cy, z: centerCell.z + dz };
                    const pieces = this.getCellByCoord(c);
                    for (const piece of pieces) {
                        sockets.push(...this.getSocketsForPiece(c, piece));
                    }
                }
            }
        }
        return sockets;
    }

    // Полная валидация размещения:
    // 1. Клетка свободна и нет пересечений (коллизий слотов/граней)
    // 2. Есть опора (земля для фундамента, несущая конструкция для остальных)
    // 3. Есть совместимый соседний сокет нужного типа
    public validatePlacement(
        defOrType: PieceDef | PieceType,
        cell: GridCell,
        rot: number = 0
    ): PlacementValidation {
        const def = getPieceDef(defOrType);
        const r = normalizeRot(rot);
        const x = Math.round(cell.x);
        const y = Math.round(cell.y);
        const z = Math.round(cell.z);
        const normCell: GridCell = { x, y, z };

        if (y < 0) {
            return {
                valid: false,
                reason: 'invalid_level',
                message: 'НЕДОПУСТИМЫЙ УРОВЕНЬ НИЖЕ ЗЕМЛИ',
                matchedSocket: null
            };
        }

        // --- 0. ПРОВЕРКА ДИСТАНЦИИ СТРОИТЕЛЬСТВА ОТ ИГРОКА/МЕХА ---
        if (this.builderOrigin) {
            const dist = this.getPlacementDistance(def, normCell, r);
            if (dist > this.maxBuildDistance) {
                return {
                    valid: false,
                    reason: 'too_far',
                    message: `СЛИШКОМ ДАЛЕКО (${dist.toFixed(1)}М > ${this.maxBuildDistance.toFixed(0)}М)`,
                    matchedSocket: null
                };
            }
        }

        const existingInCell = this.getCell(x, y, z);

        // --- 1. ПРОВЕРКА СВОБОДНОСТИ КЛЕТКИ И ОТСУТСТВИЯ ПЕРЕСЕЧЕНИЙ ---
        if (def.category === 'foundation') {
            if (existingInCell.some(p => PIECE_CATALOG[p.type].category === 'foundation' || p.sunkInFoundation)) {
                return {
                    valid: false,
                    reason: 'cell_occupied',
                    message: 'КЛЕТКА ЗАНЯТА: ФУНДАМЕНТ ИЛИ ТРАП УЖЕ УСТАНОВЛЕН',
                    matchedSocket: null
                };
            }
        } else if (def.category === 'wall') {
            if (this.hasWallOnEdge(x, y, z, r)) {
                return {
                    valid: false,
                    reason: 'intersection',
                    message: 'ПЕРЕСЕЧЕНИЕ: ГРАНЬ УЖЕ ЗАНЯТА СТЕНОЙ',
                    matchedSocket: null
                };
            }
        } else if (def.category === 'ceiling') {
            if (existingInCell.some(p => PIECE_CATALOG[p.type].category === 'ceiling')) {
                return {
                    valid: false,
                    reason: 'cell_occupied',
                    message: 'КЛЕТКА ЗАНЯТА: ПОТОЛОК УЖЕ УСТАНОВЛЕН',
                    matchedSocket: null
                };
            }
        } else if (def.category === 'stairs') {
            if (existingInCell.some(p => PIECE_CATALOG[p.type].category === 'stairs')) {
                return {
                    valid: false,
                    reason: 'cell_occupied',
                    message: 'КЛЕТКА ЗАНЯТА: ЛЕСТНИЦА УЖЕ УСТАНОВЛЕНА',
                    matchedSocket: null
                };
            }
        }

        // --- 2. ФУНДАМЕНТ СТАВИТСЯ НА ЗЕМЛЮ (ИЛИ К СОСЕДНЕМУ ФУНДАМЕНТУ НА ЗЕМЛЕ) ---
        if (def.requiresGround) {
            if (y !== 0) {
                return {
                    valid: false,
                    reason: 'no_ground',
                    message: 'ФУНДАМЕНТ СТАВИТСЯ ТОЛЬКО НА ЗЕМЛЮ (Y=0)',
                    matchedSocket: null
                };
            }
            const nearbySockets = this.getNearbySockets(normCell, 1);
            const matched = nearbySockets.find(
                s =>
                    isSocketCompatible(s, def) &&
                    s.targetCell.x === x &&
                    s.targetCell.y === y &&
                    s.targetCell.z === z
            ) || null;

            return {
                valid: true,
                reason: 'ok',
                message: matched ? `ПРИВЯЗКА: ${matched.label}` : 'ОПОРА: ГРУНТ (СЕТКА)',
                matchedSocket: matched
            };
        }

        // --- 3. ВСЕ ОСТАЛЬНЫЕ ЭЛЕМЕНТЫ — ТОЛЬКО К СУЩЕСТВУЮЩИМ ЭЛЕМЕНТАМ (СОКЕТАМ С ОПОРОЙ) ---
        const nearbySockets = this.getNearbySockets(normCell, 1);
        const matchingSockets = nearbySockets.filter(s => {
            if (!isSocketCompatible(s, def)) return false;
            if (s.targetCell.x !== x || s.targetCell.y !== y || s.targetCell.z !== z) {
                return false;
            }
            if ((def.category === 'wall' || s.type === 'foundation_stair') && s.rotRule !== 'free') {
                // Для стен и боковых трапов фундамента проверяем совпадение грани
                if (s.recommendedRot !== r) return false;
            }
            if (def.category === 'stairs' && s.type === 'foundation_stair' && this.hasCategoryInCell(x, 0, z, 'foundation')) {
                // Если в самой клетке уже есть фундамент, используется центральный сокет found_stair_center
                return false;
            }
            return true;
        });

        // Также проверяем случай, когда стена ставится на общей границе двух клеток,
        // а фундамент или нижняя стена находится в смежной через эту грань клетке
        const { dx: edgeDx, dz: edgeDz, oppositeRot } = getEdgeDelta(r);
        if (def.category === 'wall' && matchingSockets.length === 0) {
            const crossCell: GridCell = { x: x + edgeDx, y, z: z + edgeDz };
            const crossSockets = nearbySockets.filter(s => {
                if (!isSocketCompatible(s, def)) return false;
                if (
                    s.targetCell.x === crossCell.x &&
                    s.targetCell.y === crossCell.y &&
                    s.targetCell.z === crossCell.z &&
                    s.recommendedRot === oppositeRot
                ) {
                    return true;
                }
                return false;
            });
            matchingSockets.push(...crossSockets);
        }

        // Поддержка случая, когда потолок ставится на клетку (x, y, z) при наличии стены в смежной клетке на общей грани
        if (def.category === 'ceiling' && matchingSockets.length === 0) {
            for (const rotEdge of [0, 1, 2, 3] as Rotation[]) {
                if (this.hasWallOnEdge(x, y, z, rotEdge)) {
                    const synthSocket: WorldSocket = {
                        id: `shared_wall_ceil_${x}_${y}_${z}_${rotEdge}`,
                        label: 'ОПОРА СМЕЖНОЙ СТЕНЫ',
                        type: 'ceiling_support',
                        sourceCell: { x, y, z },
                        sourcePiece: { type: 'solid_wall', rot: rotEdge, tier: 1 },
                        targetCell: { x, y, z },
                        recommendedRot: r,
                        rotRule: 'free',
                        worldPos: { x: x * CELL_SIZE, y: (y + 1) * WALL_HEIGHT + FOUND_HEIGHT, z: z * CELL_SIZE },
                        worldDir: { x: 0, y: 1, z: 0 },
                        compatibleCategories: ['ceiling'],
                        compatibleTypes: ['ceiling'],
                        baseY: this.resolveBaseY(normCell)
                    };
                    matchingSockets.push(synthSocket);
                    break;
                }
            }
            // Поддержка случая, когда потолок проверяется на (x, y, z) с y > 0 напрямую над стеной/лестницей (x, y-1, z)
            if (matchingSockets.length === 0 && y > 0) {
                const hasBelowSupport =
                    this.hasCategoryInCell(x, y - 1, z, 'wall') ||
                    this.hasCategoryInCell(x, y - 1, z, 'stairs');
                if (hasBelowSupport) {
                    const synthSocket: WorldSocket = {
                        id: `below_wall_ceil_${x}_${y}_${z}`,
                        label: 'ОПОРА НИЖНЕГО ЯРУСА',
                        type: 'ceiling_support',
                        sourceCell: { x, y: y - 1, z },
                        sourcePiece: { type: 'solid_wall', rot: 0, tier: 1 },
                        targetCell: { x, y, z },
                        recommendedRot: r,
                        rotRule: 'free',
                        worldPos: { x: x * CELL_SIZE, y: y * WALL_HEIGHT + FOUND_HEIGHT, z: z * CELL_SIZE },
                        worldDir: { x: 0, y: 1, z: 0 },
                        compatibleCategories: ['ceiling'],
                        compatibleTypes: ['ceiling'],
                        baseY: this.resolveBaseY({ x, y: y - 1, z })
                    };
                    matchingSockets.push(synthSocket);
                }
            }
        }

        if (matchingSockets.length === 0) {
            return {
                valid: false,
                reason: 'no_socket',
                message: 'НЕТ СОВМЕСТИМОГО СОКЕТА ПРИВЯЗКИ',
                matchedSocket: null
            };
        }

        // --- 4. ПРОВЕРКА НЕСУЩЕЙ ОПОРЫ (ПОД ЭЛЕМЕНТОМ ДОЛЖНА БЫТЬ ОПОРА) ---
        let hasSupport = false;
        if (def.category === 'wall') {
            if (y === 0) {
                // Стена 1-го этажа должна опираться на фундамент в своей или смежной через грань клетке
                hasSupport =
                    this.hasCategoryInCell(x, 0, z, 'foundation') ||
                    this.hasCategoryInCell(x + edgeDx, 0, z + edgeDz, 'foundation');
            } else {
                // Стена верхнего этажа должна опираться на стену под ней или на потолок нижнего яруса
                hasSupport =
                    this.hasWallOnEdge(x, y - 1, z, r) ||
                    this.hasCategoryInCell(x, y - 1, z, 'ceiling') ||
                    this.hasCategoryInCell(x + edgeDx, y - 1, z + edgeDz, 'ceiling');
            }
        } else if (def.category === 'ceiling') {
            // Потолок опирается на стены текущего яруса, лестницу или соседний потолок
            const hasWallHere = ([0, 1, 2, 3] as Rotation[]).some(edge => this.hasWallOnEdge(x, y, z, edge));
            const hasStairsHere = this.getCell(x, y, z).some(p => PIECE_CATALOG[p.type].category === 'stairs' && !p.sunkInFoundation);
            const hasNeighborCeiling =
                this.hasCategoryInCell(x + 1, y, z, 'ceiling') ||
                this.hasCategoryInCell(x - 1, y, z, 'ceiling') ||
                this.hasCategoryInCell(x, y, z + 1, 'ceiling') ||
                this.hasCategoryInCell(x, y, z - 1, 'ceiling');
            const hasNeighborStairTop = matchingSockets.some(s => s.type === 'ceiling_support');
            const hasBelowSupport = y > 0 && (
                this.hasCategoryInCell(x, y - 1, z, 'wall') ||
                this.getCell(x, y - 1, z).some(p => PIECE_CATALOG[p.type].category === 'stairs' && !p.sunkInFoundation)
            );
            hasSupport = hasWallHere || hasStairsHere || hasNeighborCeiling || hasNeighborStairTop || hasBelowSupport;
        } else if (def.category === 'stairs') {
            if (y === 0) {
                // Лестница на уровне y=0 может либо стоять на фундаменте в своей клетке (межэтажная),
                // либо цепляться сбоку к фундаменту в соседней по курсу подъема клетке (входной трап с утапливанием в фундамент).
                hasSupport =
                    this.hasCategoryInCell(x, 0, z, 'foundation') ||
                    this.hasCategoryInCell(x + edgeDx, 0, z + edgeDz, 'foundation');
            } else {
                hasSupport =
                    this.hasCategoryInCell(x, y - 1, z, 'ceiling') ||
                    this.getCell(x, y - 1, z).some(p => PIECE_CATALOG[p.type].category === 'stairs' && !p.sunkInFoundation) ||
                    this.hasCategoryInCell(x, y, z, 'ceiling');
            }
        }

        if (!hasSupport) {
            return {
                valid: false,
                reason: 'no_support',
                message: 'НЕТ НЕСУЩЕЙ ОПОРЫ ПОД МОДУЛЕМ',
                matchedSocket: null
            };
        }

        const primarySocket = matchingSockets[0];
        return {
            valid: true,
            reason: 'ok',
            message: `СОКЕТ: ${primarySocket.label}`,
            matchedSocket: primarySocket
        };
    }

    public canPlace(defOrType: PieceDef | PieceType, cell: GridCell, rot: number = 0): boolean {
        return this.validatePlacement(defOrType, cell, rot).valid;
    }

    // Размещает элемент в мире, если canPlace возвращает true
    public placePiece(
        defOrType: PieceDef | PieceType,
        cell: GridCell,
        rot: number = 0,
        tier: number = 1,
        explicitBaseY?: number
    ): Piece | null {
        const def = getPieceDef(defOrType);
        const r = normalizeRot(rot);
        const normCell: GridCell = {
            x: Math.round(cell.x),
            y: Math.round(cell.y),
            z: Math.round(cell.z)
        };

        const validation = this.validatePlacement(def, normCell, r);
        if (!validation.valid) {
            return null;
        }

        const baseY = this.resolveBaseY(
            normCell,
            explicitBaseY ?? validation.matchedSocket?.baseY
        );
        const sunkInFoundation = def.category === 'stairs' && (
            validation.matchedSocket?.type === 'foundation_stair' ||
            this.isStairSunkInFoundation(normCell, r)
        );
        const piece: Piece = {
            type: def.type,
            rot: r,
            tier: Math.max(0, Math.min(2, Math.round(tier))),
            baseY,
            ...(def.type === 'door_wall' ? { isOpen: false, openProgress: 0 } : {}),
            ...(sunkInFoundation ? { sunkInFoundation: true } : {})
        };

        const key = cellKey(normCell.x, normCell.y, normCell.z);
        const list = this.cells.get(key) || [];
        list.push(piece);
        this.cells.set(key, list);

        this.markChunkDirtyForCell(normCell.x, normCell.z);
        return piece;
    }

    // Удаляет конкретный элемент из клетки (или последний добавленный в клетке)
    public removePiece(cell: GridCell, predicate?: (p: Piece) => boolean): Piece | null {
        const key = cellKey(cell.x, cell.y, cell.z);
        const list = this.cells.get(key);
        if (!list || list.length === 0) return null;

        let idx = list.length - 1;
        if (predicate) {
            idx = list.findIndex(predicate);
            if (idx === -1) return null;
        }

        const [removed] = list.splice(idx, 1);
        if (list.length === 0) {
            this.cells.delete(key);
        }
        this.markChunkDirtyForCell(cell.x, cell.z);
        return removed;
    }

    // Возвращает все размещенные гермодвери (door_wall) в мире вместе с их координатами и мировыми трансформациями
    public getAllDoorPieces(): Array<{
        cell: GridCell;
        piece: Piece;
        worldPos: { x: number; y: number; z: number };
        rotationY: number;
    }> {
        const doors: Array<{
            cell: GridCell;
            piece: Piece;
            worldPos: { x: number; y: number; z: number };
            rotationY: number;
        }> = [];
        for (const [key, list] of this.cells.entries()) {
            const cell = parseCellKey(key);
            for (const piece of list) {
                if (piece.type === 'door_wall') {
                    const baseY = this.resolveBaseY(cell, piece.baseY);
                    const tf = getPieceWorldTransform(piece, cell, baseY);
                    doors.push({
                        cell,
                        piece,
                        worldPos: tf.position,
                        rotationY: tf.rotationY
                    });
                }
            }
        }
        return doors;
    }

    // Ищет ближайшую гермодверь (door_wall) к указанной точке мира в пределах maxRadius (по умолчанию 3.4 м)
    public findNearestDoor(
        worldPoint: { x: number; y: number; z: number },
        maxRadius = 3.4
    ): {
        cell: GridCell;
        piece: Piece;
        worldPos: { x: number; y: number; z: number };
        rotationY: number;
        distance: number;
    } | null {
        let best: {
            cell: GridCell;
            piece: Piece;
            worldPos: { x: number; y: number; z: number };
            rotationY: number;
            distance: number;
        } | null = null;
        let bestDist = Infinity;

        for (const [key, list] of this.cells.entries()) {
            const cell = parseCellKey(key);
            for (const piece of list) {
                if (piece.type !== 'door_wall') continue;
                const baseY = this.resolveBaseY(cell, piece.baseY);
                const tf = getPieceWorldTransform(piece, cell, baseY);
                const doorCenterY = tf.position.y + WALL_HEIGHT * 0.45;
                const dx = tf.position.x - worldPoint.x;
                const dy = (doorCenterY - (worldPoint.y + 0.9)) * 0.65;
                const dz = tf.position.z - worldPoint.z;
                const dist = Math.hypot(dx, dy, dz);
                if (dist <= maxRadius && dist < bestDist) {
                    bestDist = dist;
                    best = {
                        cell,
                        piece,
                        worldPos: tf.position,
                        rotationY: tf.rotationY,
                        distance: dist
                    };
                }
            }
        }
        return best;
    }

    // Переключает состояние открытия/закрытия гермодвери в указанной клетке
    public toggleDoorAt(cell: GridCell, rot?: Rotation): Piece | null {
        const list = this.getCell(cell.x, cell.y, cell.z);
        for (const piece of list) {
            if (piece.type === 'door_wall' && (rot === undefined || normalizeRot(piece.rot) === normalizeRot(rot))) {
                piece.isOpen = !piece.isOpen;
                return piece;
            }
        }
        // Проверяем также смежную клетку через общую грань, если rot передан
        if (rot !== undefined) {
            const { dx, dz, oppositeRot } = getEdgeDelta(normalizeRot(rot));
            const neighborList = this.getCell(cell.x + dx, cell.y, cell.z + dz);
            for (const piece of neighborList) {
                if (piece.type === 'door_wall' && normalizeRot(piece.rot) === oppositeRot) {
                    piece.isOpen = !piece.isOpen;
                    return piece;
                }
            }
        }
        return null;
    }

    public setDoorOpenAt(cell: GridCell, isOpen: boolean, rot?: Rotation): Piece | null {
        const list = this.getCell(cell.x, cell.y, cell.z);
        for (const piece of list) {
            if (piece.type === 'door_wall' && (rot === undefined || normalizeRot(piece.rot) === normalizeRot(rot))) {
                piece.isOpen = Boolean(isOpen);
                return piece;
            }
        }
        return null;
    }

    public clear(): void {
        for (const key of this.cells.keys()) {
            const c = parseCellKey(key);
            this.markChunkDirtyForCell(c.x, c.z);
        }
        this.cells.clear();
    }

    // Поиск ближайшего совместимого сокета у уже построенных частей или привязка к сетке
    public findBestSnap(
        defOrType: PieceDef | PieceType,
        worldHitPoint: { x: number; y: number; z: number },
        preferredRot: number = 0,
        snapRadius: number = SOCKET_SNAP_RADIUS
    ): {
        cell: GridCell;
        rot: Rotation;
        baseY: number;
        snappedToSocket: boolean;
        socket: WorldSocket | null;
        validation: PlacementValidation;
        worldPos: { x: number; y: number; z: number };
        rotationY: number;
    } {
        const def = getPieceDef(defOrType);
        const prefRot = normalizeRot(preferredRot);
        const groundY = this.sampleGroundY(worldHitPoint.x, worldHitPoint.z);
        const approxCell = worldToGridCell(worldHitPoint.x, worldHitPoint.y, worldHitPoint.z, groundY);
        if (def.requiresGround) {
            approxCell.y = 0;
        }

        // 1. Ищем все открытые совместимые сокеты построенных объектов поблизости
        const candidateSockets = this.getNearbySockets(approxCell, 2);
        let bestSocket: WorldSocket | null = null;
        let bestRot: Rotation = prefRot;
        let bestValidation: PlacementValidation | null = null;
        let bestScore = Infinity;

        for (const sock of candidateSockets) {
            if (!isSocketCompatible(sock, def)) continue;

            // Определяем ориентацию для проверки на этом сокете
            const testRot: Rotation = sock.rotRule === 'free' ? prefRot : sock.recommendedRot;
            const val = this.validatePlacement(def, sock.targetCell, testRot);
            if (!val.valid) continue;

            const dx = sock.worldPos.x - worldHitPoint.x;
            const dy = (sock.worldPos.y - worldHitPoint.y) * 0.85;
            const dz = sock.worldPos.z - worldHitPoint.z;
            const dist = Math.hypot(dx, dy, dz);

            if (dist <= snapRadius) {
                // Небольшой бонус сокетам, чья ориентация совпадает с выбранной игроком
                const rotPenalty = testRot === prefRot ? 0 : 0.08;
                const score = dist + rotPenalty;
                if (score < bestScore) {
                    bestScore = score;
                    bestSocket = sock;
                    bestRot = testRot;
                    bestValidation = val;
                }
            }
        }

        if (bestSocket && bestValidation) {
            const targetCell = bestSocket.targetCell;
            const baseY = this.resolveBaseY(targetCell, bestSocket.baseY);
            const sunkInFoundation = def.category === 'stairs' && (
                bestSocket.type === 'foundation_stair' ||
                this.isStairSunkInFoundation(targetCell, bestRot)
            );
            const tf = getPieceWorldTransform({ type: def.type, rot: bestRot, baseY, sunkInFoundation }, targetCell, baseY);
            const distance = this.getPlacementDistance(def, targetCell, bestRot, baseY);
            return {
                cell: targetCell,
                rot: bestRot,
                baseY,
                snappedToSocket: true,
                socket: bestSocket,
                validation: bestValidation,
                worldPos: tf.position,
                rotationY: tf.rotationY,
                distance,
                maxDistance: this.maxBuildDistance
            };
        }

        // 2. Если поблизости нет валидного сокета — привязка к целочисленной клетке сетки Math.round(p / cellSize)
        const gridCell: GridCell = {
            x: Math.round(worldHitPoint.x / CELL_SIZE),
            y: def.requiresGround ? 0 : approxCell.y,
            z: Math.round(worldHitPoint.z / CELL_SIZE)
        };

        // Если для стены или входной лестницы в этой клетке на выбранной грани нет опоры, но на другой грани есть сокет — подскажем грань
        let finalRot = prefRot;
        let validation = this.validatePlacement(def, gridCell, finalRot);
        if (!validation.valid && validation.reason !== 'too_far' && (def.category === 'wall' || def.category === 'stairs')) {
            for (const altRot of [0, 1, 2, 3] as Rotation[]) {
                const altVal = this.validatePlacement(def, gridCell, altRot);
                if (altVal.valid) {
                    finalRot = altRot;
                    validation = altVal;
                    break;
                }
            }
        }

        const baseY = this.resolveBaseY(gridCell);
        const sunkInFoundation = def.category === 'stairs' && (
            validation.matchedSocket?.type === 'foundation_stair' ||
            this.isStairSunkInFoundation(gridCell, finalRot)
        );
        const tf = getPieceWorldTransform({ type: def.type, rot: finalRot, baseY, sunkInFoundation }, gridCell, baseY);
        const distance = this.getPlacementDistance(def, gridCell, finalRot, baseY);
        return {
            cell: gridCell,
            rot: finalRot,
            baseY,
            snappedToSocket: Boolean(validation.matchedSocket),
            socket: validation.matchedSocket,
            validation,
            worldPos: tf.position,
            rotationY: tf.rotationY,
            distance,
            maxDistance: this.maxBuildDistance
        };
    }
}

export { World as BuildingWorld };

// Единая функция валидации canPlace(def, cell, rot[, world])
// Поддерживает как вызов canPlace(def, cell, rot), так и canPlace(world, def, cell, rot)
export function canPlace(
    arg1: World | PieceDef | PieceType,
    arg2: PieceDef | PieceType | GridCell,
    arg3?: GridCell | number,
    arg4?: number | World
): boolean {
    if (arg1 instanceof World) {
        const world = arg1;
        const def = arg2 as PieceDef | PieceType;
        const cell = arg3 as GridCell;
        const rot = typeof arg4 === 'number' ? arg4 : 0;
        return world.canPlace(def, cell, rot);
    }
    const def = arg1 as PieceDef | PieceType;
    const cell = arg2 as GridCell;
    const rot = typeof arg3 === 'number' ? arg3 : 0;
    const world = arg4 instanceof World ? arg4 : (_activeWorldInstance || new World());
    return world.canPlace(def, cell, rot);
}
