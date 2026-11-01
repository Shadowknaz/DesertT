// Подсказки управления и радиальное круговое меню модульного строительства (вызывается на [B]):
// тонкая DOM/SVG-разметка поверх пиксельного canvas без backdrop-filter.
import { PIECE_CATALOG, PIECE_ORDER } from '../building/catalog.ts';
import type {
    BuildingHudSnapshot,
    BuildingSystem,
    RadialSectorId
} from '../building/buildingSystem.ts';
import type { PieceType } from '../building/types.ts';

interface RadialSectorMeta {
    id: RadialSectorId;
    hotkey: string;
    shortTitle: string;
    fullTitle: string;
    subtitle: string;
    description: string;
    iconSvg: string;
}

const RADIAL_SECTORS: RadialSectorMeta[] = [
    {
        id: 'foundation',
        hotkey: '1',
        shortTitle: 'ФУНДАМЕНТ',
        fullTitle: PIECE_CATALOG.foundation.name,
        subtitle: '3.2×3.2×0.64 М · ОПОРА НА ГРУНТ',
        description: PIECE_CATALOG.foundation.description,
        iconSvg: '<rect x="-12" y="2" width="24" height="8" fill="currentColor"/><rect x="-14" y="0" width="5" height="12" fill="currentColor"/><rect x="9" y="0" width="5" height="12" fill="currentColor"/>'
    },
    {
        id: 'solid_wall',
        hotkey: '2',
        shortTitle: 'СТЕНА',
        fullTitle: PIECE_CATALOG.solid_wall.name,
        subtitle: '3.2×3.0×0.38 М · В ПАЗ ФУНДАМЕНТА/СТЕНЫ',
        description: PIECE_CATALOG.solid_wall.description,
        iconSvg: '<rect x="-12" y="-11" width="24" height="22" fill="none" stroke="currentColor" stroke-width="2.5"/><line x1="-12" y1="0" x2="12" y2="0" stroke="currentColor" stroke-width="2"/><line x1="-4" y1="-11" x2="-4" y2="11" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="-11" x2="4" y2="11" stroke="currentColor" stroke-width="1.5"/>'
    },
    {
        id: 'window_wall',
        hotkey: '3',
        shortTitle: 'ОКНО',
        fullTitle: PIECE_CATALOG.window_wall.name,
        subtitle: '3.2×3.0×0.38 М · БРОНЕСТЕКЛО И БОЙНИЦА',
        description: PIECE_CATALOG.window_wall.description,
        iconSvg: '<rect x="-12" y="-11" width="24" height="22" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="-7" y="-5" width="14" height="9" fill="none" stroke="currentColor" stroke-width="2"/><line x1="0" y1="-5" x2="0" y2="4" stroke="currentColor" stroke-width="1.8"/>'
    },
    {
        id: 'door_wall',
        hotkey: '4',
        shortTitle: 'ДВЕРЬ',
        fullTitle: PIECE_CATALOG.door_wall.name,
        subtitle: '3.2×3.0×0.38 М · ВХОДНОЙ ГЕРМОШЛЮЗ',
        description: PIECE_CATALOG.door_wall.description,
        iconSvg: '<rect x="-12" y="-11" width="24" height="22" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="-5" y="-6" width="10" height="17" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="2.5" cy="2" r="1.3" fill="currentColor"/>'
    },
    {
        id: 'ceiling',
        hotkey: '5',
        shortTitle: 'ПОТОЛОК',
        fullTitle: PIECE_CATALOG.ceiling.name,
        subtitle: '3.2×3.2×0.22 М · МЕЖЪЯРУСНОЕ ПЕРЕКРЫТИЕ',
        description: PIECE_CATALOG.ceiling.description,
        iconSvg: '<polygon points="-14,-3 0,-10 14,-3 0,4" fill="none" stroke="currentColor" stroke-width="2.2"/><line x1="-14" y1="2" x2="0" y2="9" stroke="currentColor" stroke-width="2"/><line x1="14" y1="2" x2="0" y2="9" stroke="currentColor" stroke-width="2"/>'
    },
    {
        id: 'staircase_railed',
        hotkey: '6',
        shortTitle: 'ЛЕСТНИЦА',
        fullTitle: PIECE_CATALOG.staircase_railed.name,
        subtitle: '1.8×3.0×3.2 М · С ПЕРИЛАМИ И ПЛОЩАДКОЙ',
        description: PIECE_CATALOG.staircase_railed.description,
        iconSvg: '<polyline points="-11,10 -5,10 -5,4 1,4 1,-2 7,-2 7,-8 12,-8" fill="none" stroke="currentColor" stroke-width="2.4"/><line x1="-10" y1="3" x2="6" y2="-12" stroke="currentColor" stroke-width="1.8"/>'
    },
    {
        id: 'staircase_open',
        hotkey: '7',
        shortTitle: 'ОТКР. МАРШ',
        fullTitle: PIECE_CATALOG.staircase_open.name,
        subtitle: '1.8×3.0×3.2 М · ОТКРЫТЫЕ КОСОУРЫ',
        description: PIECE_CATALOG.staircase_open.description,
        iconSvg: '<polyline points="-11,10 -5,10 -5,4 1,4 1,-2 7,-2 7,-8 12,-8" fill="none" stroke="currentColor" stroke-width="2.4"/><line x1="-11" y1="12" x2="12" y2="-6" stroke="currentColor" stroke-width="1.5"/>'
    },
    {
        id: 'exit',
        hotkey: '0',
        shortTitle: 'ВЫХОД',
        fullTitle: 'ЗАКРЫТЬ СТРОИТЕЛЬСТВО',
        subtitle: 'УБРАТЬ ЧЕРТЁЖ И ВЕРНУТЬСЯ К УПРАВЛЕНИЮ',
        description: 'Выключает призрак строительства и возвращает обычное управление камерой и персонажем',
        iconSvg: '<line x1="-8" y1="-8" x2="8" y2="8" stroke="currentColor" stroke-width="2.8"/><line x1="8" y1="-8" x2="-8" y2="8" stroke="currentColor" stroke-width="2.8"/>'
    }
];

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
    const rad = (angleDeg * Math.PI) / 180;
    return {
        x: cx + r * Math.cos(rad),
        y: cy + r * Math.sin(rad)
    };
}

function createDonutWedgePath(
    cx: number,
    cy: number,
    rInner: number,
    rOuter: number,
    startAngleDeg: number,
    endAngleDeg: number
): string {
    const p1 = polarToCartesian(cx, cy, rOuter, startAngleDeg);
    const p2 = polarToCartesian(cx, cy, rOuter, endAngleDeg);
    const p3 = polarToCartesian(cx, cy, rInner, endAngleDeg);
    const p4 = polarToCartesian(cx, cy, rInner, startAngleDeg);
    const largeArc = endAngleDeg - startAngleDeg > 180 ? 1 : 0;
    return [
        `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
        `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
        `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
        `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
        'Z'
    ].join(' ');
}

const STYLE = `
#control-hud {
    position: fixed;
    inset: 0;
    pointer-events: none;
    font-family: 'Courier New', monospace;
    color: #8f6f4c;
    text-transform: uppercase;
    letter-spacing: 1px;
    z-index: 10;
}
#control-hud .hint {
    position: absolute;
    left: 18px;
    bottom: 82px;
    padding: 6px 10px 5px 9px;
    border-left: 2px solid #6d5236;
    background: linear-gradient(90deg, rgba(18, 10, 6, 0.65), rgba(18, 10, 6, 0.0));
    font-size: 10px;
    line-height: 1.7;
    text-shadow: 1px 1px 0 #120c09;
}
#control-hud .key { color: #d8a465; font-weight: bold; }
#control-hud .note {
    position: absolute;
    right: 18px;
    bottom: 16px;
    text-align: right;
    font-size: 9px;
    line-height: 1.7;
    color: #7a5c3e;
    text-shadow: 1px 1px 0 #120c09;
}
#control-hud .clock {
    position: absolute;
    top: 16px;
    right: 18px;
    text-align: right;
    font-size: 9px;
    line-height: 1.7;
    color: #7a5c3e;
    text-shadow: 1px 1px 0 #120c09;
}
#control-hud .debug {
    position: absolute;
    top: 16px;
    left: 18px;
    padding: 6px 10px 5px 9px;
    border-left: 2px solid #6d5236;
    background: linear-gradient(90deg, rgba(18, 10, 6, 0.55), rgba(18, 10, 6, 0.0));
    font-size: 9px;
    line-height: 1.7;
    color: #9d7c56;
    text-shadow: 1px 1px 0 #120c09;
}

/* Радиальное круговое меню строительства (вызывается на B) */
#radial-build-overlay {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(10, 7, 5, 0.62);
    pointer-events: auto;
    z-index: 30;
}
#radial-build-overlay.open {
    display: flex;
}
#radial-wheel-container {
    position: relative;
    width: 460px;
    height: 460px;
    user-select: none;
}
#radial-wheel-svg {
    width: 100%;
    height: 100%;
    overflow: visible;
}
.radial-wedge {
    fill: rgba(24, 16, 11, 0.92);
    stroke: #6d5236;
    stroke-width: 1.8;
    cursor: pointer;
    transition: fill 0.08s ease, stroke 0.08s ease;
}
.radial-wedge.selected {
    fill: rgba(74, 48, 20, 0.94);
    stroke: #d8a465;
    stroke-width: 2.2;
}
.radial-wedge.hovered {
    fill: rgba(255, 174, 0, 0.92);
    stroke: #ffe599;
    stroke-width: 2.6;
}
.radial-wedge.exit-wedge.hovered {
    fill: rgba(214, 62, 48, 0.92);
    stroke: #ff9e94;
}
.radial-sector-label {
    position: absolute;
    transform: translate(-50%, -50%);
    pointer-events: none;
    text-align: center;
    color: #d8b589;
    font-size: 10px;
    font-weight: bold;
    line-height: 1.25;
    text-shadow: 1px 1px 0 #090604;
    width: 96px;
}
.radial-sector-label.hovered {
    color: #120c09;
    text-shadow: none;
}
.radial-sector-label.exit-label {
    color: #ff857a;
}
.radial-sector-label.exit-label.hovered {
    color: #120c09;
}
.radial-sector-hotkey {
    display: inline-block;
    font-size: 9px;
    padding: 1px 4px;
    margin-bottom: 2px;
    background: rgba(12, 8, 5, 0.75);
    border: 1px solid #6d5236;
    color: #ffae00;
}
.radial-sector-label.hovered .radial-sector-hotkey {
    background: #120c09;
    color: #ffae00;
    border-color: #120c09;
}

/* Центральное ядро радиального круга с описанием выбранного префаба */
#radial-center-hub {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 176px;
    height: 176px;
    border-radius: 50%;
    background: #140d09;
    border: 2px solid #ffae00;
    box-shadow: 0 0 0 4px rgba(18, 12, 9, 0.95);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 14px;
    text-align: center;
    pointer-events: auto;
}
#radial-hub-title {
    color: #ffae00;
    font-size: 12px;
    font-weight: bold;
    margin-bottom: 4px;
    line-height: 1.2;
}
#radial-hub-sub {
    color: #9d7c56;
    font-size: 8px;
    line-height: 1.3;
    margin-bottom: 6px;
}
#radial-hub-desc {
    color: #d8b589;
    font-size: 8px;
    line-height: 1.35;
    text-transform: none;
    margin-bottom: 8px;
}
#radial-hub-controls {
    display: flex;
    gap: 5px;
}
#radial-hub-controls button {
    pointer-events: auto;
    cursor: pointer;
    font-family: 'Courier New', monospace;
    font-size: 9px;
    font-weight: bold;
    color: #ffe0a3;
    background: #241810;
    border: 1px solid #7a5c3e;
    padding: 2px 6px;
}
#radial-hub-controls button:hover {
    background: #ffae00;
    color: #120c09;
}
#radial-footer-hint {
    position: absolute;
    bottom: -36px;
    left: 50%;
    transform: translateX(-50%);
    white-space: nowrap;
    background: rgba(16, 11, 8, 0.94);
    border: 1px solid #6d5236;
    padding: 4px 12px;
    font-size: 10px;
    color: #d8b589;
}

/* Компактный индикатор активного режима строительства (когда радиальное меню закрыто) */
#build-active-hud {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    pointer-events: auto;
    z-index: 15;
}
#build-active-hud.visible {
    display: flex;
}
#build-active-hud .status-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: rgba(16, 11, 8, 0.92);
    border: 1px solid #6d5236;
    border-left: 3px solid #ffae00;
    box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.85);
    font-size: 10px;
    color: #d8b589;
}
#build-active-hud .status-badge {
    padding: 2px 6px;
    font-weight: bold;
    font-size: 10px;
    border: 1px solid currentColor;
}
#build-active-hud .status-badge.valid {
    color: #38ff9c;
    background: rgba(20, 82, 45, 0.55);
}
#build-active-hud .status-badge.invalid {
    color: #ff6b5e;
    background: rgba(95, 22, 16, 0.55);
}
#build-active-hud .dist-badge {
    padding: 2px 6px;
    font-weight: bold;
    color: #ffd280;
    border: 1px solid #6d5236;
    background: rgba(28, 19, 13, 0.85);
}
#build-active-hud .dist-badge.too-far {
    color: #ff6b5e;
    border-color: #ff6b5e;
    background: rgba(95, 22, 16, 0.65);
}
#build-active-hud .sub-actions {
    font-size: 9px;
    color: #9d7c56;
    background: rgba(14, 9, 6, 0.82);
    padding: 2px 8px;
    border: 1px solid #4a3521;
}
#door-interact-hud {
    position: absolute;
    left: 50%;
    bottom: 62px;
    transform: translateX(-50%);
    display: none;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    background: rgba(16, 11, 8, 0.92);
    border: 1px solid #6d5236;
    border-left: 3px solid #ffae00;
    box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.85);
    font-size: 10px;
    color: #ffe0a3;
    pointer-events: none;
    z-index: 14;
}
#door-interact-hud.visible {
    display: flex;
}
`;

export interface DayInfo {
    hours: number;
    minutes: number;
    phase: string;
}

export interface HudController {
    update(day: DayInfo, timeScale: number, debug?: any): void;
    updateHints(actorType?: string): void;
    attachBuildingSystem(building: BuildingSystem): void;
    updateBuilding(snapshot: BuildingHudSnapshot): void;
    dispose(): void;
}

export function createHud(): HudController {
    const style = document.createElement('style');
    style.id = 'control-hud-style';
    style.textContent = STYLE;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'control-hud';

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML = `
        <div><span class="key">[WASD]</span> MOVE &middot; <span class="key">[SHIFT]</span> SPRINT &middot; <span class="key">[SPACE]</span> JUMP &middot; <span class="key">[CTRL]</span> CROUCH / DUNE SLIDE &middot; <span class="key">[E]</span> ДВЕРЬ &middot; <span class="key">[F]</span> MOUNT BUGGY &middot; <span class="key">[L]</span> LIGHTS</div>
        <div><span class="key">HOLD LMB/RMB + DRAG</span> LOOK &middot; <span class="key">WHEEL</span> ZOOM</div>
        <div><span class="key">[B]</span> РАДИАЛЬНОЕ МЕНЮ СТРОЙКИ &middot; <span class="key">[1-4]</span> ПОГОДА &middot; <span class="key">[R]</span> СМЕНА</div>
        <div><span class="key">[T]</span> TIME SPEED</div>
    `;
    root.appendChild(hint);

    const note = document.createElement('div');
    note.className = 'note';
    note.innerHTML = 'WHEEL ZOOM';
    root.appendChild(note);

    const clock = document.createElement('div');
    clock.className = 'clock';
    root.appendChild(clock);

    // Отладочная панель песка и опоры: включается параметром ?debug=1
    const debugPanel = document.createElement('div');
    debugPanel.className = 'debug';
    debugPanel.style.display = 'none';
    root.appendChild(debugPanel);

    // --- 1. РАДИАЛЬНЫЙ КРУГ СТРОИТЕЛЬСТВА (ВЫЗЫВАЕТСЯ НА [B]) ---
    const radialOverlay = document.createElement('div');
    radialOverlay.id = 'radial-build-overlay';

    const wheelContainer = document.createElement('div');
    wheelContainer.id = 'radial-wheel-container';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.id = 'radial-wheel-svg';
    svg.setAttribute('viewBox', '0 0 460 460');

    const cx = 230;
    const cy = 230;
    const rInner = 92;
    const rOuter = 212;
    const rLabel = 154;
    const sectorCount = RADIAL_SECTORS.length;
    const stepDeg = 360 / sectorCount; // 45 градусов на сектор

    const wedgeElements = new Map<RadialSectorId, SVGPathElement>();
    const labelElements = new Map<RadialSectorId, HTMLDivElement>();

    let attachedBuilding: BuildingSystem | null = null;

    RADIAL_SECTORS.forEach((sector, index) => {
        // Сектор 0 расположен сверху (-90°), далее по часовой стрелке
        const centerAngle = -90 + index * stepDeg;
        const startAngle = centerAngle - stepDeg * 0.5 + 1.2;
        const endAngle = centerAngle + stepDeg * 0.5 - 1.2;

        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', createDonutWedgePath(cx, cy, rInner, rOuter, startAngle, endAngle));
        path.setAttribute('class', `radial-wedge ${sector.id === 'exit' ? 'exit-wedge' : ''}`);
        path.dataset.sectorId = sector.id;

        path.addEventListener('pointerenter', () => {
            attachedBuilding?.setHoveredSector(sector.id);
        });
        path.addEventListener('click', (e) => {
            e.stopPropagation();
            attachedBuilding?.selectRadialSector(sector.id);
        });

        svg.appendChild(path);
        wedgeElements.set(sector.id, path);

        // Иконка и подпись сектора
        const labelPos = polarToCartesian(cx, cy, rLabel, centerAngle);
        const labelDiv = document.createElement('div');
        labelDiv.className = `radial-sector-label ${sector.id === 'exit' ? 'exit-label' : ''}`;
        labelDiv.style.left = `${labelPos.x}px`;
        labelDiv.style.top = `${labelPos.y}px`;
        labelDiv.innerHTML = `
            <div class="radial-sector-hotkey">[${sector.hotkey}]</div>
            <div style="margin: 2px auto; width: 28px; height: 24px;">
                <svg viewBox="-16 -14 32 28" width="28" height="24">${sector.iconSvg}</svg>
            </div>
            <div>${sector.shortTitle}</div>
        `;
        wheelContainer.appendChild(labelDiv);
        labelElements.set(sector.id, labelDiv);
    });

    wheelContainer.appendChild(svg);

    // Центральный информационный хаб радиального меню
    const centerHub = document.createElement('div');
    centerHub.id = 'radial-center-hub';
    const hubTitle = document.createElement('div');
    hubTitle.id = 'radial-hub-title';
    const hubSub = document.createElement('div');
    hubSub.id = 'radial-hub-sub';
    const hubDesc = document.createElement('div');
    hubDesc.id = 'radial-hub-desc';

    const hubControls = document.createElement('div');
    hubControls.id = 'radial-hub-controls';

    const hubRotBtn = document.createElement('button');
    hubRotBtn.type = 'button';
    hubRotBtn.id = 'radial-btn-rot';
    hubRotBtn.textContent = '[R] 0°';
    hubRotBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachedBuilding?.rotate(1);
    });

    const hubTierBtn = document.createElement('button');
    hubTierBtn.type = 'button';
    hubTierBtn.id = 'radial-btn-tier';
    hubTierBtn.textContent = '[G] ТИР 1';
    hubTierBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachedBuilding?.cycleTier();
    });

    hubControls.appendChild(hubRotBtn);
    hubControls.appendChild(hubTierBtn);

    centerHub.appendChild(hubTitle);
    centerHub.appendChild(hubSub);
    centerHub.appendChild(hubDesc);
    centerHub.appendChild(hubControls);
    wheelContainer.appendChild(centerHub);

    const footerHint = document.createElement('div');
    footerHint.id = 'radial-footer-hint';
    footerHint.innerHTML = '<span class="key">[МЫШЬ / КЛИК]</span> ВЫБРАТЬ МОДУЛЬ &middot; <span class="key">[1–7]</span> БЫСТРЫЙ ВЫБОР &middot; <span class="key">[B / ESC]</span> ЗАКРЫТЬ';
    wheelContainer.appendChild(footerHint);

    radialOverlay.appendChild(wheelContainer);
    root.appendChild(radialOverlay);

    // Отслеживание угла курсора мыши относительно центра круга (работает даже при быстром взмахе мыши)
    radialOverlay.addEventListener('pointermove', (e) => {
        if (!attachedBuilding || !attachedBuilding.isRadialOpen()) return;
        const rect = wheelContainer.getBoundingClientRect();
        const centerX = rect.left + rect.width * 0.5;
        const centerY = rect.top + rect.height * 0.5;
        const dx = e.clientX - centerX;
        const dy = e.clientY - centerY;
        const dist = Math.hypot(dx, dy);

        if (dist < 46) {
            return;
        }
        // Вычисляем угол относительно севера (-90° = 0) по часовой стрелке (0..360)
        const rawDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        const fromTopDeg = (rawDeg + 90 + 360 + stepDeg * 0.5) % 360;
        const sectorIdx = Math.floor(fromTopDeg / stepDeg) % sectorCount;
        const sector = RADIAL_SECTORS[sectorIdx];
        if (sector) {
            attachedBuilding.setHoveredSector(sector.id);
        }
    });

    radialOverlay.addEventListener('click', (e) => {
        if (!attachedBuilding || !attachedBuilding.isRadialOpen()) return;
        const snap = attachedBuilding.getSnapshot();
        if (snap.hoveredSector) {
            e.stopPropagation();
            attachedBuilding.selectRadialSector(snap.hoveredSector);
        } else if (e.target === radialOverlay) {
            attachedBuilding.setRadialOpen(false);
        }
    });

    // --- 2. КОМПАКТНЫЙ ИНДИКАТОР АКТИВНОГО СТРОИТЕЛЬСТВА ---
    const activeHud = document.createElement('div');
    activeHud.id = 'build-active-hud';

    const statusCard = document.createElement('div');
    statusCard.className = 'status-card';

    const statusPiece = document.createElement('span');
    statusPiece.id = 'build-status-piece';

    const statusCell = document.createElement('span');
    statusCell.id = 'build-status-cell';

    const statusDist = document.createElement('span');
    statusDist.id = 'build-status-dist';
    statusDist.className = 'dist-badge';

    const statusSocket = document.createElement('span');
    statusSocket.id = 'build-status-socket';
    statusSocket.className = 'status-badge valid';

    statusCard.appendChild(statusPiece);
    statusCard.appendChild(statusCell);
    statusCard.appendChild(statusDist);
    statusCard.appendChild(statusSocket);

    const subActions = document.createElement('div');
    subActions.className = 'sub-actions';
    subActions.innerHTML = '<span class="key">[B]</span> КРУГОВОЕ МЕНЮ &middot; <span class="key">[ЛКМ / C]</span> ПОСТРОИТЬ &middot; <span class="key">[ПКМ / X]</span> СНЕСТИ &middot; <span class="key">[E]</span> ДВЕРЬ &middot; <span class="key">[R]</span> ПОВОРОТ &middot; <span class="key">[G]</span> ТИР &middot; <span class="key">[ESC]</span> ВЫХОД';

    activeHud.appendChild(statusCard);
    activeHud.appendChild(subActions);
    root.appendChild(activeHud);

    // --- 3. КОНТЕКСТНАЯ ПОДСКАЗКА ВЗАИМОДЕЙСТВИЯ С ГЕРМОДВЕРЬЮ ---
    const doorPromptHud = document.createElement('div');
    doorPromptHud.id = 'door-interact-hud';
    root.appendChild(doorPromptHud);

    document.body.appendChild(root);

    let lastLabel = '';
    let lastDebug = '';
    let lastActorType = '';
    let debugTick = 0;

    function updateBuilding(snap: BuildingHudSnapshot): void {
        radialOverlay.classList.toggle('open', snap.radialOpen);
        activeHud.classList.toggle('visible', snap.active && !snap.radialOpen);

        const showDoorPrompt = Boolean(snap.nearbyDoor) && !snap.radialOpen;
        doorPromptHud.classList.toggle('visible', showDoorPrompt);
        if (snap.nearbyDoor) {
            const actionVerb = snap.nearbyDoor.isOpen ? 'ЗАКРЫТЬ ГЕРМОДВЕРЬ' : 'ОТКРЫТЬ ГЕРМОДВЕРЬ';
            const stateTag = snap.nearbyDoor.isOpen ? 'ОТКРЫТА' : 'ЗАКРЫТА';
            doorPromptHud.innerHTML = `<span class="key">[E]</span> ${actionVerb} &middot; <span style="color:#9d7c56">${stateTag}</span>`;
        }

        const deg = snap.rotation * 90;
        hubRotBtn.textContent = `[R] ${deg}°`;
        hubTierBtn.textContent = `[G] ТИР ${snap.tier}`;

        // Обновляем подсветку секторов и центральное описание в радиальном круге
        const activeFocusId: RadialSectorId = snap.hoveredSector || snap.selectedType;
        const focusMeta = RADIAL_SECTORS.find(s => s.id === activeFocusId) || RADIAL_SECTORS[0];

        for (const sector of RADIAL_SECTORS) {
            const wedge = wedgeElements.get(sector.id);
            const label = labelElements.get(sector.id);
            const isHovered = snap.hoveredSector === sector.id;
            const isSelected = snap.selectedType === sector.id && snap.active;
            if (wedge) {
                wedge.classList.toggle('hovered', isHovered);
                wedge.classList.toggle('selected', isSelected && !isHovered);
            }
            if (label) {
                label.classList.toggle('hovered', isHovered);
            }
        }

        hubTitle.textContent = focusMeta.fullTitle;
        hubSub.textContent = focusMeta.subtitle;
        hubDesc.textContent = focusMeta.description;

        // Обновляем компактный статус активного строительства и индикатор дистанции
        statusPiece.textContent = `${snap.selectedDef.name} (${snap.tierLabel})`;
        statusCell.textContent = `СЕТКА [${snap.targetCell.x}, ${snap.targetCell.y}, ${snap.targetCell.z}] · ${deg}°`;

        const isTooFar = snap.validation.reason === 'too_far' || snap.distance > snap.maxDistance;
        statusDist.className = `dist-badge ${isTooFar ? 'too-far' : ''}`;
        statusDist.textContent = `ДИСТ: ${snap.distance.toFixed(1)} / ${snap.maxDistance.toFixed(0)} М`;

        statusSocket.className = `status-badge ${snap.validation.valid ? 'valid' : 'invalid'}`;
        statusSocket.textContent = snap.validation.message;

        note.innerHTML = `БЛОКОВ: ${snap.totalPieces} &middot; ЧАНКОВ: ${snap.activeChunks} &middot; [B] СТРОЙКА`;
    }

    function attachBuildingSystem(building: BuildingSystem): void {
        attachedBuilding = building;
        updateBuilding(building.getSnapshot());
    }

    function update(day: DayInfo, timeScale: number, debug: any = null): void {
        const hh = day.hours < 10 ? `0${day.hours}` : String(day.hours);
        const mm = day.minutes < 10 ? `0${day.minutes}` : String(day.minutes);
        const speed = timeScale === 0 ? 'PAUSE' : `x${timeScale}`;
        const label = `${hh}:${mm} \u00b7 ${day.phase} \u00b7 ${speed}`;
        if (label !== lastLabel) {
            lastLabel = label;
            clock.textContent = label;
        }

        if (attachedBuilding) {
            updateBuilding(attachedBuilding.getSnapshot());
        }

        if (!debug) {
            if (debugPanel.style.display !== 'none') debugPanel.style.display = 'none';
            return;
        }

        const currentActorType = debug.actorType || 'cosmo';
        const actorChanged = currentActorType !== lastActorType;
        lastActorType = currentActorType;

        if (!actorChanged && ++debugTick % 10 !== 0) return;
        debugPanel.style.display = 'block';

        const loop = debug.loop || {};
        const contact = debug.contact || {};
        const field = debug.field || {};
        const legs = debug.legs || [];
        const slopeDeg = Math.atan(loop.slope || 0) * 180 / Math.PI;
        const walkPercent = Math.round((loop.slopeFactor === undefined ? 1 : loop.slopeFactor) * 100);

        const legText = legs.map((leg: any) => {
            const weight = leg.contactWeight === undefined ? 1 : leg.contactWeight;
            const blend = leg.contactBlend === undefined ? 1 : leg.contactBlend;
            return `${weight.toFixed(2)}\u00b7${blend.toFixed(2)}/${Math.round(leg.normalLoad || 0)}`;
        }).join(' ');

        let cosmoExtra = '';
        if (debug.actorType === 'cosmo' && debug.feet) {
            const lf = debug.feet.left || {};
            const rf = debug.feet.right || {};
            const ev = debug.eventCounts || {};
            const sDir = debug.slopeDirection || { x: 0, z: 0 };
            cosmoExtra =
                `<br>COSMO MAT ${debug.materialId || 'sand'} (${debug.surfaceType || 'sand'}) \u00b7 PACK ${(debug.packing || 0).toFixed(2)} \u00b7 SINK ${(debug.sink || 0).toFixed(3)}m \u00b7 LIM ${debug.movementLimitReason || 'none'}` +
                `<br>FEET L[${lf.state || '--'} y:${(lf.groundY || 0).toFixed(2)} gap:${(lf.groundY || 0).toFixed(2)} w:${(lf.contactWeight || 0).toFixed(2)} fh:${lf.footholdSafe !== false ? 'OK' : 'ALT'}] ` +
                `R[${rf.state || '--'} y:${(rf.groundY || 0).toFixed(2)} gap:${(rf.groundGap || 0).toFixed(2)} w:${(rf.contactWeight || 0).toFixed(2)} fh:${rf.footholdSafe !== false ? 'OK' : 'ALT'}]` +
                `<br>PHASE ${(debug.gaitPhase || 0).toFixed(2)} \u00b7 SDIR (${(sDir.x || 0).toFixed(2)},${(sDir.z || 0).toFixed(2)}) \u00b7 ` +
                `EVT TD:${(ev.leftTouchdown || 0) + (ev.rightTouchdown || 0)} LND:${ev.landing || 0} SLD:${ev.slide || 0} SLD_STATE:${debug.isSliding ? 'YES' : 'NO'}`;
        } else if (debug.actorType === 'buggy' || debug.actorType === 'transport') {
            cosmoExtra =
                `<br>BUGGY SPD ${(debug.forwardSpeed || 0).toFixed(2)} m/s \u00b7 STEER ${((debug.steeringAngle || 0) * 180 / Math.PI).toFixed(1)}\u00b0 \u00b7 ` +
                `PITCH ${((debug.chassisPitch || 0) * 180 / Math.PI).toFixed(1)}\u00b0 \u00b7 ROLL ${((debug.chassisRoll || 0) * 180 / Math.PI).toFixed(1)}\u00b0 \u00b7 ` +
                `BOOST ${debug.isBoosting ? 'ON' : 'OFF'}`;
        }

        const text =
            `PLANT ${debug.planted} \u00b7 STAB ${debug.stability.toFixed(2)} \u00b7 ` +
            `MARGIN ${(loop.margin || 0).toFixed(2)} m \u00b7 SINK ${debug.sink.toFixed(2)} m<br>` +
            `NORMAL ${Math.round(contact.normal || 0)} N \u00b7 DRIVE ${Math.round(contact.tangent || 0)} N ` +
            `\u00b7 HOLD ${Math.round(contact.capacity || 0)} N \u00b7 SAT ${Math.round((contact.saturation || 0) * 100)}% ` +
            `\u00b7 SLIP ${(contact.slip || 0).toFixed(2)} m/s<br>` +
            `LOAD ${Math.round((debug.loadRatio || 0) * 100)}% \u00b7 ` +
            `SUP ${debug.supported || 0}/${debug.planted} \u00b7 COP ${debug.copValid ? 'OK' : '--'}<br>` +
            `SLOPE ${slopeDeg.toFixed(0)}\u00b0 \u00b7 WALK ${walkPercent}% \u00b7 ` +
            `ASSIST ${(loop.assist || 0).toFixed(2)} \u00b7 TIP ${loop.tipped ? 'YES' : 'NO'}<br>` +
            `LEGS w\u00b7b/N ${legText}<br>` +
            `GRIP ${(contact.grip || 0).toFixed(2)} \u00b7 SLIDE ${(loop.slide || 0).toFixed(2)} ` +
            `\u00b7 FIELD ${field.attached || 0}/${field.chunks || 0} \u00b7 DEFORM ${field.deformed || 0} ` +
            `\u00b7 PACKED ${field.packed || 0} \u00b7 STEP ${debug.substeps}/3` +
            cosmoExtra +
            (typeof debug.totalVolume === 'number'
                ? `<br>VOL L1+L2 ${debug.totalVolume.toFixed(3)} m\u00b3 (RES ${(field.worldReserve || 0).toFixed(3)}) \u00b7 GRANULES ${(debug.granules?.activeCount || 0)} (${(debug.granules?.activeVolume || 0).toFixed(4)} m\u00b3) \u00b7 RET ${(debug.granules?.returnedVolumeTotal || 0).toFixed(4)} m\u00b3<br>` +
                  `SYNC ${Math.round(field.syncLatencyMs || 0)} ms \u00b7 TIME SF ${(field.stepDurationMs || 0).toFixed(1)}ms / LEG ${(contact.stepDurationMs || 0).toFixed(1)}ms / GRN ${(debug.granules?.stepDurationMs || 0).toFixed(1)}ms \u00b7 DROP ${(debug.physicsTiming?.droppedSteps || 0)}`
                : '');

        if (text !== lastDebug) {
            lastDebug = text;
            debugPanel.innerHTML = text;
        }
    }

    function updateHints(actorType = 'cosmo'): void {
        let movementLine = '';
        if (actorType === 'mech') {
            movementLine = '<div><span class="key">[WASD]</span> WALK &middot; <span class="key">[SPACE]</span> STOMP &middot; <span class="key">[SHIFT]</span> JUMP &middot; <span class="key">[L]</span> LIGHTS</div>';
        } else if (actorType === 'cosmo') {
            movementLine = '<div><span class="key">[WASD]</span> MOVE &middot; <span class="key">[SHIFT]</span> SPRINT &middot; <span class="key">[SPACE]</span> JUMP &middot; <span class="key">[CTRL]</span> CROUCH / DUNE SLIDE &middot; <span class="key">[E]</span> ДВЕРЬ &middot; <span class="key">[F]</span> MOUNT BUGGY &middot; <span class="key">[L]</span> LIGHTS</div>';
        } else if (actorType === 'transport' || actorType === 'buggy') {
            movementLine = '<div><span class="key">[WASD]</span> DRIVE &middot; <span class="key">[SHIFT]</span> BOOST &middot; <span class="key">[SPACE]</span> BRAKE &middot; <span class="key">[F]</span> DISMOUNT &middot; <span class="key">[L]</span> LIGHTS</div>';
        } else {
            movementLine = '<div><span class="key">[WASD]</span> MOVE &middot; <span class="key">[L]</span> LIGHTS</div>';
        }
        hint.innerHTML = `
            ${movementLine}
            <div><span class="key">HOLD LMB/RMB + DRAG</span> LOOK &middot; <span class="key">WHEEL</span> ZOOM</div>
            <div><span class="key">[B]</span> РАДИАЛЬНОЕ МЕНЮ СТРОЙКИ &middot; <span class="key">[1-4]</span> ПОГОДА &middot; <span class="key">[R]</span> СМЕНА</div>
            <div><span class="key">[T]</span> TIME SPEED</div>
        `;
    }

    function dispose(): void {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        const styleEl = document.getElementById('control-hud-style');
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    }

    return { update, updateHints, attachBuildingSystem, updateBuilding, dispose };
}
