// Детерминированный математический шум: основа рельефа и процедурных текстур.

// Псевдослучайное число в диапазоне [0, 1) по паре координат.
// Используется там, где координаты дробные: зерна чанков, зернистость текстур.
export function hash2(x: number, y: number): number {
    let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return n - Math.floor(n);
}

// Быстрый хеш целочисленного узла решетки. Рельеф опрашивается десятки тысяч
// раз за кадр, поэтому внутри шума синус заменен на целочисленные умножения.
function hashInt(ix: number, iy: number): number {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// Сглаженный value noise с билинейной интерполяцией (smoothstep).
export function valueNoise(x: number, y: number): number {
    let ix = Math.floor(x);
    let iy = Math.floor(y);
    let fx = x - ix;
    let fy = y - iy;
    let u = fx * fx * (3.0 - 2.0 * fx);
    let v = fy * fy * (3.0 - 2.0 * fy);
    let a = hashInt(ix, iy);
    let b = hashInt(ix + 1, iy);
    let c = hashInt(ix, iy + 1);
    let d = hashInt(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Знаковый value noise в диапазоне [-1, 1].
export function signedNoise(x: number, y: number): number {
    return valueNoise(x, y) * 2.0 - 1.0;
}

// Фрактальная сумма октав в диапазоне [-1, 1]: крупные пологие формы рельефа.
export function fbm(x: number, y: number, octaves: number = 3, lacunarity: number = 2.0, gain: number = 0.5): number {
    let sum = 0.0;
    let amp = 1.0;
    let norm = 0.0;
    for (let i = 0; i < octaves; i++) {
        sum += signedNoise(x, y) * amp;
        norm += amp;
        x *= lacunarity;
        y *= lacunarity;
        amp *= gain;
    }
    return sum / norm;
}

// Ridged-шум: value noise выворачивается в острые гребни, результат в [0, 1].
// Основа горных хребтов и скалистых складок на склонах.
export function ridgedNoise(x: number, y: number, octaves: number = 3, lacunarity: number = 2.0, gain: number = 0.5): number {
    let sum = 0.0;
    let amp = 1.0;
    let norm = 0.0;
    for (let i = 0; i < octaves; i++) {
        let ridge = 1.0 - Math.abs(valueNoise(x, y) * 2.0 - 1.0);
        sum += ridge * ridge * amp;
        norm += amp;
        x *= lacunarity;
        y *= lacunarity;
        amp *= gain;
    }
    return sum / norm;
}

// ---------------------------------------------------------------------------
// 2D Simplex Noise: непрерывный изотропный шум без осевых сеточных артефактов
// ---------------------------------------------------------------------------
const F2 = 0.5 * (Math.SQRT2 * 1.224744871391589 - 1.0); // 0.5 * (sqrt(3) - 1)
const G2 = (3.0 - Math.SQRT2 * 1.224744871391589) / 6.0; // (3 - sqrt(3)) / 6

const GRAD2_X = [1, -1, 1, -1, 1, -1, 0, 0];
const GRAD2_Y = [1, 1, -1, -1, 0, 0, 1, -1];

function hashGrad(ix: number, iy: number): number {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return (h ^ (h >>> 12)) & 7;
}

// Быстрый 2D Simplex Noise в диапазоне [-1, 1]
export function simplexNoise(x: number, y: number): number {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);

    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1.0 + 2.0 * G2;
    const y2 = y0 - 1.0 + 2.0 * G2;

    const gi0 = hashGrad(i, j);
    const gi1 = hashGrad(i + i1, j + j1);
    const gi2 = hashGrad(i + 1, j + 1);

    let n0 = 0.0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
        t0 *= t0;
        n0 = t0 * t0 * (GRAD2_X[gi0] * x0 + GRAD2_Y[gi0] * y0);
    }

    let n1 = 0.0;
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
        t1 *= t1;
        n1 = t1 * t1 * (GRAD2_X[gi1] * x1 + GRAD2_Y[gi1] * y1);
    }

    let n2 = 0.0;
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
        t2 *= t2;
        n2 = t2 * t2 * (GRAD2_X[gi2] * x2 + GRAD2_Y[gi2] * y2);
    }

    return 70.0 * (n0 + n1 + n2);
}

// Фрактальный шум на базе Simplex Noise [-1, 1]
export function fbmSimplex(x: number, y: number, octaves: number = 3, lacunarity: number = 2.0, gain: number = 0.5): number {
    let sum = 0.0;
    let amp = 1.0;
    let norm = 0.0;
    for (let i = 0; i < octaves; i++) {
        sum += simplexNoise(x, y) * amp;
        norm += amp;
        x *= lacunarity;
        y *= lacunarity;
        amp *= gain;
    }
    return sum / norm;
}

// Гребневой шум на базе Simplex Noise [0, 1]
export function ridgedSimplex(x: number, y: number, octaves: number = 3, lacunarity: number = 2.0, gain: number = 0.5): number {
    let sum = 0.0;
    let amp = 1.0;
    let norm = 0.0;
    for (let i = 0; i < octaves; i++) {
        let ridge = 1.0 - Math.abs(simplexNoise(x, y));
        sum += ridge * ridge * amp;
        norm += amp;
        x *= lacunarity;
        y *= lacunarity;
        amp *= gain;
    }
    return sum / norm;
}

// Гладкий вариант гребневого шума для макроформ рельефа. В отличие от
// 1 - abs(noise), cosine-профиль имеет нулевую производную на вершине:
// переход через noise = 0 не создает cusp и не собирает высоту в игольчатый пик.
// Результат остается в [0, 1], поэтому его можно использовать теми же масками.
export function smoothRidgedSimplex(
    x: number,
    y: number,
    octaves: number = 5,
    lacunarity: number = 2.0,
    gain: number = 0.48
): number {
    let sum = 0.0;
    let amp = 1.0;
    let norm = 0.0;
    for (let i = 0; i < octaves; i++) {
        const value = simplexNoise(x, y);
        const ridge = 0.5 + 0.5 * Math.cos(Math.PI * Math.max(-1.0, Math.min(1.0, value)));
        sum += ridge * amp;
        norm += amp;
        x *= lacunarity;
        y *= lacunarity;
        amp *= gain;
    }
    return norm > 0.0 ? sum / norm : 0.0;
}

// Hermite-интерполяция между порогами: 0 до edge0, 1 после edge1.
export function smoothstep(edge0: number, edge1: number, x: number): number {
    let t = Math.min(1.0, Math.max(0.0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3.0 - 2.0 * t);
}

