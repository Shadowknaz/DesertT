// Аналитическое поле высот пустыни: ветровые барханы поверх пологих холмов
// и равномерно разбросанных горных массивов. Одна и та же функция питает меш
// песка, физический heightfield, расстановку камней, частицы и резервный рельеф.
import * as THREE from 'three';
import { TERRAIN } from '../config.ts';
import { fbm, ridgedNoise, smoothstep, valueNoise } from './noise.ts';

// Маска горных массивов в точке (x, z): 0 — песчаная равнина, 1 — гребень.
// Крупный ridged-шум дает вытянутые хребты, равномерно разнесенные по миру,
// а пороговая функция формирует их пологие предгорья. Вокруг стартовой точки
// массивы прижаты к нулю, чтобы мех начинал путь в открытой низине.
export function getMountainMask(x: number, z: number): number {
    const ridge = ridgedNoise(x * TERRAIN.mountainScale, z * TERRAIN.mountainScale, 2);
    const mask = smoothstep(TERRAIN.mountainStart, TERRAIN.mountainFull, ridge);

    const inner = TERRAIN.spawnClearRadius;
    const outer = inner + TERRAIN.spawnClearFeather;
    const spawnClear = smoothstep(inner * inner, outer * outer, x * x + z * z);

    return mask * spawnClear;
}

// Высота рельефа в мировых координатах (x, z).
export function getDuneHeight(x: number, z: number): number {
    const mountains = getMountainMask(x, z);

    // Пологие холмы: два масштаба фрактального шума без резких перепадов.
    // Они заполняют мир целиком, поэтому между массивами нет плоских пустот.
    const hills = fbm(x * TERRAIN.hillScale, z * TERRAIN.hillScale, 2) * TERRAIN.hillAmplitude;

    // Горный массив: широкая база переменной высоты плюс скалистые складки,
    // которые проступают только ближе к гребню и не «сыпятся» на равнину.
    let mountain = 0.0;
    if (mountains > 0.001) {
        const massif = TERRAIN.mountainBase +
            fbm(x * TERRAIN.massifScale, z * TERRAIN.massifScale, 1) * TERRAIN.mountainVariation;
        const crags = ridgedNoise(x * TERRAIN.cragScale, z * TERRAIN.cragScale, 3);
        mountain = mountains * (massif + crags * TERRAIN.cragAmplitude * mountains);
    }

    // Барханы живут на равнинах и выполаживаются на горных склонах
    const duneFade = 1.0 - mountains * TERRAIN.duneFade;

    // Острые гребни барханов (Ridged Noise)
    let nx = x * 0.08;
    let nz = z * 0.08;
    let d1 = 1.0 - Math.abs(Math.sin(nx * 1.1 + Math.cos(nz * 0.85) * 1.6));
    d1 = Math.pow(d1, 1.75) * 3.1;

    // Вторичные волны
    let d2 = valueNoise(x * 0.22, z * 0.22) * 1.15;

    // Микрорельеф ветровой ряби на песке
    let ripple = Math.sin(x * 2.6 + z * 1.1 + Math.sin(z * 0.5) * 2.0) * 0.075;

    const relief = hills + mountain + (d1 + d2 + ripple - 2.1) * duneFade;

    // Стартовая площадка: ровный песчаный пятачок, плавно сливающийся с рельефом.
    // Без него мех мог бы начать путь в случайной воронке между холмами.
    const padInner = TERRAIN.spawnPadRadius;
    const padOuter = padInner + TERRAIN.spawnPadFeather;
    const padBlend = smoothstep(padInner * padInner, padOuter * padOuter, x * x + z * z);
    return TERRAIN.spawnLevel + (relief - TERRAIN.spawnLevel) * padBlend;
}

// Нормаль поверхности по конечным разностям — резервный путь, когда физический
// луч Rapier не нашел пересечения.
export function getDuneNormal(x: number, z: number, eps: number = 0.25): THREE.Vector3 {
    const hC = getDuneHeight(x, z);
    const hX = getDuneHeight(x + eps, z);
    const hZ = getDuneHeight(x, z + eps);
    return new THREE.Vector3(hC - hX, eps, hC - hZ).normalize();
}
