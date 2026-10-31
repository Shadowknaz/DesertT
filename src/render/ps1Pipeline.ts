// Конвейер рендера в стиле PS1: сцена рисуется в буфер низкого разрешения,
// затем полноэкранный проход квантует цвет и накладывает дизеринг Байера 4x4.
import * as THREE from 'three';
import { PALETTE, RENDER } from '../config.ts';

const POST_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
    }
`;

const POST_FRAGMENT_SHADER = `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uStorm;
    uniform vec3 uStormColor;
    varying vec2 vUv;

    float bayer4x4(vec2 pos) {
        int x = int(mod(pos.x, 4.0));
        int y = int(mod(pos.y, 4.0));
        int index = x + y * 4;
        if (index == 0) return 0.0 / 16.0;
        if (index == 1) return 8.0 / 16.0;
        if (index == 2) return 2.0 / 16.0;
        if (index == 3) return 10.0 / 16.0;
        if (index == 4) return 12.0 / 16.0;
        if (index == 5) return 4.0 / 16.0;
        if (index == 6) return 14.0 / 16.0;
        if (index == 7) return 6.0 / 16.0;
        if (index == 8) return 3.0 / 16.0;
        if (index == 9) return 11.0 / 16.0;
        if (index == 10) return 1.0 / 16.0;
        if (index == 11) return 9.0 / 16.0;
        if (index == 12) return 15.0 / 16.0;
        if (index == 13) return 7.0 / 16.0;
        if (index == 14) return 13.0 / 16.0;
        return 5.0 / 16.0;
    }

    void main() {
        vec4 texel = texture2D(tDiffuse, vUv);
        vec2 pixelCoord = floor(vUv * uResolution);
        float dither = (bayer4x4(pixelCoord) - 0.5) / 28.0;

        vec3 col = texel.rgb + vec3(dither);
        // Песчаная взвесь в бурю подмешивает охру во весь кадр
        col = mix(col, uStormColor, uStorm);
        // 5 бит на канал (32 градации яркости на канал как на PS1)
        col = floor(col * 31.0 + 0.5) / 31.0;

        // Мягкая виньетка вокруг диорамы
        vec2 centered = vUv - 0.5;
        float vig = 1.0 - dot(centered, centered) * 0.45;
        gl_FragColor = vec4(col * vig, 1.0);
    }
`;

export interface PS1PipelineOptions {
    renderer: THREE.WebGLRenderer;
}

export interface PS1Pipeline {
    renderTarget: THREE.WebGLRenderTarget;
    resize(aspect: number): void;
    render(scene: THREE.Scene, camera: THREE.Camera): void;
    setStorm(amount: number): void;
    dispose(): void;
}

export function createPS1Pipeline({ renderer }: PS1PipelineOptions): PS1Pipeline {
    const internalHeight = RENDER.internalHeight;

    // Буфер низкого разрешения (320x240 стиль), ширина подстраивается под aspect
    const computeWidth = (aspect: number): number => Math.max(RENDER.minInternalWidth, Math.floor(internalHeight * aspect));
    let internalWidth = computeWidth(typeof window !== 'undefined' ? window.innerWidth / window.innerHeight : 4 / 3);

    const renderTarget = new THREE.WebGLRenderTarget(internalWidth, internalHeight, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat
    });

    const postScene = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postMaterial = new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse: { value: renderTarget.texture },
            uResolution: { value: new THREE.Vector2(internalWidth, internalHeight) },
            uStorm: { value: 0.0 },
            uStormColor: { value: new THREE.Color(PALETTE.stormFog) }
        },
        vertexShader: POST_VERTEX_SHADER,
        fragmentShader: POST_FRAGMENT_SHADER
    });
    const quadGeometry = new THREE.PlaneGeometry(2, 2);
    postScene.add(new THREE.Mesh(quadGeometry, postMaterial));

    // Пересчет внутреннего буфера при изменении пропорций окна.
    function resize(aspect: number): void {
        internalWidth = computeWidth(aspect);
        renderTarget.setSize(internalWidth, internalHeight);
        postMaterial.uniforms.uResolution.value.set(internalWidth, internalHeight);
    }

    // Сила песчаной бури подмешивает в кадр охру поверх дизеринга.
    function setStorm(amount: number): void {
        postMaterial.uniforms.uStorm.value = THREE.MathUtils.clamp(amount, 0.0, 0.6);
    }

    // Двухпроходный рендер: сцена -> низкое разрешение -> дизеринг на экран.
    function render(scene: THREE.Scene, camera: THREE.Camera): void {
        renderer.setRenderTarget(renderTarget);
        renderer.render(scene, camera);

        renderer.setRenderTarget(null);
        renderer.render(postScene, postCamera);
    }

    function dispose(): void {
        renderTarget.dispose();
        quadGeometry.dispose();
        postMaterial.dispose();
    }

    return { renderTarget, resize, render, setStorm, dispose };
}

