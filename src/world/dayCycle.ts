// Сутки пустыни: часы, орбита солнца и луны и палитра неба по ключевым кадрам.
// Модуль выдает единый снимок dayState, из которого рисуют небо и свет,
// но сам ничего не знает ни о сцене, ни о погоде.
import * as THREE from 'three';
import { PALETTE, SKY } from '../config.ts';

const TAU = Math.PI * 2;

export interface DayState {
    timeOfDay: number;
    hours: number;
    minutes: number;
    phase: string;

    sunDir: THREE.Vector3;
    moonDir: THREE.Vector3;
    keyDir: THREE.Vector3;
    sunElevation: number;     // sin высоты солнца, -1..1
    moonElevation: number;
    keyElevation: number;

    keyColor: THREE.Color;
    sunColor: THREE.Color;
    keyIntensity: number;
    ambientColor: THREE.Color;
    ambientIntensity: number;
    rimColor: THREE.Color;
    rimIntensity: number;

    zenith: THREE.Color;
    horizon: THREE.Color;
    fogColor: THREE.Color;
    stormFog: THREE.Color;
    stormAmbient: THREE.Color;
    stormSun: THREE.Color;
    cloudLit: THREE.Color;
    cloudShade: THREE.Color;

    stars: number;
    stormTint: number;
    dayFactor: number;
}

export interface DayCycleOptions {
    startTime?: number;
    cycleSeconds?: number;
    autoAdvance?: boolean;
}

export interface DayCycle {
    update(dt: number): DayState;
    setTime(value: number): DayState;
    addTime(delta: number): void;
    setTimeScale(value: number): void;
    cycleTimeScale(): number;
    getTimeScale(): number;
    state: DayState;
}

// Ключевые кадры готовятся один раз: цвета не должны создаваться в кадре.
const FRAMES = SKY.keyframes.map((frame) => ({
    t: frame.t,
    zenith: new THREE.Color(frame.zenith),
    horizon: new THREE.Color(frame.horizon),
    key: new THREE.Color(frame.key),
    keyI: frame.keyI,
    ambI: frame.ambI,
    rimI: frame.rimI,
    stars: frame.stars,
    stormTint: frame.stormTint
}));

const STORM_FOG = new THREE.Color(PALETTE.stormFog).convertLinearToSRGB();
const STORM_AMBIENT = new THREE.Color(PALETTE.stormAmbient);
const STORM_SUN = new THREE.Color(PALETTE.stormSun);

// Свет живет в линейном пространстве, а небо и туман — в экранном: конвейер
// PS1 выводит кадр без sRGB-кодирования, поэтому цвета неба задаются так,
// как их должен увидеть игрок.
const linZenith = new THREE.Color();
const linHorizon = new THREE.Color();

function phaseAt(timeOfDay: number): string {
    if (timeOfDay < 0.22 || timeOfDay >= 0.82) return 'night';
    if (timeOfDay < 0.30) return 'dawn';
    if (timeOfDay < 0.70) return 'day';
    return 'dusk';
}

export function createDayCycle({
    startTime = SKY.startTime,
    cycleSeconds = SKY.cycleSeconds,
    autoAdvance = SKY.autoAdvance
}: DayCycleOptions = {}): DayCycle {
    // Снимок суток: переиспользуется каждый кадр, потребители не создают мусор.
    const state: DayState = {
        timeOfDay: 0.0,
        hours: 0,
        minutes: 0,
        phase: 'day',

        sunDir: new THREE.Vector3(),
        moonDir: new THREE.Vector3(),
        keyDir: new THREE.Vector3(),
        sunElevation: 0.0,     // sin высоты солнца, -1..1
        moonElevation: 0.0,
        keyElevation: 0.0,

        keyColor: new THREE.Color(),
        sunColor: new THREE.Color(),
        keyIntensity: 0.0,
        ambientColor: new THREE.Color(),
        ambientIntensity: 0.0,
        rimColor: new THREE.Color(),
        rimIntensity: 0.0,

        zenith: new THREE.Color(),
        horizon: new THREE.Color(),
        fogColor: new THREE.Color(),
        stormFog: new THREE.Color(),
        stormAmbient: new THREE.Color(),
        stormSun: new THREE.Color(),
        cloudLit: new THREE.Color(),
        cloudShade: new THREE.Color(),

        stars: 0.0,
        stormTint: 1.0,
        dayFactor: 1.0
    };

    let timeScale = SKY.timeScales[0];
    let scaleIndex = 0;

    // Кадры берутся из таблицы, доля сегмента сглаживается кубически.
    function evaluate(timeOfDay: number): void {
        let i = 0;
        while (i < FRAMES.length - 2 && timeOfDay >= FRAMES[i + 1].t) i++;

        const a = FRAMES[i];
        const b = FRAMES[i + 1];
        const span = Math.max(1e-6, b.t - a.t);
        const f = THREE.MathUtils.smoothstep((timeOfDay - a.t) / span, 0.0, 1.0);

        linZenith.lerpColors(a.zenith, b.zenith, f);
        linHorizon.lerpColors(a.horizon, b.horizon, f);
        state.keyColor.lerpColors(a.key, b.key, f);

        // Небо, солнце и облака — в экранном пространстве, свет — в линейном
        state.zenith.copy(linZenith).convertLinearToSRGB();
        state.horizon.copy(linHorizon).convertLinearToSRGB();
        state.sunColor.copy(state.keyColor).convertLinearToSRGB();

        state.keyIntensity = THREE.MathUtils.lerp(a.keyI, b.keyI, f);
        state.ambientIntensity = THREE.MathUtils.lerp(a.ambI, b.ambI, f);
        state.rimIntensity = THREE.MathUtils.lerp(a.rimI, b.rimI, f);
        state.stars = THREE.MathUtils.lerp(a.stars, b.stars, f);
        state.stormTint = THREE.MathUtils.lerp(a.stormTint, b.stormTint, f);

        // Туман — это цвет горизонта: так кромка мира всегда растворяется
        // в небе без видимого шва.
        state.fogColor.copy(state.horizon);
        state.dayFactor = THREE.MathUtils.clamp(state.keyIntensity / 2.5, 0.0, 1.0);

        state.ambientColor.copy(linHorizon).lerp(linZenith, 0.30);
        state.rimColor.copy(linHorizon).lerp(state.keyColor, 0.50);
        state.cloudLit.copy(state.horizon).lerp(state.sunColor, 0.60)
            .multiplyScalar(0.4 + 0.6 * state.dayFactor);
        state.cloudShade.copy(state.zenith).lerp(state.horizon, 0.35).multiplyScalar(0.75);

        // Буря ночью не должна светиться дневной охрой
        state.stormFog.copy(STORM_FOG).multiplyScalar(state.stormTint);
        state.stormAmbient.copy(STORM_AMBIENT).multiplyScalar(state.stormTint);
        state.stormSun.copy(STORM_SUN).multiplyScalar(state.stormTint);

        // Солнце ходит по наклонной орбите: восход в 0.25, закат в 0.75.
        const angle = (timeOfDay - 0.25) * TAU;
        const cosA = Math.cos(angle);
        state.sunDir.set(
            cosA * Math.cos(SKY.sunTilt),
            Math.sin(angle),
            cosA * Math.sin(SKY.sunTilt)
        );
        state.moonDir.copy(state.sunDir).negate();
        state.sunElevation = state.sunDir.y;
        state.moonElevation = state.moonDir.y;

        // Ключевой свет: днем солнце, ночью луна. Интенсивность у горизонта
        // почти нулевая, поэтому переключение направления незаметно.
        state.keyDir.copy(state.sunElevation > 0.02 ? state.sunDir : state.moonDir);
        state.keyElevation = state.keyDir.y;

        const totalHours = timeOfDay * 24.0;
        state.hours = Math.floor(totalHours);
        state.minutes = Math.floor((totalHours - state.hours) * 60.0);
        state.phase = phaseAt(timeOfDay);
    }

    function setTime(value: number): DayState {
        const wrapped = value - Math.floor(value);
        state.timeOfDay = wrapped < 0.0 ? wrapped + 1.0 : wrapped;
        evaluate(state.timeOfDay);
        return state;
    }

    function addTime(delta: number): void {
        setTime(state.timeOfDay + delta);
    }

    function update(dt: number): DayState {
        if (autoAdvance && timeScale !== 0.0 && dt > 0.0) {
            const next = state.timeOfDay + (dt * timeScale) / cycleSeconds;
            state.timeOfDay = next - Math.floor(next);
        }
        evaluate(state.timeOfDay);
        return state;
    }

    function setTimeScale(value: number): void {
        timeScale = value;
        const index = SKY.timeScales.indexOf(value);
        if (index !== -1) scaleIndex = index;
    }

    function cycleTimeScale(): number {
        scaleIndex = (scaleIndex + 1) % SKY.timeScales.length;
        timeScale = SKY.timeScales[scaleIndex];
        return timeScale;
    }

    state.timeOfDay = startTime - Math.floor(startTime);
    evaluate(state.timeOfDay);

    return {
        update,
        setTime,
        addTime,
        setTimeScale,
        cycleTimeScale,
        getTimeScale: () => timeScale,
        state
    };
}

