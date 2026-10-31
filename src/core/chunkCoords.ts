// Чистая математика сетки чанков: мировые координаты <-> индексы чанков.
// Модуль не знает ни о three, ни о физике, ни о сцене.
import { CHUNK } from '../config.ts';

// Индекс чанка, в который попадает мировая координата.
// Чанк 0 центрирован в нуле, поэтому граница проходит через ±size / 2.
export function chunkCoordAt(worldValue: number): number {
    return Math.floor((worldValue + CHUNK.size * 0.5) / CHUNK.size);
}

// Мировая координата центра чанка с данным индексом.
export function chunkOriginAt(coord: number): number {
    return coord * CHUNK.size;
}

// Ключ чанка для Map и Set.
export function chunkKeyOf(cx: number, cz: number): string {
    return cx + ',' + cz;
}
