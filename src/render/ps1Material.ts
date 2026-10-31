// PS1-эмуляция вершин: снэппинг позиции в clip-space имитирует
// целочисленную математику GTE чипа PlayStation 1 (дрожание геометрии).
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
            gl_Position.xyz = gl_Position.xyz / gl_Position.w;
            gl_Position.x = floor(uSnapRes * gl_Position.x) / uSnapRes;
            gl_Position.y = floor(uSnapRes * gl_Position.y) / uSnapRes;
            gl_Position.xyz *= gl_Position.w;
            `
        );
    };
    return material;
}

