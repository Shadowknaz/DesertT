// Динамическая погода пустыни: медленная смена состояний, порывы ветра и буря.
// Модуль владеет всеми таймерами и выдает единый снимок состояния, из которого
// берут данные туман, облака, песчаные частицы, локомотив и деформация песка.
// Погода меняется сама; setMode / cycle позволяют задать ее вручную.
// Воспроизводимость событий обеспечивается через seeded RNG.
import * as THREE from 'three';
import { PALETTE, SAND, SKY, WEATHER } from '../config.ts';
import { fbm } from '../core/noise.ts';
import { sampleWind } from '../core/windField.ts';
import { createRng, type Rng } from '../core/rng.ts';

const TAU = Math.PI * 2;

// Туман выводится без sRGB-кодирования, поэтому запасные цвета готовятся
// сразу в экранном пространстве.
const FOG_CALM_FALLBACK = new THREE.Color(PALETTE.fog).convertLinearToSRGB();
const FOG_STORM_FALLBACK = new THREE.Color(PALETTE.stormFog).convertLinearToSRGB();

export interface WeatherState {
    mode: string;
    intensity: number;
    target: number;
    gust: number;
    time: number;
    windX: number;
    windZ: number;
    windSpeed: number;
    dirX: number;
    dirZ: number;
    erosionRate: number;
    speedMultiplier: number;
    shake: number;
    coat: number;
    cloud: number;
    cloudTarget: number;
    fogColor: THREE.Color;
}

export interface WeatherOptions {
    scene: THREE.Scene & { fog?: THREE.FogExp2 | any };
    autoCycle?: boolean;
    seed?: number;
    rng?: Rng | null;
}

export interface Weather {
    update(dt: number, focus?: THREE.Vector3 | { x: number; z: number } | null, day?: any): WeatherState;
    setMode(mode: string, options?: { instant?: boolean }): void;
    cycle(): void;
    setCloudOverride(value: number | null): void;
    sampleWindInto<T extends { set(x: number, y: number, z: number): any }>(out: T, x: number, z: number): T;
    dispose(): void;
    state: WeatherState;
    rng: Rng;
}

export function createWeather({ scene, autoCycle = WEATHER.autoCycle, seed = 1337, rng = null }: WeatherOptions): Weather {
    const weatherRng = rng || createRng(seed);

    // Цвета тумана переиспользуются: спокойный приходит из снимка суток,
    // бурый — из палитры бури, ослабленной ночью.
    const fogCalm = new THREE.Color().copy(FOG_CALM_FALLBACK);
    const fogStorm = new THREE.Color().copy(FOG_STORM_FALLBACK);

    const windSample = new THREE.Vector3();
    const initial = WEATHER.presets.breeze.intensity;
    const initialCloud = WEATHER.presets.breeze.cloud;

    function randomBetween(min: number, max: number): number {
        return weatherRng.between(min, max);
    }

    // Снимок погоды: переиспользуется каждый кадр, поэтому потребители
    // (частицы, локомотив, стриминг) не создают мусор.
    const state: WeatherState = {
        mode: 'breeze',
        intensity: initial,
        target: initial,
        gust: 0.0,
        time: 0.0,
        windX: 0.0,
        windZ: 0.0,
        windSpeed: WEATHER.windCalm,
        dirX: 1.0,
        dirZ: 0.0,
        erosionRate: SAND.erodeCalm,
        speedMultiplier: 1.0,
        shake: 0.0,
        coat: 0.0,
        cloud: initialCloud,
        cloudTarget: initialCloud,
        fogColor: new THREE.Color(PALETTE.fog).convertLinearToSRGB()
    };

    let dwellTimer = randomBetween(WEATHER.dwellMin, WEATHER.dwellMax);
    let gustTimer = randomBetween(WEATHER.gustIntervalMin, WEATHER.gustIntervalMax);
    let gustTarget = 0.0;
    const baseAngle = weatherRng.between(0, TAU);
    let cloudBase = initialCloud;
    let cloudOverride: number | null = null;

    function setMode(mode: string, { instant = false }: { instant?: boolean } = {}): void {
        const preset = WEATHER.presets[mode];
        if (!preset) return;
        state.mode = mode;
        state.target = preset.intensity;
        state.cloudTarget = preset.cloud !== undefined ? preset.cloud : 0.2;
        dwellTimer = randomBetween(WEATHER.dwellMin, WEATHER.dwellMax);
        if (instant) {
            state.intensity = preset.intensity;
            cloudBase = state.cloudTarget;
            state.cloud = state.cloudTarget;
        }
    }

    // Ручная облачность для демо: ?clouds=0.6. Держится поверх пресетов.
    function setCloudOverride(value: number | null): void {
        cloudOverride = value === null || value === undefined
            ? null
            : THREE.MathUtils.clamp(value, 0.0, 1.0);
    }

    function cycle(): void {
        const index = WEATHER.order.indexOf(state.mode as any);
        setMode(WEATHER.order[(index + 1) % WEATHER.order.length]);
    }

    // Взвешенный выбор: чаще всего легкий ветер, буря — редкий гость.
    // Кумулятивные пороги берутся из WEATHER.modeWeights в порядке order.
    function pickNextMode(): string {
        const roll = weatherRng.next();
        let acc = 0.0;
        for (const mode of WEATHER.order) {
            acc += WEATHER.modeWeights[mode];
            if (roll < acc) return mode;
        }
        return WEATHER.order[WEATHER.order.length - 1];
    }

    function update(dt: number, focus?: THREE.Vector3 | { x: number; z: number } | null, day: any = null): WeatherState {
        state.time += dt;

        // Самопроизвольная смена погоды по таймеру «отстоя»
        if (autoCycle) {
            dwellTimer -= dt;
            if (dwellTimer <= 0.0) setMode(pickNextMode());
        }

        // Погода разгоняется и стихает экспоненциально
        const ramp = 1.0 - Math.exp(-dt / Math.max(0.01, WEATHER.rampTime * WEATHER.rampFraction));
        state.intensity += (state.target - state.intensity) * ramp;

        // Облачность тянется к пресету и медленно гуляет сама по себе
        cloudBase += (state.cloudTarget - cloudBase) * ramp;
        const cloudWander = (fbm(state.time * SKY.cloud.coverageTimeScale, 5.1, 2) - 0.5) * SKY.cloud.coverageDrift;
        state.cloud = THREE.MathUtils.clamp(
            (cloudOverride !== null ? cloudOverride : cloudBase) + cloudWander,
            0.0, 1.0
        );

        // Направление ветра медленно гуляет вокруг базового угла
        const wander = fbm(state.time * WEATHER.wanderTimeScale, WEATHER.wanderSeed, 2) * WEATHER.dirWander;
        const angle = baseAngle + wander;
        state.dirX = Math.cos(angle);
        state.dirZ = Math.sin(angle);

        const storm = THREE.MathUtils.clamp(state.intensity, 0.0, 1.0);

        // Порывы: короткие усиления поверх постоянного ветра
        gustTimer -= dt;
        if (gustTimer <= 0.0) {
            gustTarget = Math.min(1.0, (WEATHER.gustMin + weatherRng.next() * WEATHER.gustSpread) * (WEATHER.gustStormBias + storm * WEATHER.gustStormGain));
            gustTimer = randomBetween(WEATHER.gustIntervalMin, WEATHER.gustIntervalMax) * (1.0 - storm * WEATHER.gustStormHold);
        }
        gustTarget *= Math.exp(-dt * WEATHER.gustFade);
        state.gust += (gustTarget - state.gust) * (1.0 - Math.exp(-dt * WEATHER.gustResponse));

        state.windSpeed = THREE.MathUtils.lerp(WEATHER.windCalm, WEATHER.windStorm, storm) *
            (1.0 + state.gust * WEATHER.gustStrength);

        // Локальный ветер у меха: завихрения и порывы вокруг среднего потока
        const fx = focus ? (focus as any).x : 0.0;
        const fz = focus ? (focus as any).z : 0.0;
        const turbulence = WEATHER.turbulenceCalm + storm * WEATHER.turbulenceStorm;
        sampleWind(windSample, fx, fz, state.time, state.dirX, state.dirZ, state.windSpeed, turbulence);
        state.windX = windSample.x;
        state.windZ = windSample.z;

        // Производные эффекты: эрозия песка, ход меха, тряска, пыль на броне
        state.erosionRate = THREE.MathUtils.lerp(SAND.erodeCalm, SAND.erodeStorm, storm * storm);
        state.speedMultiplier = 1.0 - WEATHER.speedPenalty * storm;
        state.shake = WEATHER.shake * storm * storm * (WEATHER.shakeGustBias + state.gust * WEATHER.shakeGustSpread);
        state.coat = WEATHER.coat * storm;

        // Туман: буря съедает горизонт, ночью и днем плотность одна,
        // а цвет спокойного тумана приходит из палитры суток.
        const fogMix = Math.pow(storm, WEATHER.fogExponent);
        if (day) {
            fogCalm.copy(day.fogColor);
            fogStorm.copy(day.stormFog);
        } else {
            fogCalm.copy(FOG_CALM_FALLBACK);
            fogStorm.copy(FOG_STORM_FALLBACK);
        }
        if (scene.fog) {
            scene.fog.density = THREE.MathUtils.lerp(WEATHER.fogCalm, WEATHER.fogStorm, fogMix);
            state.fogColor.copy(fogCalm).lerp(fogStorm, fogMix);
            scene.fog.color.copy(state.fogColor);
        }

        return state;
    }

    // Локальный ветер в произвольной точке — для частиц и мелких предметов
    function sampleWindInto<T extends { set(x: number, y: number, z: number): any }>(out: T, x: number, z: number): T {
        return sampleWind(
            out, x, z, state.time,
            state.dirX, state.dirZ, state.windSpeed,
            WEATHER.turbulenceCalm + state.intensity * WEATHER.turbulenceStorm
        );
    }

    function dispose(): void {}

    return { update, setMode, cycle, setCloudOverride, sampleWindInto, dispose, state, rng: weatherRng };
}
