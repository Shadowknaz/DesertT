// Калиброванная террамеханическая модель грунта (Беккер, Яноси–Ханамото, Терцаги).
// Заменяет упрощенную линейную эвристику на физически обоснованные законы
// взаимодействия шагохода с сыпучим и скальным грунтом.

export interface SoilMaterial {
    id: string;
    name: string;
    frictionAngleDeg: number;
    cohesion: number;
    density: number;
    kc: number;
    kphi: number;
    n: number;
    shearModulusK: number;
    baseGrip: number;
    bearingCapacityBase: number;
    maxSinkRate: number;
    maxSinkDepth: number;
    compactionSensitivity?: number;
}

export const SOIL_MATERIALS: Record<string, SoilMaterial> = {
    loose_sand: {
        id: 'loose_sand',
        name: 'Рыхлый песок',
        frictionAngleDeg: 29.0, // Угол внутреннего трения phi, град
        cohesion: 120.0,         // Сцепление c, Па
        density: 1550.0,         // Плотность gamma, кг/м^3
        kc: 900.0,               // Модуль связности Беккера, Н/м^(n+1)
        kphi: 1520000.0,         // Модуль трения Беккера, Н/м^(n+2)
        n: 1.05,                 // Показатель степени осадки Беккера
        shearModulusK: 0.024,    // Модуль сдвиговой деформации Яноси K, м
        baseGrip: 0.52,          // Базовое касательное сцепление
        bearingCapacityBase: 6500.0, // Предельное давление рыхлого слоя, Па
        maxSinkRate: 0.42,       // Предел скорости просадки, м/с
        maxSinkDepth: 0.28,      // Предельная глубина до плотного слоя, м
        compactionSensitivity: 0.35 // Чувствительность к уплотнению
    },
    compacted_sand: {
        id: 'compacted_sand',
        name: 'Уплотнённый песок',
        frictionAngleDeg: 36.5,
        cohesion: 950.0,
        density: 1780.0,
        kc: 2200.0,
        kphi: 3800000.0,
        n: 0.95,
        shearModulusK: 0.016,
        baseGrip: 0.88,
        bearingCapacityBase: 24000.0,
        maxSinkRate: 0.20,
        maxSinkDepth: 0.16,
        compactionSensitivity: 0.15
    },
    dense_layer: {
        id: 'dense_layer',
        name: 'Плотный слой (хардпан)',
        frictionAngleDeg: 42.0,
        cohesion: 4500.0,
        density: 1950.0,
        kc: 8500.0,
        kphi: 8900000.0,
        n: 0.85,
        shearModulusK: 0.009,
        baseGrip: 0.96,
        bearingCapacityBase: 75000.0,
        maxSinkRate: 0.04,
        maxSinkDepth: 0.04,
        compactionSensitivity: 0.05
    },
    stone: {
        id: 'stone',
        name: 'Камень / валун',
        frictionAngleDeg: 45.0,
        cohesion: 1e6,
        density: 2600.0,
        kc: 1e8,
        kphi: 1e8,
        n: 0.5,
        shearModulusK: 0.002,
        baseGrip: 0.78,
        bearingCapacityBase: 1e7,
        maxSinkRate: 0.0,
        maxSinkDepth: 0.0,
        compactionSensitivity: 0.0
    },
    bedrock: {
        id: 'bedrock',
        name: 'Скальная поверхность',
        frictionAngleDeg: 48.0,
        cohesion: 5e6,
        density: 2750.0,
        kc: 1e9,
        kphi: 1e9,
        n: 0.5,
        shearModulusK: 0.001,
        baseGrip: 0.86,
        bearingCapacityBase: 5e7,
        maxSinkRate: 0.0,
        maxSinkDepth: 0.0,
        compactionSensitivity: 0.0
    }
};

const DEG2RAD = Math.PI / 180.0;

// Расчёт коэффициентов несущей способности Терцаги по углу внутреннего трения phi
export function computeBearingCapacityFactors(phiRad: number): { Nc: number; Nq: number; Ngamma: number } {
    const phi = Math.max(0.01, Math.min(1.25, phiRad));
    const a = Math.tan(Math.PI * 0.25 + phi * 0.5);
    const Nq = Math.exp(Math.PI * Math.tan(phi)) * a * a;
    const Nc = (Nq - 1.0) / Math.tan(phi);
    const Ngamma = 2.0 * (Nq + 1.0) * Math.tan(phi);
    return { Nc, Nq, Ngamma };
}

// Предельная несущая способность грунта q_ult по формуле Терцаги для мелкого фундамента
export function computeUltimateBearingCapacity(mat: SoilMaterial, width: number, depth: number = 0.0): number {
    if (mat.id === 'stone' || mat.id === 'bedrock') return mat.bearingCapacityBase;
    const phiRad = mat.frictionAngleDeg * DEG2RAD;
    const { Nc, Nq, Ngamma } = computeBearingCapacityFactors(phiRad);
    const gamma = mat.density * 9.81;
    // q_ult = c * Nc + gamma * D * Nq + 0.5 * gamma * b * Ngamma
    const qUlt = mat.cohesion * Nc + gamma * depth * Nq + 0.5 * gamma * width * Ngamma;
    return Math.max(mat.bearingCapacityBase, qUlt);
}

// Зависимость давление–просадка по модели Беккера: p = (kc/b + kphi) * z^n
// Обратная зависимость: z(p) = (p / (kc/b + kphi))^(1/n)
export function bekkerSinkage(p: number, width: number, mat: SoilMaterial): number {
    if (p <= 0 || mat.maxSinkDepth <= 0) return 0.0;
    const b = Math.max(0.05, width);
    const modulus = mat.kc / b + mat.kphi;
    if (modulus <= 0) return 0.0;
    const z = Math.pow(p / modulus, 1.0 / mat.n);
    return Math.min(mat.maxSinkDepth, z);
}

export function bekkerPressure(z: number, width: number, mat: SoilMaterial): number {
    if (z <= 0) return 0.0;
    const b = Math.max(0.05, width);
    const modulus = mat.kc / b + mat.kphi;
    return modulus * Math.pow(z, mat.n);
}

// Зависимость касательного напряжения от сдвига по модели Яноси–Ханамото:
// tau(j) = (c + p * tan(phi)) * (1 - e^(-j / K))
export function janosiShearStress(j: number, p: number, mat: SoilMaterial): number {
    if (p <= 0) return 0.0;
    const phiRad = mat.frictionAngleDeg * DEG2RAD;
    const tauMax = mat.cohesion + p * Math.tan(phiRad);
    if (tauMax <= 0) return 0.0;
    const K = Math.max(1e-4, mat.shearModulusK);
    const ratio = Math.max(0, j) / K;
    const mobilization = 1.0 - Math.exp(-ratio);
    return tauMax * mobilization;
}

// Эффективный коэффициент сцепления mu_eff = tau / p
export function janosiFrictionCoefficient(j: number, p: number, mat: SoilMaterial): number {
    if (p <= 1e-4) return mat.baseGrip;
    const tau = janosiShearStress(j, p, mat);
    const mu = tau / p;
    return Math.max(0.1, Math.min(1.4, mu));
}

// Сопротивление бульдозирования (сгребания песка перед подошвой при скольжении)
// F_bulldoze = 0.5 * gamma * z^2 * b * Kpe + 2 * c * z * b * sqrt(Kpe)
export function computeBulldozingResistance(z: number, width: number, mat: SoilMaterial): number {
    if (z <= 1e-4 || width <= 0) return 0.0;
    const phiRad = mat.frictionAngleDeg * DEG2RAD;
    const sinPhi = Math.sin(phiRad);
    const Kpe = (1.0 + sinPhi) / Math.max(1e-4, 1.0 - sinPhi); // Коэффициент пассивного давления
    const gamma = mat.density * 9.81;
    const zClamped = Math.min(z, mat.maxSinkDepth);
    const fPassive = 0.5 * gamma * zClamped * zClamped * width * Kpe;
    const fCohesion = 2.0 * mat.cohesion * zClamped * width * Math.sqrt(Kpe);
    return fPassive + fCohesion;
}

// Классификация состояния песка по уплотнению и глубине
export function classifySoilMaterial(
    packing: number,
    depth: number,
    isSolid: boolean = false,
    slope: number = 0.0,
    height: number = 0.0
): SoilMaterial {
    if (isSolid) return SOIL_MATERIALS.stone;
    if (slope > 0.65 || height > 11.0) return SOIL_MATERIALS.bedrock;
    if (depth >= 0.22 || packing >= 0.82) return SOIL_MATERIALS.dense_layer;
    if (packing >= 0.32) return SOIL_MATERIALS.compacted_sand;
    return SOIL_MATERIALS.loose_sand;
}

// Интерполированные terramechanical параметры для непрерывного уплотнения 0..1
export function getInterpolatedSandProperties(packing: number): SoilMaterial {
    const p = Math.max(0, Math.min(1, packing));
    let baseMat: SoilMaterial, nextMat: SoilMaterial, t: number;
    if (p < 0.45) {
        baseMat = SOIL_MATERIALS.loose_sand;
        nextMat = SOIL_MATERIALS.compacted_sand;
        t = p / 0.45;
    } else {
        baseMat = SOIL_MATERIALS.compacted_sand;
        nextMat = SOIL_MATERIALS.dense_layer;
        t = (p - 0.45) / 0.55;
    }
    const lerp = (a: number, b: number) => a + (b - a) * t;
    return {
        id: p < 0.45 ? 'loose_sand' : (p > 0.8 ? 'dense_layer' : 'compacted_sand'),
        name: p < 0.45 ? 'Рыхлый песок' : (p > 0.8 ? 'Плотный слой' : 'Уплотнённый песок'),
        frictionAngleDeg: lerp(baseMat.frictionAngleDeg, nextMat.frictionAngleDeg),
        cohesion: lerp(baseMat.cohesion, nextMat.cohesion),
        density: lerp(baseMat.density, nextMat.density),
        kc: lerp(baseMat.kc, nextMat.kc),
        kphi: lerp(baseMat.kphi, nextMat.kphi),
        n: lerp(baseMat.n, nextMat.n),
        shearModulusK: lerp(baseMat.shearModulusK, nextMat.shearModulusK),
        baseGrip: lerp(baseMat.baseGrip, nextMat.baseGrip),
        bearingCapacityBase: lerp(baseMat.bearingCapacityBase, nextMat.bearingCapacityBase),
        maxSinkRate: lerp(baseMat.maxSinkRate, nextMat.maxSinkRate),
        maxSinkDepth: lerp(baseMat.maxSinkDepth, nextMat.maxSinkDepth)
    };
}

