// Подсистема выбора объектов (raycast / picking).
// Изолирует THREE.Raycaster и возвращает структурированный PickResult:
// { hit, point, normal, object, pickKind, distance }.
import * as THREE from 'three';

export interface PickResult {
    hit: boolean;
    point: THREE.Vector3 | null;
    normal: THREE.Vector3 | null;
    object: THREE.Object3D | null;
    pickKind: string | null;
    distance: number;
}

export interface PickerOptions {
    camera?: THREE.Camera;
    getPickables?: (() => THREE.Object3D[]) | THREE.Object3D[] | null;
    getSandMeshes?: (() => THREE.Object3D[]) | THREE.Object3D[] | null;
    defaultPickKind?: string;
}

export interface Picker {
    pick(
        coords: { clientX?: number; clientY?: number; x?: number; y?: number },
        options?: { viewportWidth?: number; viewportHeight?: number }
    ): PickResult;
    raycaster: THREE.Raycaster;
}

export function createPicker({
    camera,
    getPickables = null,
    getSandMeshes = null,
    defaultPickKind = 'ground'
}: PickerOptions = {}): Picker {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const normalMatrix = new THREE.Matrix3();
    const getTargets = getPickables || getSandMeshes;

    function clientToNdc(clientX: number, clientY: number, viewportWidth: number, viewportHeight: number): THREE.Vector2 {
        pointer.x = (clientX / viewportWidth) * 2 - 1;
        pointer.y = -(clientY / viewportHeight) * 2 + 1;
        return pointer;
    }

    function findPickKind(object: THREE.Object3D | null): string | null {
        let current: THREE.Object3D | null = object;
        while (current) {
            if (current.userData && current.userData.pickKind) {
                return current.userData.pickKind as string;
            }
            current = current.parent;
        }
        return null;
    }

    function pick(
        coords: { clientX?: number; clientY?: number; x?: number; y?: number },
        {
            viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 800,
            viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 600
        }: { viewportWidth?: number; viewportHeight?: number } = {}
    ): PickResult {
        if (!camera || !getTargets) {
            return { hit: false, point: null, normal: null, object: null, pickKind: null, distance: Infinity };
        }

        let ndc: THREE.Vector2;
        if (coords.clientX !== undefined && coords.clientY !== undefined) {
            ndc = clientToNdc(coords.clientX, coords.clientY, viewportWidth, viewportHeight);
        } else if (coords.x !== undefined && coords.y !== undefined) {
            ndc = coords as THREE.Vector2;
        } else {
            return { hit: false, point: null, normal: null, object: null, pickKind: null, distance: Infinity };
        }

        raycaster.setFromCamera(ndc, camera);

        const targets = typeof getTargets === 'function' ? getTargets() : getTargets;
        if (!targets) {
            return { hit: false, point: null, normal: null, object: null, pickKind: null, distance: Infinity };
        }

        const intersects = raycaster.intersectObjects(targets, false);
        if (intersects.length === 0) {
            return { hit: false, point: null, normal: null, object: null, pickKind: null, distance: Infinity };
        }

        const hit = intersects[0];
        const pickKind = findPickKind(hit.object) || defaultPickKind;

        let worldNormal: THREE.Vector3 | null = null;
        if (hit.face && hit.face.normal) {
            normalMatrix.getNormalMatrix(hit.object.matrixWorld);
            worldNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
        }

        return {
            hit: true,
            point: hit.point,
            normal: worldNormal,
            object: hit.object,
            pickKind,
            distance: hit.distance
        };
    }

    return { pick, raycaster };
}
