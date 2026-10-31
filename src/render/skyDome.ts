// Небесный купол: градиент сферы, диски солнца и луны, звезды и облачный слой.
// Купол висит на камере и не участвует в тумане: у горизонта его цвет в точности
// совпадает с цветом тумана, поэтому кромка загруженного мира не видна.
import * as THREE from 'three';
import { PALETTE, RENDER, SKY, WEATHER } from '../config.ts';

const SKY_VERTEX_SHADER = `
    varying vec3 vDir;
    void main() {
        // Купол не вращается: локальное направление вершины равно направлению взгляда
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const SKY_FRAGMENT_SHADER = `
    uniform vec3 uZenith;
    uniform vec3 uHorizon;
    uniform vec3 uFog;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform vec3 uMoonDir;
    uniform vec3 uMoonColor;
    uniform vec3 uCloudLit;
    uniform vec3 uCloudShade;
    uniform float uSunRadius;
    uniform float uSunGlow;
    uniform float uSunVis;
    uniform float uMoonRadius;
    uniform float uMoonVis;
    uniform float uStars;
    uniform float uStarDensity;
    uniform float uStarThreshold;
    uniform float uCloudCover;
    uniform float uCloudScale;
    uniform float uCloudSoftness;
    uniform float uCloudAlpha;
    uniform float uGradientPower;
    uniform vec2 uCloudOffset;
    varying vec3 vDir;

    float hash12(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float hash31(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash12(i);
        float b = hash12(i + vec2(1.0, 0.0));
        float c = hash12(i + vec2(0.0, 1.0));
        float d = hash12(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm4(vec2 p) {
        float sum = 0.0;
        float amp = 0.5;
        for (int i = 0; i < 4; i++) {
            sum += amp * vnoise(p);
            p = p * 2.03 + vec2(17.7, 9.2);
            amp *= 0.5;
        }
        return sum;
    }

    float fbm3(vec2 p) {
        float sum = 0.0;
        float amp = 0.5;
        for (int i = 0; i < 3; i++) {
            sum += amp * vnoise(p);
            p = p * 2.11 + vec2(7.3, 13.1);
            amp *= 0.5;
        }
        return sum;
    }

    void main() {
        vec3 dir = normalize(vDir);

        // У горизонта цвет неба ровно равен туману, выше — градиент к зениту
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 grad = mix(uHorizon, uZenith, pow(h, uGradientPower));
        vec3 col = mix(uFog, grad, smoothstep(0.0, 0.15, dir.y));

        // Солнце: резкий диск PS1 и мягкий ореол вокруг
        float sd = dot(dir, uSunDir);
        float sunAngle = acos(clamp(sd, -1.0, 1.0));
        float sunDisc = 1.0 - smoothstep(uSunRadius * 0.7, uSunRadius, sunAngle);
        float sunHalo = pow(max(sd, 0.0), 90.0) * 0.35 + pow(max(sd, 0.0), 8.0) * 0.12;
        col += uSunColor * (sunDisc * 1.4 + sunHalo * uSunGlow) * uSunVis;

        // Луна: маленький холодный диск с едва заметным ореолом
        float md = dot(dir, uMoonDir);
        float moonAngle = acos(clamp(md, -1.0, 1.0));
        float moonDisc = 1.0 - smoothstep(uMoonRadius * 0.7, uMoonRadius, moonAngle);
        float moonHalo = pow(max(md, 0.0), 160.0) * 0.20;
        col += uMoonColor * (moonDisc + moonHalo) * uMoonVis;

        // Звезды: редкие ячейки хеша над горизонтом, яркость гуляет по хешу
        vec3 cell = floor(dir * uStarDensity);
        float hsh = hash31(cell);
        float star = step(uStarThreshold, hsh) * smoothstep(0.04, 0.28, dir.y) * uStars;
        col += vec3(0.85, 0.88, 1.0) * star * (0.6 + 0.4 * fract(hsh * 97.0));

        // Облака: плоский слой, спроецированный на купол, гаснет у горизонта
        if (dir.y > 0.02) {
            vec2 p = dir.xz / max(dir.y, 0.04) * uCloudScale + uCloudOffset;
            float n1 = fbm4(p);
            float n2 = fbm3(p * 2.3 + vec2(11.0, 5.0));
            float density = n1 * 0.65 + n2 * 0.35;
            float edge = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + uCloudSoftness, density);
            float fade = smoothstep(0.01, 0.09, dir.y);
            float alpha = clamp(edge * fade * uCloudAlpha, 0.0, 1.0);
            vec3 cloud = mix(uCloudShade, uCloudLit, smoothstep(0.3, 0.8, n1));
            cloud += uSunColor * pow(max(sd, 0.0), 6.0) * 0.25 * uSunVis;
            col = mix(col, cloud, alpha);
        }

        gl_FragColor = vec4(col, 1.0);
    }
`;

// Небо рисуется в экранном пространстве: конвейер PS1 не кодирует кадр в sRGB,
// поэтому цвета палитры должны попадать на экран как есть.
const STORM_SKY = new THREE.Color(PALETTE.stormSky).convertLinearToSRGB();
const MOON_COLOR = new THREE.Color(SKY.moonColor).convertLinearToSRGB();

export interface SkyDomeOptions {
    scene: THREE.Scene;
}

export interface DaySkySnapshot {
    fogColor: THREE.Color;
    zenith: THREE.Color;
    horizon: THREE.Color;
    sunDir: THREE.Vector3;
    moonDir: THREE.Vector3;
    sunColor: THREE.Color;
    sunElevation: number;
    moonElevation: number;
    stars: number;
    cloudLit: THREE.Color;
    cloudShade: THREE.Color;
}

export interface WeatherSkySnapshot {
    intensity: number;
    cloud: number;
    fogColor: THREE.Color;
    windX: number;
    windZ: number;
}

export interface SkyDome {
    update(dt: number, camera: THREE.Camera, day: DaySkySnapshot, weather?: WeatherSkySnapshot | null): void;
    mesh: THREE.Mesh;
    uniforms: Record<string, { value: any }>;
    dispose(): void;
}

export function createSkyDome({ scene }: SkyDomeOptions): SkyDome {
    const uniforms = {
        uZenith: { value: new THREE.Color(PALETTE.background) },
        uHorizon: { value: new THREE.Color(PALETTE.background) },
        uFog: { value: new THREE.Color(PALETTE.fog) },
        uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.4) },
        uSunColor: { value: new THREE.Color(PALETTE.sun) },
        uMoonDir: { value: new THREE.Vector3(-0.5, -0.8, -0.4) },
        uMoonColor: { value: MOON_COLOR.clone() },
        uCloudLit: { value: new THREE.Color(PALETTE.background) },
        uCloudShade: { value: new THREE.Color(PALETTE.background) },
        uSunRadius: { value: SKY.sunRadius },
        uSunGlow: { value: SKY.sunGlow },
        uSunVis: { value: 1.0 },
        uMoonRadius: { value: SKY.moonRadius },
        uMoonVis: { value: 0.0 },
        uStars: { value: 0.0 },
        uStarDensity: { value: SKY.starDensity },
        uStarThreshold: { value: SKY.starThreshold },
        uCloudCover: { value: 0.0 },
        uCloudScale: { value: SKY.cloud.height * SKY.cloud.scale },
        uCloudSoftness: { value: SKY.cloud.softness },
        uCloudAlpha: { value: SKY.cloud.alpha },
        uGradientPower: { value: SKY.gradientPower },
        uCloudOffset: { value: new THREE.Vector2() }
    };

    const geometry = new THREE.SphereGeometry(RENDER.far * SKY.domeRadiusFactor, 32, 16);
    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -1000;   // Купол рисуется первым, мир ложится поверх него
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    scene.add(mesh);

    // Снос и эволюция облаков живут в этом векторе и не пересоздаются
    const cloudOffset = uniforms.uCloudOffset.value;

    function update(dt: number, camera: THREE.Camera, day: DaySkySnapshot, weather?: WeatherSkySnapshot | null): void {
        const storm = weather ? THREE.MathUtils.clamp(weather.intensity, 0.0, 1.0) : 0.0;
        const stormMix = Math.pow(storm, WEATHER.fogExponent);
        const fogColor = weather ? weather.fogColor : day.fogColor;

        // Буря подмешивает охру в небо, туман остается главным цветом горизонта
        uniforms.uZenith.value.copy(day.zenith).lerp(STORM_SKY, stormMix * 0.55);
        uniforms.uHorizon.value.copy(day.horizon).lerp(STORM_SKY, stormMix * 0.55);
        uniforms.uFog.value.copy(fogColor);

        uniforms.uSunDir.value.copy(day.sunDir);
        uniforms.uMoonDir.value.copy(day.moonDir);
        uniforms.uSunColor.value.copy(day.sunColor);
        uniforms.uSunVis.value = THREE.MathUtils.smoothstep(day.sunElevation, -0.03, 0.04);
        uniforms.uMoonVis.value = THREE.MathUtils.smoothstep(day.moonElevation, -0.02, 0.06);
        uniforms.uStars.value = day.stars;

        // Облачность приходит из погоды; в бурю она растворяется в песчаной мгле
        uniforms.uCloudCover.value = THREE.MathUtils.clamp(weather ? weather.cloud : 0.2, 0.0, 0.95);
        uniforms.uCloudAlpha.value = SKY.cloud.alpha * (1.0 - 0.85 * storm);
        uniforms.uCloudLit.value.copy(day.cloudLit).lerp(fogColor, stormMix * 0.7);
        uniforms.uCloudShade.value.copy(day.cloudShade).lerp(fogColor, stormMix * 0.7);

        const windX = weather ? weather.windX : 0.0;
        const windZ = weather ? weather.windZ : 0.0;
        cloudOffset.x += (windX * SKY.cloud.drift + SKY.cloud.evolve * 0.6) * dt;
        cloudOffset.y += (windZ * SKY.cloud.drift + SKY.cloud.evolve * 0.35) * dt;

        // Купол всегда центрирован на камере: горизонт висит на уровне глаз
        mesh.position.copy(camera.position);

        // Запасной фон, если купол когда-нибудь окажется за дальней плоскостью
        if (scene.background && (scene.background as THREE.Color).isColor) {
            (scene.background as THREE.Color).copy(fogColor);
        }
    }

    function dispose(): void {
        if (mesh.parent) mesh.parent.remove(mesh);
        geometry.dispose();
        material.dispose();
    }

    return { update, mesh, uniforms, dispose };
}

