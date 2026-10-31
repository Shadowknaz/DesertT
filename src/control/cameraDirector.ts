// Директор камеры: плавное слежение за позой активного актера,
// Third-Person Action обзор мышью (Pointer Lock / Drag), зум колесом,
// удержание над рельефом (ground clearance) и временная тряска в бурю.
import * as THREE from 'three';
import { CAMERA } from '../config.ts';
import { getDuneHeight } from '../core/duneField.ts';

const SENSITIVITY_LOOK = 0.0022; // Чувствительность мыши в режиме Pointer Lock (рад/пикс)
const SENSITIVITY_DRAG = 0.0035; // Чувствительность мыши при перетаскивании (рад/пикс)
const MIN_POLAR = 0.08;          // ~4.5° — вид почти сверху
const MAX_POLAR = Math.PI * 0.48; // ~86.4° — вид на уровне земли

export interface CameraConfig {
    focusHeight: number;
    followGain: number;
    groundClearance: number;
    minDistance?: number;
    maxDistance?: number;
    defaultDistance?: number;
}

export interface CameraDirectorOptions {
    camera: THREE.Camera & { position: THREE.Vector3; lookAt(target: THREE.Vector3): void };
    domElement?: HTMLElement | null;
    controls?: { target?: THREE.Vector3; update?: () => void; minDistance?: number; maxDistance?: number } | null;
    getGroundHeight?: (x: number, z: number) => number;
    config?: Partial<CameraConfig>;
}

export interface CameraDirector {
    follow(dt: number, targetPos: THREE.Vector3, focusHeight?: number, followGain?: number): void;
    keepAboveGround(groundClearance?: number): void;
    applyShake(weatherState: { shake: number; time: number } | null | undefined): void;
    revertShake(): void;
    update(dt: number, targetPos: THREE.Vector3, weatherState?: { shake: number; time: number } | null): void;
    setActorCamera(cfg?: Partial<CameraConfig> | null): void;
    rotateAzimuth(delta: number): void;
    rotatePolar(delta: number): void;
    setTargetDistance(dist: number): void;
    getTargetDistance(): number;
    getAzimuth(): number;
    getPolar(): number;
    isPointerLocked(): boolean;
    isDragging(): boolean;
    dispose(): void;
    cameraFocus: THREE.Vector3;
}

export function createCameraDirector({
    camera,
    domElement = null,
    controls = null,
    getGroundHeight = getDuneHeight,
    config = CAMERA
}: CameraDirectorOptions): CameraDirector {
    const cameraFocus = new THREE.Vector3(0, config.focusHeight ?? CAMERA.focusHeight, 0);
    const previousFocus = new THREE.Vector3();
    const followTarget = new THREE.Vector3();
    const followDelta = new THREE.Vector3();
    const shakeOffset = new THREE.Vector3();

    // Сферические координаты орбиты камеры вокруг точки фокуса
    const initialOffset = new THREE.Vector3().subVectors(camera.position, cameraFocus);
    let initialDist = initialOffset.length();
    if (!Number.isFinite(initialDist) || initialDist < 0.1) initialDist = 15.0;

    let initialPhi = Math.acos(THREE.MathUtils.clamp(initialOffset.y / initialDist, -1, 1));
    if (!Number.isFinite(initialPhi)) initialPhi = Math.PI * 0.35;
    initialPhi = THREE.MathUtils.clamp(initialPhi, MIN_POLAR, MAX_POLAR);

    let initialTheta = Math.atan2(initialOffset.x, initialOffset.z);
    if (!Number.isFinite(initialTheta)) initialTheta = 0.0;

    let currentDistance = initialDist;
    let targetDistance = initialDist;
    let minDistance = config.minDistance ?? 1.5;
    let maxDistance = config.maxDistance ?? 70.0;

    let currentTheta = initialTheta;
    let targetTheta = initialTheta;

    let currentPhi = initialPhi;
    let targetPhi = initialPhi;

    let activeFocusHeight = config.focusHeight ?? CAMERA.focusHeight;
    let activeFollowGain = config.followGain ?? CAMERA.followGain;
    let activeGroundClearance = config.groundClearance ?? CAMERA.groundClearance;

    let isPointerLocked = false;
    let isDragging = false;
    let lastPointerX = 0;
    let lastPointerY = 0;
    let activePointerId = -1;

    // Вращение по азимуту (yaw вокруг персонажа)
    function rotateAzimuth(delta: number): void {
        targetTheta += delta;
        // Нормализация углов для избежания накопления огромных чисел
        const twoPi = Math.PI * 2;
        if (targetTheta > Math.PI) {
            targetTheta -= twoPi;
            currentTheta -= twoPi;
        } else if (targetTheta < -Math.PI) {
            targetTheta += twoPi;
            currentTheta += twoPi;
        }
    }

    // Вращение по тангажу (pitch вверх/вниз)
    function rotatePolar(delta: number): void {
        targetPhi = THREE.MathUtils.clamp(targetPhi - delta, MIN_POLAR, MAX_POLAR);
    }

    // Изменение дистанции (зум)
    function setTargetDistance(dist: number): void {
        targetDistance = THREE.MathUtils.clamp(dist, minDistance, maxDistance);
    }

    // Настройка камеры под конкретного актера (Мех vs Космо)
    function setActorCamera(cfg?: Partial<CameraConfig> | null): void {
        if (!cfg) return;
        if (cfg.focusHeight !== undefined) activeFocusHeight = cfg.focusHeight;
        if (cfg.followGain !== undefined) activeFollowGain = cfg.followGain;
        if (cfg.groundClearance !== undefined) activeGroundClearance = cfg.groundClearance;
        if (cfg.minDistance !== undefined) minDistance = cfg.minDistance;
        if (cfg.maxDistance !== undefined) maxDistance = cfg.maxDistance;
        if (cfg.defaultDistance !== undefined) {
            setTargetDistance(cfg.defaultDistance);
        }
        if (controls) {
            if (cfg.minDistance !== undefined) controls.minDistance = cfg.minDistance;
            if (cfg.maxDistance !== undefined) controls.maxDistance = cfg.maxDistance;
        }
    }

    // --- Обработчики событий мыши и Pointer Lock ---
    function onPointerLockChange(): void {
        if (typeof document !== 'undefined') {
            isPointerLocked = (document.pointerLockElement === domElement);
        }
    }

    function onPointerDown(e: PointerEvent | MouseEvent): void {
        if (e.button === 0 || e.button === 2) {
            isDragging = true;
            activePointerId = (e as PointerEvent).pointerId ?? 1;
            lastPointerX = e.clientX;
            lastPointerY = e.clientY;
        }
    }

    function onPointerMove(e: PointerEvent | MouseEvent): void {
        if (isPointerLocked) {
            const mx = (e as MouseEvent).movementX ?? 0;
            const my = (e as MouseEvent).movementY ?? 0;
            rotateAzimuth(-mx * SENSITIVITY_LOOK);
            rotatePolar(-my * SENSITIVITY_LOOK);
            return;
        }

        if (isDragging) {
            const dx = e.clientX - lastPointerX;
            const dy = e.clientY - lastPointerY;
            lastPointerX = e.clientX;
            lastPointerY = e.clientY;
            rotateAzimuth(-dx * SENSITIVITY_DRAG);
            rotatePolar(-dy * SENSITIVITY_DRAG);
        }
    }

    function onPointerUp(e: PointerEvent | MouseEvent): void {
        const pe = e as PointerEvent;
        if (isDragging && (pe.pointerId === undefined || pe.pointerId === activePointerId)) {
            isDragging = false;
            activePointerId = -1;
        }
    }

    function onWheel(e: WheelEvent): void {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        const step = Math.max(0.4, targetDistance * 0.12);
        setTargetDistance(targetDistance + Math.sign(e.deltaY) * step);
    }

    function onContextMenu(e: MouseEvent): void {
        if (typeof e.preventDefault === 'function') {
            e.preventDefault();
        }
    }

    function onCanvasClick(): void {
        if (typeof document !== 'undefined' && !document.pointerLockElement && domElement) {
            if (typeof domElement.requestPointerLock === 'function') {
                domElement.requestPointerLock();
            }
        }
    }

    function onBlur(): void {
        isDragging = false;
        activePointerId = -1;
    }

    // Подключение слушателей событий, если есть DOM
    if (domElement && typeof domElement.addEventListener === 'function') {
        domElement.addEventListener('click', onCanvasClick);
        domElement.addEventListener('pointerdown', onPointerDown as EventListener);
        domElement.addEventListener('wheel', onWheel as EventListener, { passive: false });
        domElement.addEventListener('contextmenu', onContextMenu as EventListener);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pointermove', onPointerMove as EventListener);
        window.addEventListener('pointerup', onPointerUp as EventListener);
        window.addEventListener('pointercancel', onPointerUp as EventListener);
        window.addEventListener('blur', onBlur);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('pointerlockchange', onPointerLockChange);
    }

    function follow(dt: number, targetPos: THREE.Vector3, focusHeight = activeFocusHeight, followGain = activeFollowGain): void {
        previousFocus.copy(cameraFocus);
        cameraFocus.lerp(
            followTarget.set(targetPos.x, targetPos.y + focusHeight, targetPos.z),
            1 - Math.exp(-dt * followGain)
        );
        followDelta.subVectors(cameraFocus, previousFocus);

        // Плавное сглаживание сферических углов и дистанции
        const rotLerp = 1 - Math.exp(-dt * 24.0);
        currentTheta = THREE.MathUtils.lerp(currentTheta, targetTheta, rotLerp);
        currentPhi = THREE.MathUtils.lerp(currentPhi, targetPhi, rotLerp);

        const distLerp = 1 - Math.exp(-dt * 10.0);
        currentDistance = THREE.MathUtils.lerp(currentDistance, targetDistance, distLerp);

        // Расчет позиции камеры по сферическим координатам относительно фокуса
        const sinPhi = Math.sin(currentPhi);
        const cosPhi = Math.cos(currentPhi);
        const sinTheta = Math.sin(currentTheta);
        const cosTheta = Math.cos(currentTheta);

        camera.position.set(
            cameraFocus.x + currentDistance * sinPhi * sinTheta,
            cameraFocus.y + currentDistance * cosPhi,
            cameraFocus.z + currentDistance * sinPhi * cosTheta
        );
        camera.lookAt(cameraFocus);

        if (controls && controls.target) {
            controls.target.add(followDelta);
        }
    }

    function keepAboveGround(groundClearance = activeGroundClearance): void {
        const minY = getGroundHeight(camera.position.x, camera.position.z) + groundClearance;
        if (camera.position.y < minY) {
            camera.position.y = minY;
            camera.lookAt(cameraFocus);
        }
    }

    function applyShake(weatherState: { shake: number; time: number } | null | undefined): void {
        if (!weatherState) return;
        const amp = weatherState.shake;
        if (amp <= 0.0005) return;
        const t = weatherState.time;
        shakeOffset.set(
            Math.sin(t * 27.3) * amp,
            Math.sin(t * 33.7 + 1.7) * amp * 0.7,
            Math.cos(t * 23.1) * amp
        );
        camera.position.add(shakeOffset);
    }

    function revertShake(): void {
        if (shakeOffset.lengthSq() > 0) {
            camera.position.sub(shakeOffset);
            shakeOffset.set(0, 0, 0);
        }
    }

    function update(dt: number, targetPos: THREE.Vector3, weatherState?: { shake: number; time: number } | null): void {
        follow(dt, targetPos);
        if (controls && typeof controls.update === 'function') {
            controls.update();
        }
        keepAboveGround();
    }

    function dispose(): void {
        if (domElement && typeof domElement.removeEventListener === 'function') {
            domElement.removeEventListener('click', onCanvasClick);
            domElement.removeEventListener('pointerdown', onPointerDown as EventListener);
            domElement.removeEventListener('wheel', onWheel as EventListener);
            domElement.removeEventListener('contextmenu', onContextMenu as EventListener);
        }
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('pointermove', onPointerMove as EventListener);
            window.removeEventListener('pointerup', onPointerUp as EventListener);
            window.removeEventListener('pointercancel', onPointerUp as EventListener);
            window.removeEventListener('blur', onBlur);
        }
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('pointerlockchange', onPointerLockChange);
        }
    }

    return {
        follow,
        keepAboveGround,
        applyShake,
        revertShake,
        update,
        setActorCamera,
        rotateAzimuth,
        rotatePolar,
        setTargetDistance,
        getTargetDistance: () => targetDistance,
        getAzimuth: () => currentTheta,
        getPolar: () => currentPhi,
        isPointerLocked: () => isPointerLocked,
        isDragging: () => isDragging,
        dispose,
        cameraFocus
    };
}

