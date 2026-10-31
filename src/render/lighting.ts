// Освещение пустыни: днем ключевой свет — солнце, ночью — луна.
// Палитра суток задает цвет и силу ключевого, заполняющего и контрового света,
// а погода поверх нее гасит ключ и подмешивает охру песчаной взвеси.
import * as THREE from 'three';
import { PALETTE, RENDER, WEATHER } from '../config.ts';

const KEY_DISTANCE = 40.0;   // Насколько далеко ключевой свет от меха
const RIM_DISTANCE = 30.0;   // Контровой свет с противоположной стороны

export interface DayLightingSnapshot {
    keyColor: THREE.Color;
    keyIntensity: number;
    keyDir: THREE.Vector3;
    ambientColor: THREE.Color;
    ambientIntensity: number;
    rimColor: THREE.Color;
    rimIntensity: number;
    stormSun: THREE.Color;
    stormAmbient: THREE.Color;
}

export interface WeatherLightingSnapshot {
    intensity: number;
    cloud: number;
}

export interface DesertLighting {
    ambientLight: THREE.AmbientLight;
    sunLight: THREE.DirectionalLight;
    rimLight: THREE.DirectionalLight;
    update(focus: THREE.Vector3, day: DayLightingSnapshot, weather?: WeatherLightingSnapshot | null): void;
    dispose(): void;
}

export function createDesertLighting(scene: THREE.Scene): DesertLighting {
    const ambientLight = new THREE.AmbientLight(PALETTE.ambient, 1.25);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(PALETTE.sun, 2.5);
    sunLight.position.set(22, 34, 16);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = RENDER.shadowMapSize;
    sunLight.shadow.mapSize.height = RENDER.shadowMapSize;
    sunLight.shadow.camera.near = 5;
    sunLight.shadow.camera.far = 85;
    const d = 19;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.002;
    scene.add(sunLight);
    // Цель света должна быть в сцене, иначе ее матрица не обновляется
    scene.add(sunLight.target);

    const rimLight = new THREE.DirectionalLight(PALETTE.rim, 0.9);
    rimLight.position.set(-20, 10, -18);
    scene.add(rimLight);

    // Ключевой свет едет вместе с мехом: фрустум теней тесен, а мир бесконечен.
    // Стороны света берутся из снимка суток, погода гасит и красит поверх.
    function update(focus: THREE.Vector3, day: DayLightingSnapshot, weather?: WeatherLightingSnapshot | null): void {
        const storm = weather ? THREE.MathUtils.clamp(weather.intensity, 0.0, 1.0) : 0.0;
        const cloud = weather ? weather.cloud : 0.0;
        const cloudDim = 1.0 - 0.22 * cloud;

        sunLight.color.copy(day.keyColor).lerp(day.stormSun, storm * 0.85);
        sunLight.intensity = day.keyIntensity * cloudDim * (1.0 - WEATHER.sunDim * storm);
        sunLight.position.copy(focus).addScaledVector(day.keyDir, KEY_DISTANCE);
        sunLight.target.position.copy(focus);
        sunLight.target.updateMatrixWorld();

        ambientLight.color.copy(day.ambientColor).lerp(day.stormAmbient, storm * 0.6);
        ambientLight.intensity = day.ambientIntensity * (1.0 + WEATHER.ambientBoost * storm) * (1.0 + 0.08 * cloud);

        rimLight.color.copy(day.rimColor).lerp(day.stormAmbient, storm * 0.5);
        rimLight.intensity = day.rimIntensity * (1.0 - 0.6 * storm);
        rimLight.position.copy(focus).addScaledVector(day.keyDir, -RIM_DISTANCE);
        rimLight.position.y += 10.0;
    }

    function dispose(): void {
        if (ambientLight.parent) ambientLight.parent.remove(ambientLight);
        if (sunLight.parent) sunLight.parent.remove(sunLight);
        if (sunLight.target.parent) sunLight.target.parent.remove(sunLight.target);
        if (rimLight.parent) rimLight.parent.remove(rimLight);
    }

    return { ambientLight, sunLight, rimLight, update, dispose };
}

