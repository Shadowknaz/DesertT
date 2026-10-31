// Аналитическое поле ветра: средний поток медленно дрейфует по направлению,
// а fbm во времени и пространстве добавляет порывы и завихрения.
// Функции чистые: ни сцены, ни DOM — только шум из core/noise.js.
import { fbm } from './noise.ts';

export interface Vector3Like {
    set(x: number, y: number, z: number): this;
}

// Ветер в точке (x, z) в момент t. out — любой объект с set(x, y, z),
// обычно THREE.Vector3: буфер переиспользуется, чтобы не аллоцировать в кадре.
// dirX / dirZ — единичное среднее направление потока, speed — его скорость,
// turbulence — насколько сильно местные завихрения отклоняют поток.
export function sampleWind<T extends Vector3Like>(
    out: T,
    x: number,
    z: number,
    t: number,
    dirX: number,
    dirZ: number,
    speed: number,
    turbulence: number = 1.0
): T {
    // Порывы: крупные медленные волны, бегущие вдоль ветра и поперек него.
    const gust = fbm(x * 0.025 + t * 0.16, z * 0.025 - t * 0.11, 3);

    // Завихрения поворачивают локальное направление потока.
    const swirl = fbm(x * 0.012 - t * 0.07, z * 0.012 + t * 0.05, 2);

    const angle = swirl * 0.5 * turbulence;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Порыв не может полностью погасить ветер.
    const gustFactor = Math.max(0.15, 1.0 + gust * 0.55 * turbulence);
    const magnitude = speed * gustFactor;

    out.set(
        (dirX * cos - dirZ * sin) * magnitude,
        0.0,
        (dirX * sin + dirZ * cos) * magnitude
    );
    return out;
}

