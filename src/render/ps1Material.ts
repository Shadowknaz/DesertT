// PS1-эмуляция вершин и процедурный шейдер поверхности пустыни:
// 1. applyPS1VertexSnap — снэппинг позиции в clip-space имитирует целочисленную математику GTE.
// 2. applyDesertSurfaceShader — мировое трипланарное и ветроориентированное текстурирование
//    песка, эоловой ряби, микрозернистости, кварцевых бликов, каменистых почв (рег/галька),
//    растрескавшихся такыров и осадочных слоёв скальной породы.
import * as THREE from 'three';

export function applyPS1VertexSnap<T extends THREE.Material>(material: T, snapResolution: number = 135.0): T {
    material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
        shader.uniforms.uSnapRes = { value: snapResolution };
        shader.vertexShader = `uniform float uSnapRes;\n` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
            '#include <project_vertex>',
            `
            vec4 mvPosition = vec4( transformed, 1.0 );
            #ifdef USE_INSTANCING
                mvPosition = instanceMatrix * mvPosition;
            #endif
            mvPosition = modelViewMatrix * mvPosition;
            gl_Position = projectionMatrix * mvPosition;
            // Эмуляция целочисленной математики GTE чипа PlayStation 1
            if (gl_Position.w > 0.05) {
                float invW = 1.0 / gl_Position.w;
                gl_Position.x = (floor(uSnapRes * gl_Position.x * invW) / uSnapRes) * gl_Position.w;
                gl_Position.y = (floor(uSnapRes * gl_Position.y * invW) / uSnapRes) * gl_Position.w;
            }
            `
        );
    };
    return material;
}

export interface DesertSurfaceUniforms {
    uSnapRes: { value: number };
    uSandMap: { value: THREE.Texture };
    uDetailMap: { value: THREE.Texture };
    uSunDir: { value: THREE.Vector3 };
    uWindDir: { value: THREE.Vector2 };
}

export interface DesertSurfaceOptions {
    snapResolution?: number;
    sandMap: THREE.Texture;
    detailMap: THREE.Texture;
}

export function applyDesertSurfaceShader<T extends THREE.Material>(
    material: T,
    options: DesertSurfaceOptions
): { material: T; uniforms: DesertSurfaceUniforms } {
    const uniforms: DesertSurfaceUniforms = {
        uSnapRes: { value: options.snapResolution ?? 320.0 },
        uSandMap: { value: options.sandMap },
        uDetailMap: { value: options.detailMap },
        uSunDir: { value: new THREE.Vector3(0.52, 0.76, 0.38).normalize() },
        uWindDir: { value: new THREE.Vector2(0.84, 0.54).normalize() }
    };

    material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
        shader.uniforms.uSnapRes = uniforms.uSnapRes;
        shader.uniforms.uSandMap = uniforms.uSandMap;
        shader.uniforms.uDetailMap = uniforms.uDetailMap;
        shader.uniforms.uSunDir = uniforms.uSunDir;
        shader.uniforms.uWindDir = uniforms.uWindDir;

        shader.vertexShader = `
            uniform float uSnapRes;
            attribute vec4 aSoilMask;
            varying vec3 vWorldPos;
            varying vec3 vWorldNormal;
            varying vec4 vSoilMask;
        \n` + shader.vertexShader;

        shader.vertexShader = shader.vertexShader.replace(
            '#include <project_vertex>',
            `
            vec4 worldPosition4 = modelMatrix * vec4( transformed, 1.0 );
            vWorldPos = worldPosition4.xyz;
            vWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
            vSoilMask = aSoilMask;

            vec4 mvPosition = vec4( transformed, 1.0 );
            #ifdef USE_INSTANCING
                mvPosition = instanceMatrix * mvPosition;
            #endif
            mvPosition = modelViewMatrix * mvPosition;
            gl_Position = projectionMatrix * mvPosition;
            // Эмуляция целочисленной математики GTE чипа PlayStation 1
            if (gl_Position.w > 0.05) {
                float invW = 1.0 / gl_Position.w;
                gl_Position.x = (floor(uSnapRes * gl_Position.x * invW) / uSnapRes) * gl_Position.w;
                gl_Position.y = (floor(uSnapRes * gl_Position.y * invW) / uSnapRes) * gl_Position.w;
            }
            `
        );

        shader.fragmentShader = `
            uniform sampler2D uSandMap;
            uniform sampler2D uDetailMap;
            uniform vec3 uSunDir;
            uniform vec2 uWindDir;
            varying vec3 vWorldPos;
            varying vec3 vWorldNormal;
            varying vec4 vSoilMask;

            float desertHash21(vec2 p) {
                p = fract(p * vec2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return fract(p.x * p.y);
            }

            float desertNoise2(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                float a = desertHash21(i);
                float b = desertHash21(i + vec2(1.0, 0.0));
                float c = desertHash21(i + vec2(0.0, 1.0));
                float d = desertHash21(i + vec2(1.0, 1.0));
                vec2 u = f * f * (3.0 - 2.0 * f);
                return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
            }
        \n` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            `
            #include <color_fragment>
            {
                vec3 wNorm = normalize(vWorldNormal);
                float camDist = distance(cameraPosition, vWorldPos);
                // На дальних дистанциях высокочастотный шум плавно затухает, чтобы не искрить
                float nearFade = 1.0 - smoothstep(16.0, 68.0, camDist);
                float midFade  = 1.0 - smoothstep(45.0, 135.0, camDist);

                // Маски типов поверхности из вершинного атрибута aSoilMask:
                // x = bareRock (обнаженная порода/уступы), y = gravelReg (каменистая почва/щебень),
                // z = hardpanPlain (такырная корка с трещинами), w = footprintDisturb (следы/воронки)
                float bareRock = clamp(vSoilMask.x, 0.0, 1.0);
                float gravelReg = clamp(vSoilMask.y, 0.0, 1.0);
                float hardpan = clamp(vSoilMask.z, 0.0, 1.0);
                float disturb = clamp(vSoilMask.w, 0.0, 1.0);

                // Координаты вдоль и поперёк господствующего ветра для эоловой ряби
                vec2 windU = normalize(uWindDir);
                vec2 windV = vec2(-windU.y, windU.x);
                vec2 windXZ = vec2(dot(vWorldPos.xz, windU), dot(vWorldPos.xz, windV));

                // 1. ЭОЛОВАЯ РЯБЬ И ЗЕРНИСТЫЙ ПЕСОК (Near + Mid масштабы)
                vec3 sandNear = texture2D(uSandMap, windXZ * 0.28).rgb;
                vec3 sandMid  = texture2D(uSandMap, windXZ * 0.075 + vec2(0.37, 0.61)).rgb;
                vec3 detailNear = texture2D(uDetailMap, windXZ * 0.34).rgb;
                vec3 detailMid  = texture2D(uDetailMap, vWorldPos.xz * 0.14 + vec2(0.19, 0.73)).rgb;

                // Аналитическая + текстурная ветровая рябь с Y-образными слияниями гребней
                float rippleWarp = (detailMid.r - 0.5) * 2.6;
                float ripplePhase = windXZ.x * 13.5 + sin(windXZ.y * 2.2) * 1.4 + rippleWarp;
                float asymRipple = sin(ripplePhase + 0.45 * cos(ripplePhase));
                // Внутри следов (disturb) ветровая рябь примята подошвой
                float rippleAmp = (1.0 - disturb * 0.85) * (1.0 - bareRock * 0.90) * (1.0 - hardpan * 0.65);

                // Градиент ряби для направленного солнечного микрорельефа (гребень на солнце / склон в тени)
                float rippleGrad = cos(ripplePhase) * rippleAmp;
                vec3 rippleHorizNormal = normalize(vec3(
                    wNorm.x - windU.x * rippleGrad * 0.36,
                    wNorm.y,
                    wNorm.z - windU.y * rippleGrad * 0.36
                ));
                float baseSun = max(0.0, dot(wNorm, uSunDir));
                float microSun = max(0.0, dot(rippleHorizNormal, uSunDir));
                float rippleLightDelta = (microSun - baseSun) * 1.45 * midFade;

                // Высокочастотная пиксельная зернистость отдельных песчинок (кварц, охра, базальт)
                vec2 grainCell = floor(vWorldPos.xz * 26.0);
                float grainHash = desertHash21(grainCell);
                float grainCoarse = desertHash21(floor(vWorldPos.xz * 9.5));
                float sandGrain = ((grainHash - 0.5) * 0.18 + (grainCoarse - 0.5) * 0.11 + (detailNear.r - 0.5) * 0.16) * nearFade;

                // Искрящиеся кристаллики кварца на солнце (silica micro-glints)
                vec3 viewDir = normalize(cameraPosition - vWorldPos);
                vec3 halfVec = normalize(uSunDir + viewDir);
                float specAlign = max(0.0, dot(wNorm, halfVec));
                float sparkleMask = step(0.955, desertHash21(grainCell + floor(viewDir.xz * 6.0)));
                float silicaGlint = sparkleMask * pow(specAlign, 4.0) * 0.26 * nearFade * (1.0 - bareRock);

                // Текстурная модуляция песка (сохраняет базовый цвет биома, но дает насыщенную фактуру)
                vec3 sandTexMod = mix(vec3(1.0), (sandNear / vec3(0.84, 0.66, 0.43)), 0.42 * nearFade + 0.18 * midFade);
                vec3 macroTexMod = mix(vec3(1.0), (sandMid / vec3(0.84, 0.66, 0.43)), 0.32 * midFade);
                vec3 sandCol = diffuseColor.rgb * sandTexMod * macroTexMod;

                // Гребни ряби золотисто-светлые, ложбины — глубже и теплее (охра/умбра)
                float crestHighlight = max(0.0, asymRipple) * 0.11 * rippleAmp * midFade;
                float troughShadow = max(0.0, -asymRipple) * 0.13 * rippleAmp * midFade;
                sandCol += vec3(crestHighlight * 1.15, crestHighlight * 0.92, crestHighlight * 0.55);
                sandCol -= vec3(troughShadow * 0.85, troughShadow * 1.05, troughShadow * 1.25);
                sandCol += vec3(rippleLightDelta * 0.24, rippleLightDelta * 0.18, rippleLightDelta * 0.10);
                sandCol += vec3(sandGrain * 1.05, sandGrain * 0.88, sandGrain * 0.62);
                sandCol += vec3(silicaGlint * 1.2, silicaGlint * 1.05, silicaGlint * 0.75);

                // 2. КАМЕНИСТАЯ ПОЧВА РЕГ / ЩЕБЕНЬ И ГАЛЬКА (gravelReg)
                if (gravelReg > 0.01) {
                    float regNear = detailNear.g;
                    float regMid  = detailMid.g;
                    float pebbleMask = smoothstep(0.56, 0.76, regNear * 0.65 + regMid * 0.35);
                    float darkStone = step(0.62, desertHash21(floor(vWorldPos.xz * 7.5)));
                    // Тёмные базальтовые и ржаво-охристые камушки с четкой теневой каймой
                    vec3 stoneTone = mix(
                        vec3(0.46, 0.33, 0.22),
                        vec3(0.27, 0.21, 0.17),
                        darkStone
                    );
                    float stoneRimShadow = smoothstep(0.46, 0.56, regNear) * (1.0 - pebbleMask);
                    vec3 regCol = sandCol * (0.86 + (regMid - 0.5) * 0.28);
                    regCol -= vec3(stoneRimShadow * 0.18);
                    regCol = mix(regCol, stoneTone, pebbleMask * (0.72 * nearFade + 0.35 * midFade));
                    sandCol = mix(sandCol, regCol, gravelReg);
                }

                // 3. РАСТРЕСКАВШАЯСЯ ТАКЫРНАЯ КОРКА (hardpan)
                if (hardpan > 0.01) {
                    float crackTex = mix(detailMid.b, detailNear.b, 0.55 * nearFade);
                    // Темные трещины усыхания и светлые выбеленные солнцем глинистые плитки
                    float fissure = 1.0 - smoothstep(0.18, 0.42, crackTex);
                    vec3 crustCol = sandCol * vec3(1.07, 1.04, 0.98) + vec3(0.04, 0.03, 0.02) * midFade;
                    crustCol = mix(crustCol, crustCol * vec3(0.48, 0.38, 0.30), fissure * (0.78 * midFade));
                    sandCol = mix(sandCol, crustCol, hardpan);
                }

                // 4. СЛОИСТАЯ СКАЛЬНАЯ ПОРОДА И КАМЕННЫЕ УСТУПЫ (Трипланарная проекция — bareRock)
                if (bareRock > 0.01) {
                    vec3 blend = pow(abs(wNorm), vec3(4.0));
                    blend /= max(dot(blend, vec3(1.0)), 1e-4);

                    vec3 rockXZ = texture2D(uDetailMap, vWorldPos.xz * 0.16).rgb;
                    vec3 rockXY = texture2D(uDetailMap, vWorldPos.xy * 0.18).rgb;
                    vec3 rockZY = texture2D(uDetailMap, vWorldPos.zy * 0.18).rgb;
                    vec3 triRock = rockXZ * blend.y + rockXY * blend.z + rockZY * blend.x;

                    // Геологическая стратификация по высоте Y + вертикальные трещины породы
                    float strataWave = sin(vWorldPos.y * 3.8 + triRock.r * 2.5);
                    float fineStrata = sin(vWorldPos.y * 11.5 + triRock.g * 3.2) * 0.5;
                    float rockCrack  = 1.0 - smoothstep(0.16, 0.36, triRock.b);

                    vec3 bedrockCol = diffuseColor.rgb * (0.88 + strataWave * 0.14 + fineStrata * 0.08 * midFade);
                    // Темный пустынный загар (железо-марганцевая патина) и глубокие расщелины
                    bedrockCol *= mix(1.0, 0.52, rockCrack * midFade);
                    bedrockCol += (triRock.g - 0.5) * 0.18 * nearFade;

                    // На пологих уступах скалы скапливается золотистый нанесенный ветром песок
                    float ledgeSand = smoothstep(0.72, 0.93, wNorm.y) * (1.0 - rockCrack) * 0.55;
                    bedrockCol = mix(bedrockCol, sandCol * 1.06, ledgeSand);

                    sandCol = mix(sandCol, bedrockCol, bareRock);
                }

                // 5. ОТПЕЧАТКИ СТОП И РАЗРЫТЫЙ ПЕСОК (disturb)
                if (disturb > 0.01) {
                    // Вскопанный влажновато-плотный песок в воронке темнее и насыщеннее по охре,
                    // с выраженной крупной зернистостью комков
                    float clodNoise = (desertHash21(floor(vWorldPos.xz * 18.0)) - 0.5) * 0.22 * nearFade;
                    vec3 churnedCol = sandCol * vec3(0.82, 0.76, 0.68) + vec3(clodNoise);
                    sandCol = mix(sandCol, churnedCol, disturb * 0.75);
                }

                diffuseColor.rgb = max(vec3(0.02), sandCol);
            }
            `
        );
    };

    return { material, uniforms };
}
