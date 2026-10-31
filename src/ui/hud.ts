// Подсказки управления: тонкая DOM-разметка поверх пиксельного canvas.
// Боевого интерфейса больше нет — только клавиши хода, погоды и навигации.
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
    bottom: 16px;
    padding: 6px 10px 5px 9px;
    border-left: 2px solid #6d5236;
    background: linear-gradient(90deg, rgba(18, 10, 6, 0.5), rgba(18, 10, 6, 0.0));
    font-size: 10px;
    line-height: 1.7;
    text-shadow: 1px 1px 0 #120c09;
}
#control-hud .key { color: #9d7c56; }
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
`;

export interface DayInfo {
    hours: number;
    minutes: number;
    phase: string;
}

export interface HudController {
    update(day: DayInfo, timeScale: number, debug?: any): void;
    updateHints(actorType?: string): void;
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
        <div><span class="key">[WASD]</span> WALK &middot; <span class="key">[SPACE]</span> STOMP &middot; <span class="key">[SHIFT]</span> JUMP</div>
        <div><span class="key">HOLD LMB/RMB + DRAG</span> LOOK &middot; <span class="key">WHEEL</span> ZOOM</div>
        <div><span class="key">[1-4]</span> WEATHER &middot; <span class="key">[R]</span> NEXT</div>
        <div><span class="key">[T]</span> TIME SPEED &middot; <span class="key">[V]</span> SWITCH ACTOR</div>
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

    document.body.appendChild(root);

    // Часы обновляются только когда меняется строка, а не каждый кадр
    let lastLabel = '';
    let lastDebug = '';
    let debugTick = 0;

    function update(day: DayInfo, timeScale: number, debug: any = null): void {
        const hh = day.hours < 10 ? `0${day.hours}` : String(day.hours);
        const mm = day.minutes < 10 ? `0${day.minutes}` : String(day.minutes);
        const speed = timeScale === 0 ? 'PAUSE' : `x${timeScale}`;
        const label = `${hh}:${mm} \u00b7 ${day.phase} \u00b7 ${speed}`;
        if (label !== lastLabel) {
            lastLabel = label;
            clock.textContent = label;
        }

        if (!debug) {
            if (debugPanel.style.display !== 'none') debugPanel.style.display = 'none';
            return;
        }

        // Панель читается человеком: обновляем её 6 раз в секунду
        if (++debugTick % 10 !== 0) return;
        debugPanel.style.display = 'block';

        const loop = debug.loop || {};
        const contact = debug.contact || {};
        const field = debug.field || {};
        const legs = debug.legs || [];
        const slopeDeg = Math.atan(loop.slope || 0) * 180 / Math.PI;
        const walkPercent = Math.round((loop.slopeFactor === undefined ? 1 : loop.slopeFactor) * 100);

        // Состояние каждой лапы: вес контакта, плавность загрузки, сила.
        // По этой строке видно, какая стопа входит в опору или выходит из нее.
        const legText = legs.map((leg: any) => {
            const weight = leg.contactWeight === undefined ? 1 : leg.contactWeight;
            const blend = leg.contactBlend === undefined ? 1 : leg.contactBlend;
            return `${weight.toFixed(2)}\u00b7${blend.toFixed(2)}/${Math.round(leg.normalLoad || 0)}`;
        }).join(' ');

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
            (typeof debug.totalVolume === 'number'
                ? `<br>VOL L1+L2 ${debug.totalVolume.toFixed(3)} m\u00b3 (RES ${(field.worldReserve || 0).toFixed(3)}) \u00b7 GRANULES ${(debug.granules?.activeCount || 0)} (${(debug.granules?.activeVolume || 0).toFixed(4)} m\u00b3) \u00b7 RET ${(debug.granules?.returnedVolumeTotal || 0).toFixed(4)} m\u00b3<br>` +
                  `SYNC ${Math.round(field.syncLatencyMs || 0)} ms \u00b7 TIME SF ${(field.stepDurationMs || 0).toFixed(1)}ms / LEG ${(contact.stepDurationMs || 0).toFixed(1)}ms / GRN ${(debug.granules?.stepDurationMs || 0).toFixed(1)}ms \u00b7 DROP ${(debug.physicsTiming?.droppedSteps || 0)}`
                : '');

        if (text !== lastDebug) {
            lastDebug = text;
            debugPanel.innerHTML = text;
        }
    }

    function updateHints(actorType = 'mech'): void {
        let movementLine = '';
        if (actorType === 'mech') {
            movementLine = '<div><span class="key">[WASD]</span> WALK &middot; <span class="key">[SPACE]</span> STOMP &middot; <span class="key">[SHIFT]</span> JUMP</div>';
        } else if (actorType === 'cosmo') {
            movementLine = '<div><span class="key">[WASD]</span> MOVE &middot; <span class="key">[SHIFT]</span> SPRINT &middot; <span class="key">[SPACE]</span> JUMP &middot; <span class="key">[Q/E]</span> CROUCH / DUNE SLIDE &middot; <span class="key">[CLICK]</span> LOCK LOOK (ESC)</div>';
        } else {
            movementLine = '<div><span class="key">[WASD]</span> MOVE</div>';
        }
        hint.innerHTML = `
            ${movementLine}
            <div><span class="key">HOLD LMB/RMB + DRAG</span> LOOK &middot; <span class="key">WHEEL</span> ZOOM</div>
            <div><span class="key">[1-4]</span> WEATHER &middot; <span class="key">[R]</span> NEXT</div>
            <div><span class="key">[T]</span> TIME SPEED &middot; <span class="key">[V]</span> SWITCH ACTOR</div>
        `;
    }

    function dispose(): void {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        const styleEl = document.getElementById('control-hud-style');
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    }

    return { update, updateHints, dispose };
}

