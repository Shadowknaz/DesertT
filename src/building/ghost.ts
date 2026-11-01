// Полупрозрачный «призрак» (Ghost) выбранного строительного модуля,
// визуализатор сокетов и контур радиуса допустимой дистанции строительства.
// Зелёный полупрозрачный материал — когда canPlace(def, cell, rot) === true.
// Красный полупрозрачный материал — когда размещение невозможно (в т.ч. слишком далеко).
import * as THREE from 'three';
import { CELL_SIZE, MAX_BUILD_DISTANCE } from './catalog.ts';
import { getBakedPrefabAsset } from './prefabs.ts';
import type { PieceType, WorldSocket } from './types.ts';

const MAX_SOCKET_MARKERS = 64;
const RANGE_RING_SEGMENTS = 64;

export class BuildingGhost {
    public readonly root = new THREE.Group();
    private readonly ghostMesh: THREE.Mesh;
    private readonly cellRing: THREE.LineSegments;
    private readonly rangeRing: THREE.LineSegments;
    private readonly rangeRingGeo: THREE.BufferGeometry;
    private readonly socketMarkers: THREE.InstancedMesh;
    private readonly activeSocketBeacon: THREE.Mesh;

    private readonly matValid: THREE.MeshStandardMaterial;
    private readonly matInvalid: THREE.MeshStandardMaterial;
    private readonly ringMatValid: THREE.LineBasicMaterial;
    private readonly ringMatInvalid: THREE.LineBasicMaterial;
    private readonly rangeMatNormal: THREE.LineBasicMaterial;
    private readonly rangeMatTooFar: THREE.LineBasicMaterial;

    private currentType: PieceType = 'foundation';
    private isValid = true;
    private isTooFar = false;
    private isSoftwareGl = false;

    constructor(isSoftwareGl = false) {
        this.isSoftwareGl = isSoftwareGl;
        this.root.name = 'BuildingGhostGroup';
        this.root.visible = false;

        // Зеленый материал валидного размещения
        this.matValid = new THREE.MeshStandardMaterial({
            color: 0x2ecc71,
            emissive: 0x0f5c2e,
            emissiveIntensity: 0.55,
            roughness: 0.35,
            metalness: 0.15,
            transparent: true,
            opacity: 0.54,
            depthWrite: false
        });

        // Красный материал невалидного размещения
        this.matInvalid = new THREE.MeshStandardMaterial({
            color: 0xe74c3c,
            emissive: 0x6e140c,
            emissiveIntensity: 0.6,
            roughness: 0.4,
            metalness: 0.15,
            transparent: true,
            opacity: 0.54,
            depthWrite: false
        });

        const initialAsset = getBakedPrefabAsset(this.currentType, this.isSoftwareGl);
        this.ghostMesh = new THREE.Mesh(initialAsset.geometry, this.matValid);
        this.ghostMesh.name = 'BuildingGhostMesh';
        this.ghostMesh.renderOrder = 20;
        this.ghostMesh.frustumCulled = false;
        this.root.add(this.ghostMesh);

        // Контур клетки сетки 3.2 × 3.2 м
        const half = CELL_SIZE * 0.5;
        const ringPts = [
            new THREE.Vector3(-half, 0.05, -half),
            new THREE.Vector3(half, 0.05, -half),
            new THREE.Vector3(half, 0.05, -half),
            new THREE.Vector3(half, 0.05, half),
            new THREE.Vector3(half, 0.05, half),
            new THREE.Vector3(-half, 0.05, half),
            new THREE.Vector3(-half, 0.05, half),
            new THREE.Vector3(-half, 0.05, -half)
        ];
        const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
        this.ringMatValid = new THREE.LineBasicMaterial({
            color: 0x4dff9b,
            transparent: true,
            opacity: 0.85
        });
        this.ringMatInvalid = new THREE.LineBasicMaterial({
            color: 0xff5a4d,
            transparent: true,
            opacity: 0.85
        });
        this.cellRing = new THREE.LineSegments(ringGeo, this.ringMatValid);
        this.cellRing.frustumCulled = false;
        this.root.add(this.cellRing);

        // Пунктирный круг радиуса максимальной дистанции строительства вокруг персонажа
        const rangePts: THREE.Vector3[] = [];
        for (let i = 0; i < RANGE_RING_SEGMENTS; i += 2) {
            const a0 = (i / RANGE_RING_SEGMENTS) * Math.PI * 2;
            const a1 = ((i + 1) / RANGE_RING_SEGMENTS) * Math.PI * 2;
            rangePts.push(new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0)));
            rangePts.push(new THREE.Vector3(Math.cos(a1), 0, Math.sin(a1)));
        }
        this.rangeRingGeo = new THREE.BufferGeometry().setFromPoints(rangePts);
        this.rangeMatNormal = new THREE.LineBasicMaterial({
            color: 0xd89c4a,
            transparent: true,
            opacity: 0.42
        });
        this.rangeMatTooFar = new THREE.LineBasicMaterial({
            color: 0xff4d3d,
            transparent: true,
            opacity: 0.82
        });
        this.rangeRing = new THREE.LineSegments(this.rangeRingGeo, this.rangeMatNormal);
        this.rangeRing.scale.set(MAX_BUILD_DISTANCE, 1, MAX_BUILD_DISTANCE);
        this.rangeRing.frustumCulled = false;
        this.root.add(this.rangeRing);

        // Инстансированные маркеры совместимых сокетов поблизости
        const markerGeo = new THREE.OctahedronGeometry(0.14, 0);
        const markerMat = new THREE.MeshBasicMaterial({
            color: 0xffb830,
            wireframe: false,
            transparent: true,
            opacity: 0.82
        });
        this.socketMarkers = new THREE.InstancedMesh(markerGeo, markerMat, MAX_SOCKET_MARKERS);
        this.socketMarkers.count = 0;
        this.socketMarkers.frustumCulled = false;
        this.socketMarkers.renderOrder = 22;
        this.root.add(this.socketMarkers);

        // Яркий маячок активного (примагниченного) сокета
        const beaconGeo = new THREE.OctahedronGeometry(0.24, 0);
        const beaconMat = new THREE.MeshBasicMaterial({
            color: 0x38ff9c,
            wireframe: true,
            transparent: true,
            opacity: 0.95
        });
        this.activeSocketBeacon = new THREE.Mesh(beaconGeo, beaconMat);
        this.activeSocketBeacon.visible = false;
        this.activeSocketBeacon.frustumCulled = false;
        this.activeSocketBeacon.renderOrder = 25;
        this.root.add(this.activeSocketBeacon);
    }

    public setVisible(visible: boolean): void {
        this.root.visible = visible;
    }

    public setPieceType(type: PieceType): void {
        if (this.currentType === type) return;
        this.currentType = type;
        const asset = getBakedPrefabAsset(type, this.isSoftwareGl);
        this.ghostMesh.geometry = asset.geometry;
    }

    public updateTransform(
        worldPos: { x: number; y: number; z: number },
        rotationY: number,
        cellCenterWorld: { x: number; y: number; z: number },
        valid: boolean,
        compatibleSockets: WorldSocket[],
        snappedSocket: WorldSocket | null,
        elapsedSec = 0,
        builderOrigin?: { x: number; y: number; z: number } | null,
        maxDistance = MAX_BUILD_DISTANCE,
        tooFar = false,
        sampleGroundY?: (wx: number, wz: number) => number
    ): void {
        this.ghostMesh.position.set(worldPos.x, worldPos.y, worldPos.z);
        this.ghostMesh.rotation.set(0, rotationY, 0);

        this.cellRing.position.set(cellCenterWorld.x, cellCenterWorld.y, cellCenterWorld.z);

        if (this.isValid !== valid) {
            this.isValid = valid;
            this.ghostMesh.material = valid ? this.matValid : this.matInvalid;
            this.cellRing.material = valid ? this.ringMatValid : this.ringMatInvalid;
        }

        if (this.isTooFar !== tooFar) {
            this.isTooFar = tooFar;
            this.rangeRing.material = tooFar ? this.rangeMatTooFar : this.rangeMatNormal;
        }

        if (builderOrigin) {
            this.rangeRing.visible = true;
            this.rangeRing.position.set(builderOrigin.x, 0, builderOrigin.z);
            this.rangeRing.scale.set(1, 1, 1);
            const posAttr = this.rangeRingGeo.getAttribute('position') as THREE.BufferAttribute;
            let idx = 0;
            for (let i = 0; i < RANGE_RING_SEGMENTS; i += 2) {
                const a0 = (i / RANGE_RING_SEGMENTS) * Math.PI * 2;
                const a1 = ((i + 1) / RANGE_RING_SEGMENTS) * Math.PI * 2;
                const x0 = Math.cos(a0) * maxDistance;
                const z0 = Math.sin(a0) * maxDistance;
                const x1 = Math.cos(a1) * maxDistance;
                const z1 = Math.sin(a1) * maxDistance;
                const y0 = sampleGroundY ? sampleGroundY(builderOrigin.x + x0, builderOrigin.z + z0) + 0.14 : builderOrigin.y + 0.14;
                const y1 = sampleGroundY ? sampleGroundY(builderOrigin.x + x1, builderOrigin.z + z1) + 0.14 : builderOrigin.y + 0.14;
                posAttr.setXYZ(idx++, x0, y0, z0);
                posAttr.setXYZ(idx++, x1, y1, z1);
            }
            posAttr.needsUpdate = true;
        } else {
            this.rangeRing.visible = false;
        }

        // Легкая пульсация прозрачности призрака
        const pulse = 0.48 + Math.sin(elapsedSec * 6.0) * 0.08;
        (this.ghostMesh.material as THREE.MeshStandardMaterial).opacity = pulse;

        // Обновляем маркеры ближайших совместимых сокетов
        const count = Math.min(MAX_SOCKET_MARKERS, compatibleSockets.length);
        this.socketMarkers.count = count;
        const dummyMat = new THREE.Matrix4();
        const dummyPos = new THREE.Vector3();
        const dummyQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), elapsedSec * 2.2);
        const dummyScale = new THREE.Vector3(1, 1, 1);

        for (let i = 0; i < count; i++) {
            const s = compatibleSockets[i];
            dummyPos.set(s.worldPos.x, s.worldPos.y + 0.06, s.worldPos.z);
            dummyMat.compose(dummyPos, dummyQuat, dummyScale);
            this.socketMarkers.setMatrixAt(i, dummyMat);
        }
        this.socketMarkers.instanceMatrix.needsUpdate = true;

        if (snappedSocket) {
            this.activeSocketBeacon.visible = true;
            this.activeSocketBeacon.position.set(
                snappedSocket.worldPos.x,
                snappedSocket.worldPos.y + 0.08,
                snappedSocket.worldPos.z
            );
            this.activeSocketBeacon.rotation.y = -elapsedSec * 3.5;
        } else {
            this.activeSocketBeacon.visible = false;
        }
    }

    public getGhostMaterialColorHex(): number {
        return (this.ghostMesh.material as THREE.MeshStandardMaterial).color.getHex();
    }

    public dispose(): void {
        this.matValid.dispose();
        this.matInvalid.dispose();
        this.ringMatValid.dispose();
        this.ringMatInvalid.dispose();
        this.rangeRingGeo.dispose();
        this.rangeMatNormal.dispose();
        this.rangeMatTooFar.dispose();
        this.socketMarkers.geometry.dispose();
        (this.socketMarkers.material as THREE.Material).dispose();
        this.activeSocketBeacon.geometry.dispose();
        (this.activeSocketBeacon.material as THREE.Material).dispose();
    }
}
