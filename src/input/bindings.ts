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
        timeToggle: ['KeyT'],
        switchActor: ['KeyV']
    },
    mech: {
        forward: ['KeyW', 'ArrowUp'],
        backward: ['KeyS', 'ArrowDown'],
        left: ['KeyA', 'ArrowLeft'],
        right: ['KeyD', 'ArrowRight'],
        stomp: ['Space'],
        jump: ['ShiftLeft', 'ShiftRight']
    },
    cosmo: {
        forward: ['KeyW', 'ArrowUp'],
        backward: ['KeyS', 'ArrowDown'],
        left: ['KeyA', 'ArrowLeft'],
        right: ['KeyD', 'ArrowRight'],
        crouchDown: ['KeyQ', 'ControlLeft'],
        crouchUp: ['KeyE'],
        jump: ['Space'],
        sprint: ['ShiftLeft', 'ShiftRight'],
        run: ['ShiftLeft', 'ShiftRight']
    }
};

// character как синоним cosmo для расширяемости
DEFAULT_BINDINGS.character = DEFAULT_BINDINGS.cosmo;

export const PREVENT_DEFAULT_KEYS: string[] = [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Space'
];

