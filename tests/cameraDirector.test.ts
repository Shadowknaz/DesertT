import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCameraDirector } from '../src/control/cameraDirector.ts';

test('cameraDirector follow updates camera and controls target', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 5, 10);
    const controls = { target: new THREE.Vector3(0, 0, 0), update: () => {} };

    const director = createCameraDirector({
        camera,
        controls,
        getGroundHeight: () => 0,
        config: { focusHeight: 1.0, followGain: 10.0, groundClearance: 1.5 }
    });

    const targetPos = new THREE.Vector3(10, 0, 10);
    director.follow(0.5, targetPos);

    assert.ok(camera.position.x > 0);
    assert.ok(controls.target.x > 0);
});

test('cameraDirector keepAboveGround clamps camera Y above ground', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 1.0, 0); // Y = 1.0
    const controls = { target: new THREE.Vector3(0, 0, 0), update: () => {} };

    const director = createCameraDirector({
        camera,
        controls,
        getGroundHeight: () => 2.0, // Dune height = 2.0
        config: { focusHeight: 1.0, followGain: 10.0, groundClearance: 1.8 } // Min Y = 3.8
    });

    director.keepAboveGround();
    assert.equal(camera.position.y, 3.8);
});

test('cameraDirector applies and reverts camera shake', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const startPos = new THREE.Vector3(0, 5, 10);
    camera.position.copy(startPos);
    const controls = { target: new THREE.Vector3(0, 0, 0), update: () => {} };

    const director = createCameraDirector({
        camera,
        controls,
        getGroundHeight: () => 0
    });

    const weatherState = { shake: 0.1, time: 5.0 };
    director.applyShake(weatherState);

    assert.notDeepEqual(camera.position, startPos);

    director.revertShake();
    assert.ok(Math.abs(camera.position.x - startPos.x) < 1e-6);
    assert.ok(Math.abs(camera.position.y - startPos.y) < 1e-6);
    assert.ok(Math.abs(camera.position.z - startPos.z) < 1e-6);
});

test('cameraDirector setActorCamera transitions distance and limits for Cosmo', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(13, 4, 15);
    const director = createCameraDirector({
        camera,
        getGroundHeight: () => 0,
        config: { focusHeight: 0.5, followGain: 10.0, groundClearance: 1.5, minDistance: 8, maxDistance: 70 }
    });

    assert.equal(director.getTargetDistance(), Math.hypot(13, 3.5, 15));

    // Switch to Cosmo config
    director.setActorCamera({
        focusHeight: 1.25,
        followGain: 12.0,
        groundClearance: 1.1,
        minDistance: 1.8,
        maxDistance: 18.0,
        defaultDistance: 4.5
    });

    assert.equal(director.getTargetDistance(), 4.5);

    // Try zooming closer than minDistance
    director.setTargetDistance(0.5);
    assert.equal(director.getTargetDistance(), 1.8);

    // Try zooming further than maxDistance
    director.setTargetDistance(50.0);
    assert.equal(director.getTargetDistance(), 18.0);
});

test('cameraDirector rotates azimuth and polar with clamping', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 5, 10);
    const director = createCameraDirector({
        camera,
        getGroundHeight: () => 0
    });

    const az0 = director.getAzimuth();
    director.rotateAzimuth(0.5);
    // After follow with dt, currentTheta lerps towards target
    director.follow(0.5, new THREE.Vector3(0, 0, 0));
    assert.ok(director.getAzimuth() > az0);

    // Polar angle clamps and cannot go negative or flip upside down
    director.rotatePolar(-10.0);
    director.follow(0.5, new THREE.Vector3(0, 0, 0));
    assert.ok(director.getPolar() >= 0.08);

    director.rotatePolar(10.0);
    director.follow(0.5, new THREE.Vector3(0, 0, 0));
    assert.ok(director.getPolar() <= Math.PI * 0.48);
});
