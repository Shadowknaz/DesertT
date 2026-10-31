// Ввод пользователя: клавиатура для прямого управления шагоходом,
// клик любой кнопкой мыши — точка маршрута, перетаскивание — орбита камеры.
// Модуль служит фасадом над слоями deviceState, bindings, inputRouter и picking.
import * as THREE from 'three';
import { createInputRouter } from './inputRouter.ts';
import { createPicker } from './picking.ts';

export interface InputControllerOptions {
    camera: THREE.Camera;
    getSandMeshes: (() => THREE.Object3D[]) | THREE.Object3D[];
    onManualInput?: () => void;
    onSandClick?: (point: THREE.Vector3) => void;
    onWeatherSelect?: ((index: number) => void) | null;
    onWeatherCycle?: (() => void) | null;
    onTimeToggle?: (() => void) | null;
}

export interface InputController {
    keyState: Record<string, boolean>;
    dispose(): void;
}

export function createInputController({
    camera,
    getSandMeshes,
    onManualInput,
    onSandClick,
    onWeatherSelect = null,
    onWeatherCycle = null,
    onTimeToggle = null
}: InputControllerOptions): InputController {
    const keyState: Record<string, boolean> = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        stomp: false,
        jump: false
    };

    const picker = createPicker({
        camera,
        getSandMeshes
    });

    const router = createInputRouter({
        target: typeof window !== 'undefined' ? window : null,
        initialContext: 'mech',
        onAction: ({ name, context, phase }) => {
            if (context === 'global') {
                if (phase === 'down') {
                    if (onWeatherSelect) {
                        if (name === 'weatherPreset1') onWeatherSelect(0);
                        else if (name === 'weatherPreset2') onWeatherSelect(1);
                        else if (name === 'weatherPreset3') onWeatherSelect(2);
                        else if (name === 'weatherPreset4') onWeatherSelect(3);
                    }
                    if (onWeatherCycle && name === 'weatherCycle') {
                        onWeatherCycle();
                    }
                    if (onTimeToggle && name === 'timeToggle') {
                        onTimeToggle();
                    }
                }
                return;
            }

            if (context === 'mech') {
                syncKeyState();
                if (phase === 'down' && onManualInput) {
                    onManualInput();
                }
            }
        },
        onPointerClick: ({ clientX, clientY }) => {
            if (!onSandClick) return;
            const width = typeof window !== 'undefined' ? window.innerWidth : 800;
            const height = typeof window !== 'undefined' ? window.innerHeight : 600;
            const result = picker.pick({ clientX, clientY }, { viewportWidth: width, viewportHeight: height });
            if (result.hit && result.point) {
                onSandClick(result.point);
            }
        }
    });

    function syncKeyState(): void {
        const actions = router.getActions('mech');
        for (const action of Object.keys(keyState)) {
            keyState[action] = Boolean(actions[action]);
        }
    }

    const target = typeof window !== 'undefined' ? window : null;
    function handleBlur(): void {
        for (const action of Object.keys(keyState)) {
            keyState[action] = false;
        }
    }
    if (target && typeof target.addEventListener === 'function') {
        target.addEventListener('blur', handleBlur);
    }

    function dispose(): void {
        if (target && typeof target.removeEventListener === 'function') {
            target.removeEventListener('blur', handleBlur);
        }
        router.dispose();
    }

    return { keyState, dispose };
}

