// Маршрутизатор ввода: преобразует физические события deviceState
// в логические действия (actions) по контекстам и обеспечивает OR-семантику псевдонимов.
import { DEFAULT_BINDINGS, type ContextBindings } from './bindings.ts';
import { createDeviceState, type DeviceState, type PointerClickInfo } from './deviceState.ts';

export interface ActionEvent {
    name: string;
    context: string;
    phase: 'down' | 'up';
    repeat: boolean;
    code: string | null;
    event?: KeyboardEvent | null;
}

export type ActionListener = (event: ActionEvent) => void;

export interface InputRouterOptions {
    deviceState?: DeviceState | null;
    target?: (EventTarget & { addEventListener: Function; removeEventListener: Function }) | Window | null;
    bindings?: ContextBindings;
    initialContext?: string;
    onAction?: ActionListener | null;
    onPointerClick?: ((info: PointerClickInfo) => void) | null;
}

export interface InputRouter {
    deviceState: DeviceState;
    getActionState(actionName: string): boolean;
    getActions(context?: string): Record<string, boolean>;
    setContext(newContext: string): void;
    getContext(): string;
    onAction(fn: ActionListener): () => void;
    onPointerClick(fn: (info: PointerClickInfo) => void): () => void;
    dispose(): void;
}

export function createInputRouter({
    deviceState = null,
    target = typeof window !== 'undefined' ? window : null,
    bindings = DEFAULT_BINDINGS,
    initialContext = 'mech',
    onAction = null,
    onPointerClick = null
}: InputRouterOptions = {}): InputRouter {
    let currentContext = initialContext;
    const actionListeners = new Set<ActionListener>();
    const clickListeners = new Set<(info: PointerClickInfo) => void>();

    if (onAction) actionListeners.add(onAction);
    if (onPointerClick) clickListeners.add(onPointerClick);

    // Обратные карты привязок для быстрого поиска: code -> { name, context }
    function buildLookup(currentBindings: ContextBindings): Map<string, { name: string; context: string }> {
        const lookup = new Map<string, { name: string; context: string }>();
        // 1. Сначала привязки контекстов
        for (const [context, actions] of Object.entries(currentBindings)) {
            if (context === 'global' || !actions) continue;
            for (const [actionName, codes] of Object.entries(actions)) {
                for (const code of codes) {
                    lookup.set(`${context}:${code}`, { name: actionName, context });
                }
            }
        }
        // 2. Глобальные привязки (имеют приоритет над контекстными)
        if (currentBindings.global) {
            for (const [actionName, codes] of Object.entries(currentBindings.global)) {
                for (const code of codes) {
                    lookup.set(`global:${code}`, { name: actionName, context: 'global' });
                }
            }
        }
        return lookup;
    }

    let codeLookup = buildLookup(bindings);

    function resolveAction(code: string): { name: string; context: string } | null {
        // Глобальный контекст проверяется первым
        const globalMatch = codeLookup.get(`global:${code}`);
        if (globalMatch) return globalMatch;
        return codeLookup.get(`${currentContext}:${code}`) || null;
    }

    function getActionCodes(actionName: string, context = currentContext): string[] {
        const ctxBindings = bindings[context];
        if (!ctxBindings) return [];
        return ctxBindings[actionName] || [];
    }

    function isActionActive(actionName: string, context = currentContext): boolean {
        const codes = getActionCodes(actionName, context);
        if (codes.length === 0) {
            // Если в текущем контексте нет, проверим global
            const globalCodes = getActionCodes(actionName, 'global');
            return globalCodes.some(code => state.isKeyDown(code));
        }
        return codes.some(code => state.isKeyDown(code));
    }

    function emitAction(event: ActionEvent): void {
        for (const listener of actionListeners) {
            listener(event);
        }
    }

    function handleKey(code: string, isDown: boolean, event?: KeyboardEvent): void {
        const resolved = resolveAction(code);
        if (!resolved) return;

        const { name, context } = resolved;
        const isRepeat = Boolean(event && event.repeat);

        if (isDown) {
            emitAction({
                name,
                context,
                phase: 'down',
                repeat: isRepeat,
                code,
                event
            });
        } else {
            // Клавиша отпущена: проверяем, остались ли другие зажатые коды для этого действия
            const stillHeld = isActionActive(name, context);
            if (!stillHeld) {
                emitAction({
                    name,
                    context,
                    phase: 'up',
                    repeat: false,
                    code,
                    event
                });
            }
        }
    }

    function handleClick(clickInfo: PointerClickInfo): void {
        for (const listener of clickListeners) {
            listener(clickInfo);
        }
    }

    function handleBlur(): void {
        const ctxBindings = bindings[currentContext];
        if (ctxBindings) {
            for (const actionName of Object.keys(ctxBindings)) {
                emitAction({
                    name: actionName,
                    context: currentContext,
                    phase: 'up',
                    repeat: false,
                    code: null,
                    event: null
                });
            }
        }
    }

    const ownsDeviceState = !deviceState;
    const state = deviceState || createDeviceState({
        target,
        onKey: handleKey,
        onPointerClick: handleClick,
        onBlur: handleBlur
    });

    const unsubs: Array<() => void> = [];
    if (!ownsDeviceState) {
        if (typeof state.addKeyListener === 'function') {
            unsubs.push(state.addKeyListener(handleKey));
        }
        if (typeof state.addClickListener === 'function') {
            unsubs.push(state.addClickListener(handleClick));
        }
        if (typeof state.addBlurListener === 'function') {
            unsubs.push(state.addBlurListener(handleBlur));
        }
    }

    function getActionState(actionName: string): boolean {
        return isActionActive(actionName, currentContext);
    }

    function getActions(context = currentContext): Record<string, boolean> {
        const ctxBindings = bindings[context];
        const result: Record<string, boolean> = {};
        if (ctxBindings) {
            for (const actionName of Object.keys(ctxBindings)) {
                result[actionName] = isActionActive(actionName, context);
            }
        }
        return result;
    }

    function setContext(newContext: string): void {
        currentContext = newContext;
    }

    function getContext(): string {
        return currentContext;
    }

    function addActionListener(fn: ActionListener): () => void {
        actionListeners.add(fn);
        return () => actionListeners.delete(fn);
    }

    function addClickListener(fn: (info: PointerClickInfo) => void): () => void {
        clickListeners.add(fn);
        return () => clickListeners.delete(fn);
    }

    function dispose(): void {
        actionListeners.clear();
        clickListeners.clear();
        for (const unsub of unsubs) {
            unsub();
        }
        unsubs.length = 0;
        if (ownsDeviceState) {
            state.dispose();
        }
    }

    return {
        deviceState: state,
        getActionState,
        getActions,
        setContext,
        getContext,
        onAction: addActionListener,
        onPointerClick: addClickListener,
        dispose
    };
}
