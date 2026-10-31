// Детерминированный генератор псевдослучайных чисел (Mulberry32).
// Обеспечивает воспроизводимость симуляции: ветер, погода, частицы и обломки
// при одном и том же seed ведут себя абсолютно одинаково.

export interface Rng {
    next(): number;
    between(min: number, max: number): number;
    intBetween(min: number, max: number): number;
    fork(salt?: number): Rng;
    getSeed(): number;
}

export function createRng(seed: number = 1337): Rng {
    let s = (Math.imul(seed ^ 0x6d2b79f5, 1) >>> 0) || 1;

    function next(): number {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    function between(min: number, max: number): number {
        return min + next() * (max - min);
    }

    function intBetween(min: number, max: number): number {
        return Math.floor(between(min, max + 1));
    }

    function fork(salt: number = 0): Rng {
        return createRng((Math.imul(s ^ (salt * 0x9e3779b9), 1) >>> 0) || 1);
    }

    function getSeed(): number {
        return seed;
    }

    return { next, between, intBetween, fork, getSeed };
}

