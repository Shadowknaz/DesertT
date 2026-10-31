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

// Hermite-интерполяция между порогами: 0 до edge0, 1 после edge1.
export function smoothstep(edge0: number, edge1: number, x: number): number {
    let t = Math.min(1.0, Math.max(0.0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3.0 - 2.0 * t);
}

