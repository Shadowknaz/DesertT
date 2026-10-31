import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPicker } from '../src/input/picking.ts';

test('createPicker performs raycasting and returns PickResult with world normal', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 10, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const geometry = new THREE.PlaneGeometry(10, 10);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2; // Face points straight up in world +Y
    mesh.updateMatrixWorld();

    const picker = createPicker({
        camera,
        getPickables: () => [mesh]
    });

    const result = picker.pick({ clientX: 400, clientY: 300 }, { viewportWidth: 800, viewportHeight: 600 });
    assert.equal(result.hit, true);
    assert.ok(result.point instanceof THREE.Vector3);
    assert.equal(result.pickKind, 'ground');
    assert.equal(result.object, mesh);
    assert.ok(result.normal instanceof THREE.Vector3);
    assert.ok(Math.abs(result.normal.y - 1.0) < 1e-5, 'world normal should point up (+Y)');
});

test('createPicker traverses parents to find userData.pickKind', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 5, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const parentGroup = new THREE.Group();
    parentGroup.userData = { pickKind: 'actorGroup' };

    const childMesh = new THREE.Mesh(new THREE.PlaneGeometry(5, 5));
    childMesh.rotation.x = -Math.PI / 2;
    parentGroup.add(childMesh);
    parentGroup.updateMatrixWorld(true);

    const picker = createPicker({
        camera,
        getPickables: [childMesh]
    });

    const result = picker.pick({ clientX: 400, clientY: 300 }, { viewportWidth: 800, viewportHeight: 600 });
    assert.equal(result.hit, true);
    assert.equal(result.pickKind, 'actorGroup');
});

test('createPicker returns hit: false when ray misses', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 10, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const picker = createPicker({
        camera,
        getPickables: () => []
    });

    const result = picker.pick({ clientX: 400, clientY: 300 }, { viewportWidth: 800, viewportHeight: 600 });
    assert.equal(result.hit, false);
    assert.equal(result.point, null);
});
