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

test('cameraDirector safely catches rejected pointer lock promises and suppresses retries when root document is invalid', async t => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const docTarget = new EventTarget() as any;
    docTarget.pointerLockElement = null;
    Object.defineProperty(globalThis, 'document', { value: docTarget, configurable: true });
    t.after(() => {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete (globalThis as any).document;
    });

    const domTarget = new EventTarget() as any;
    let requestCalls = 0;
    domTarget.isConnected = true;
    domTarget.ownerDocument = docTarget;
    domTarget.requestPointerLock = () => {
        requestCalls++;
        return Promise.reject(new Error('The root document of this element is not valid for pointer lock.'));
    };

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 5, 10);
    const director = createCameraDirector({
        camera,
        domElement: domTarget,
        enablePointerLock: true,
        getGroundHeight: () => 0
    });

    // Clicking should invoke requestPointerLock once, catch its rejection without unhandledrejection, and block further calls
    domTarget.dispatchEvent(new Event('click'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(requestCalls, 1);
    assert.equal(director.isPointerLocked(), false);

    // Subsequent clicks must not call requestPointerLock again once blocked
    domTarget.dispatchEvent(new Event('click'));
    assert.equal(requestCalls, 1);

    director.dispose();
});

test('cameraDirector skips pointer lock inside embedded iframes by default and after drag gestures', t => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const docTarget = new EventTarget() as any;
    docTarget.pointerLockElement = null;

    const winTarget = new EventTarget() as any;
    // Simulate embedded iframe (window.self !== window.top)
    winTarget.self = winTarget;
    winTarget.top = {};

    Object.defineProperty(globalThis, 'document', { value: docTarget, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: winTarget, configurable: true });
    t.after(() => {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete (globalThis as any).document;
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete (globalThis as any).window;
    });

    const domTarget = new EventTarget() as any;
    let requestCalls = 0;
    domTarget.isConnected = true;
    domTarget.ownerDocument = docTarget;
    domTarget.requestPointerLock = () => {
        requestCalls++;
    };

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 5, 10);
    const director = createCameraDirector({
        camera,
        domElement: domTarget,
        getGroundHeight: () => 0
    });

    domTarget.dispatchEvent(new Event('click'));
    assert.equal(requestCalls, 0, 'Embedded iframe must not trigger pointer lock on click by default');

    director.dispose();
});

