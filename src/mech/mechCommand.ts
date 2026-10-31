// Фабрика команды управления шагоходом.
// Гарантирует наличие всех семи полей команды, ожидаемых физическим локомотивом:
// { throttle, turnInput, desiredYawRate, yawError, isManual, stompHeld, jumpHeld }.

export interface MechCommand {
    throttle: number;
    turnInput: number;
    desiredYawRate: number;
    yawError: number;
    isManual: boolean;
    stompHeld: boolean;
    jumpHeld: boolean;
}

export function createMechCommand(overrides: Partial<MechCommand> = {}): MechCommand {
    return {
        throttle: 0.0,
        turnInput: 0.0,
        desiredYawRate: 0.0,
        yawError: 0.0,
        isManual: false,
        stompHeld: false,
        jumpHeld: false,
        ...overrides
    };
}

