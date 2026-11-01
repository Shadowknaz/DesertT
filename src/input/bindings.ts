// Декларативная карта привязок физических кодов к логическим действиям.
// Глобальный контекст имеет приоритет над контекстами активных актеров.

export interface ActionBindings {
    [actionName: string]: string[];
}

export interface ContextBindings {
    global: ActionBindings;
    mech: ActionBindings;
    cosmo: ActionBindings;
    character?: ActionBindings;
    [context: string]: ActionBindings | undefined;
}

export const DEFAULT_BINDINGS: ContextBindings = {
    global: {
        weatherPreset1: ['Digit1'],
        weatherPreset2: ['Digit2'],
        weatherPreset3: ['Digit3'],
        weatherPreset4: ['Digit4'],
        weatherCycle: ['KeyR'],
        timeToggle: ['KeyT']
    },
    mech: {
        forward: ['KeyW', 'ArrowUp'],
        backward: ['KeyS', 'ArrowDown'],
        left: ['KeyA', 'ArrowLeft'],
        right: ['KeyD', 'ArrowRight'],
        stomp: ['Space'],
        jump: ['ShiftLeft', 'ShiftRight'],
        toggleLights: ['KeyL']
    },
    cosmo: {
        forward: ['KeyW', 'ArrowUp'],
        backward: ['KeyS', 'ArrowDown'],
        left: ['KeyA', 'ArrowLeft'],
        right: ['KeyD', 'ArrowRight'],
        crouch: ['ControlLeft', 'ControlRight'],
        jump: ['Space'],
        sprint: ['ShiftLeft', 'ShiftRight'],
        run: ['ShiftLeft', 'ShiftRight'],
        interact: ['KeyF'],
        toggleLights: ['KeyL']
    },
    transport: {
        forward: ['KeyW', 'ArrowUp'],
        backward: ['KeyS', 'ArrowDown'],
        left: ['KeyA', 'ArrowLeft'],
        right: ['KeyD', 'ArrowRight'],
        boost: ['ShiftLeft', 'ShiftRight'],
        brake: ['Space'],
        interact: ['KeyF', 'KeyE'],
        toggleLights: ['KeyL']
    }
};

// Синонимы контекстов для расширяемости
DEFAULT_BINDINGS.character = DEFAULT_BINDINGS.cosmo;
DEFAULT_BINDINGS.buggy = DEFAULT_BINDINGS.transport;

export const PREVENT_DEFAULT_KEYS: string[] = [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Space'
];

