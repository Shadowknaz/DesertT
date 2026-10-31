// Слой физических устройств ввода: отслеживание клавиш, мыши, порога клика и сброса фокуса.
// Не содержит знаний об игровых действиях (forward, stomp, weather и т.д.).
import { INPUT } from '../config.ts';

const DEFAULT_PREVENT_DEFAULT = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'
]);

export interface PointerClickInfo {
    button: number;
    clientX: number;
    clientY: number;
    event: MouseEvent | PointerEvent;
}

export type KeyListener = (code: string, isDown: boolean, event?: KeyboardEvent) => void;
export type ClickListener = (info: PointerClickInfo) => void;
export type BlurListener = () => void;

export interface DeviceStateOptions {
    target?: (EventTarget & { addEventListener: Function; removeEventListener: Function }) | Window | null;
    clickTolerancePx?: number;
    preventDefaultCodes?: Set<string> | Iterable<string>;
    onKey?: KeyListener | null;
    onPointerClick?: ClickListener | null;
    onBlur?: BlurListener | null;
}

export interface DeviceState {
    isKeyDown(code: string): boolean;
    getPressedCodes(): Set<string>;
    getPointer(): { clientX: number; clientY: number };
    onBlur(): void;
    addKeyListener(fn: KeyListener): () => void;
    addClickListener(fn: ClickListener): () => void;
    addBlurListener(fn: BlurListener): () => void;
    onKey(fn: KeyListener): () => void;
    onPointerClick(fn: ClickListener): () => void;
    onBlurEvent(fn: BlurListener): () => void;
    dispose(): void;
}

export function createDeviceState({
    target = typeof window !== 'undefined' ? window : null,
    clickTolerancePx = INPUT.clickTolerancePx,
    preventDefaultCodes = DEFAULT_PREVENT_DEFAULT,
    onKey = null,
    onPointerClick = null,
    onBlur = null
}: DeviceStateOptions = {}): DeviceState {
    const pressedCodes = new Set<string>();
    const preventSet = preventDefaultCodes instanceof Set
        ? preventDefaultCodes
        : new Set(preventDefaultCodes);

    const keyListeners = new Set<KeyListener>();
    const clickListeners = new Set<ClickListener>();
    const blurListeners = new Set<BlurListener>();

    if (onKey) keyListeners.add(onKey);
    if (onPointerClick) clickListeners.add(onPointerClick);
    if (onBlur) blurListeners.add(onBlur);

    let pressButton = -1;
    let downX = 0;
    let downY = 0;
    let lastClientX = 0;
    let lastClientY = 0;

    function onKeyDown(event: KeyboardEvent) {
        if (preventSet.has(event.code) && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        pressedCodes.add(event.code);
        for (const listener of keyListeners) {
            listener(event.code, true, event);
        }
    }

    function onKeyUp(event: KeyboardEvent) {
        pressedCodes.delete(event.code);
        for (const listener of keyListeners) {
            listener(event.code, false, event);
        }
    }

    function onPointerDown(event: PointerEvent) {
        if (event.button !== 0 && event.button !== 2) return;
        pressButton = event.button;
        downX = event.clientX;
        downY = event.clientY;
        lastClientX = event.clientX;
        lastClientY = event.clientY;
    }

    function onPointerUp(event: PointerEvent) {
        lastClientX = event.clientX;
        lastClientY = event.clientY;
        if (event.button !== pressButton) return;
        const currentButton = pressButton;
        pressButton = -1;

        const moved = Math.hypot(event.clientX - downX, event.clientY - downY);
        if (moved > clickTolerancePx) return;

        const info: PointerClickInfo = {
            button: currentButton,
            clientX: event.clientX,
            clientY: event.clientY,
            event
        };
        for (const listener of clickListeners) {
            listener(info);
        }
    }

    function onContextMenu(event: MouseEvent) {
        if (typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
    }

    function handleBlur() {
        pressedCodes.clear();
        pressButton = -1;
        for (const listener of blurListeners) {
            listener();
        }
    }

    const t = target as any;
    if (t && typeof t.addEventListener === 'function') {
        t.addEventListener('keydown', onKeyDown);
        t.addEventListener('keyup', onKeyUp);
        t.addEventListener('pointerdown', onPointerDown);
        t.addEventListener('pointerup', onPointerUp);
        t.addEventListener('contextmenu', onContextMenu);
        t.addEventListener('blur', handleBlur);
    }

    function isKeyDown(code: string): boolean {
        return pressedCodes.has(code);
    }

    function getPressedCodes(): Set<string> {
        return new Set(pressedCodes);
    }

    function getPointer(): { clientX: number; clientY: number } {
        return { clientX: lastClientX, clientY: lastClientY };
    }

    function addKeyListener(fn: KeyListener): () => void {
        keyListeners.add(fn);
        return () => keyListeners.delete(fn);
    }

    function addClickListener(fn: ClickListener): () => void {
        clickListeners.add(fn);
        return () => clickListeners.delete(fn);
    }

    function addBlurListener(fn: BlurListener): () => void {
        blurListeners.add(fn);
        return () => blurListeners.delete(fn);
    }

    function dispose(): void {
        if (t && typeof t.removeEventListener === 'function') {
            t.removeEventListener('keydown', onKeyDown);
            t.removeEventListener('keyup', onKeyUp);
            t.removeEventListener('pointerdown', onPointerDown);
            t.removeEventListener('pointerup', onPointerUp);
            t.removeEventListener('contextmenu', onContextMenu);
            t.removeEventListener('blur', handleBlur);
        }
        keyListeners.clear();
        clickListeners.clear();
        blurListeners.clear();
        pressedCodes.clear();
        pressButton = -1;
    }

    return {
        isKeyDown,
        getPressedCodes,
        getPointer,
        onBlur: handleBlur,
        addKeyListener,
        addClickListener,
        addBlurListener,
        // Удобные алиасы
        onKey: addKeyListener,
        onPointerClick: addClickListener,
        onBlurEvent: addBlurListener,
        dispose
    };
}

