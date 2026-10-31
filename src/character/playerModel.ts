import * as THREE from 'three';

// Процедурный двуногий риг из бывшего standalone player.html.
// Сцена и жизненный цикл рендера принадлежат основному приложению.
export function createPlayerModel({ scene, scale = 1 }: { scene: THREE.Scene; scale?: number } = {} as any) {
    if (!scene) throw new Error('Player model requires a Three.js scene');  // 2. ПРОЦЕДУРНЫЕ LOW-RES ТЕКСТУРЫ В СТИЛЕ PS1 (С ДИЗЕРИНГОМ BAYER 4x4)
  // ============================================================================
  const bayer4x4 = [
    [ 0,  8,  2, 10],
    [12,  4, 14,  6],
    [ 3, 11,  1,  9],
    [15,  7, 13,  5]
  ];

  function createPS1Texture(
    width: number,
    height: number,
    drawFn: (x: number, y: number, w: number, h: number) => number[] | [number, number, number],
    repeatX: number = 1,
    repeatY: number = 1
  ): THREE.Texture {
    if (typeof document === 'undefined') {
      return new THREE.DataTexture(new Uint8Array(width * height * 4), width, height);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(width, height);
    const data = img.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rgb = drawFn(x, y, width, height);
        const r = Math.min(255, Math.max(0, Math.round(rgb[0])));
        const g = Math.min(255, Math.max(0, Math.round(rgb[1])));
        const b = Math.min(255, Math.max(0, Math.round(rgb[2])));
        const idx = (y * width + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.needsUpdate = true;
    return tex;
  }

  // Выгоревшая желто-охристая пустынная броня робота с заклепками и аккуратным безелем
  const desertArmorTex = createPS1Texture(64, 64, (x: number, y: number, w: number, h: number) => {
    let r = 186, g = 142, b = 74;
    const border = (x < 2 || y < 2 || x >= w - 2 || y >= h - 2 || x === 31 || y === 31);
    if (border) {
      r = 72; g = 64; b = 56;
    } else {
      // Заклепки по углам панелей
      const rx = x % 32, ry = y % 32;
      const isRivet = (rx === 4 || rx === 27) && (ry === 4 || ry === 27);
      if (isRivet) {
        r = 55; g = 50; b = 46;
      } else {
        const grad = Math.sin((y / h) * Math.PI * 2) * 8;
        r += grad; g += grad * 0.8; b += grad * 0.5;
      }
    }
    return [r, g, b];
  });

  // Диагональные черно-желтые предупреждающие полосы (Hazard Stripes)
  const hazardStripeTex = createPS1Texture(32, 32, (x: number, y: number) => {
    const stripe = ((x + y) >> 2) & 1;
    const r = stripe ? 204 : 38;
    const g = stripe ? 152 : 36;
    const b = stripe ? 44  : 34;
    return [r, g, b];
  });

  // Темный оружейный металл барабанов сервоприводов и редукторов с ребрами охлаждения
  const servoDrumTex = createPS1Texture(32, 32, (x: number, y: number, _w: number, h: number) => {
    let r = 64, g = 66, b = 70;
    const rib = (y % 4 === 0);
    if (rib) {
      r -= 18; g -= 18; b -= 18;
    }
    const bolt = (y === 6 || y === h - 7) && (x % 6 === 0);
    if (bolt) {
      r += 32; g += 30; b += 26;
    }
    return [r, g, b];
  });

  // Оксидированная несущая стальная рама и кожухи
  const rustyFrameTex = createPS1Texture(32, 32, (x: number, y: number, w: number, h: number) => {
    let r = 78, g = 72, b = 66;
    const border = (x < 2 || y < 2 || x >= w - 2 || y >= h - 2);
    if (border) {
      r -= 22; g -= 20; b -= 18;
    }
    return [r, g, b];
  });

  // Светлый хромированный металл для штоков гидроцилиндров
  const chromeRodTex = createPS1Texture(16, 32, (x: number) => {
    const sheen = Math.sin((x / 16) * Math.PI) * 45;
    return [165 + sheen, 170 + sheen, 175 + sheen];
  });

  // Армированные гидравлические шланги высокого давления
  const rubberHoseTex = createPS1Texture(32, 32, (_x: number, y: number) => {
    const rib = Math.sin((y / 32) * Math.PI * 12);
    const shade = Math.floor(rib * 16);
    return [42 + shade, 40 + shade, 38 + shade];
  });

  // Светящаяся янтарно-оранжевая оптика сенсоров и визора робота
  const amberOpticTex = createPS1Texture(32, 32, (x: number, y: number, w: number, h: number) => {
    const cx = x - w * 0.5;
    const cy = y - h * 0.5;
    const dist = Math.sqrt(cx * cx + cy * cy) / (w * 0.5);
    const glow = Math.max(0, 1.0 - dist * 0.55);
    const scanline = (y & 1) ? 0.94 : 1.06;
    const glint = (x + y > 18 && x + y < 23) ? 40 : 0;
    const r = Math.min(255, (235 * glow + glint) * scanline);
    const g = Math.min(255, (125 * glow + glint * 0.6) * scanline);
    const b = Math.min(255, (24 * glow + glint * 0.2));
    return [r, g, b];
  });

  // Плотный пустынный брезент пылезащитного кожуха на шее/плече
  const desertShroudTex = createPS1Texture(32, 32, (_x: number, y: number) => {
    const r = 122, g = 106, b = 82;
    const fold = Math.sin((y / 32) * Math.PI * 4) * 8;
    return [r + fold, g + fold, b + fold];
  });

  const matDesertArmor = new THREE.MeshLambertMaterial({ map: desertArmorTex, flatShading: true });
  const matHazardStripe = new THREE.MeshLambertMaterial({ map: hazardStripeTex, flatShading: true });
  const matServoDrum = new THREE.MeshLambertMaterial({ map: servoDrumTex, flatShading: true });
  const matRustyFrame = new THREE.MeshLambertMaterial({ map: rustyFrameTex, flatShading: true });
  const matChromeRod = new THREE.MeshLambertMaterial({ map: chromeRodTex, flatShading: true });
  const matRubberHose = new THREE.MeshLambertMaterial({ map: rubberHoseTex, flatShading: true });
  const matAmberOptic = new THREE.MeshLambertMaterial({ map: amberOpticTex, flatShading: true });
  const matDesertShroud = new THREE.MeshLambertMaterial({ map: desertShroudTex, flatShading: true, side: THREE.DoubleSide });
  const matCopperCoil = new THREE.MeshLambertMaterial({ color: 0xb06c36, flatShading: true });
  const matDarkFrame = new THREE.MeshLambertMaterial({ color: 0x2b2d30, flatShading: true });

  // ============================================================================
  // 3. КОНСТРУКТОРЫ СЕРВОПРИВОДОВ И АКТИВНЫХ ТЕЛЕСКОПИЧЕСКИХ ГИДРОЦИЛИНДРОВ
  // ============================================================================
  const rigRootGroup = new THREE.Group();
  scene.add(rigRootGroup);

  function addPart(
    parent: THREE.Object3D,
    geom: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number = 0,
    y: number = 0,
    z: number = 0,
    rx: number = 0,
    ry: number = 0,
    rz: number = 0
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  }

  // Создает выразительный цилиндрический узел роторного сервопривода с крышками и медной обмоткой
  function addServoDrum(
    parent: THREE.Object3D,
    radius: number,
    width: number,
    x: number,
    y: number,
    z: number,
    axis: 'x' | 'y' | 'z' = 'x'
  ): THREE.Group {
    const servo = new THREE.Group();
    servo.position.set(x, y, z);
    if (axis === 'x') servo.rotation.z = Math.PI / 2;
    else if (axis === 'z') servo.rotation.x = Math.PI / 2;
    parent.add(servo);

    // Основной ребристый барабан сервомотора
    addPart(servo, new THREE.CylinderGeometry(radius, radius, width, 8), matServoDrum, 0, 0, 0);
    // Торцевые крышки подшипников с медными кольцами статора
    addPart(servo, new THREE.CylinderGeometry(radius * 0.76, radius * 0.76, width + 0.016, 8), matRustyFrame, 0, 0, 0);
    addPart(servo, new THREE.CylinderGeometry(radius * 0.52, radius * 0.52, width + 0.028, 6), matCopperCoil, 0, 0, 0);
    addPart(servo, new THREE.CylinderGeometry(radius * 0.28, radius * 0.28, width + 0.042, 6), matChromeRod, 0, 0, 0);
    return servo;
  }

  // Список всех активных телескопических гидроцилиндров для обновления в каждом кадре
  interface ActivePiston {
    parentA: THREE.Object3D;
    localA: THREE.Vector3;
    parentB: THREE.Object3D;
    localB: THREE.Vector3;
    barrelPivot: THREE.Group;
    rodPivot: THREE.Group;
  }
  const activePistons: ActivePiston[] = [];
  const _pistonPosA = new THREE.Vector3();
  const _pistonPosB = new THREE.Vector3();

  /**
   * Создает рабочий двухсоставной гидроцилиндр между двумя точками на разных костях:
   * - Корпус цилиндра (barrel) крепится к parentA и следит (lookAt) за точкой на parentB
   * - Хромированный шток (rod) крепится к parentB и входит внутрь цилиндра
   */
  function registerHydraulicPiston(
    parentA: THREE.Object3D,
    localVecA: THREE.Vector3,
    parentB: THREE.Object3D,
    localVecB: THREE.Vector3,
    barrelRadius: number,
    barrelLen: number,
    rodLen: number,
    barrelMat: THREE.Material = matRustyFrame
  ): void {
    const barrelPivot = new THREE.Group();
    rigRootGroup.add(barrelPivot);

    // Крепежная проушина и основной стакан гидроцилиндра (вдоль +Z)
    addPart(barrelPivot, new THREE.CylinderGeometry(barrelRadius * 1.15, barrelRadius * 1.15, barrelRadius * 1.8, 6), matDarkFrame, 0, 0, 0, 0, 0, Math.PI / 2);
    addPart(barrelPivot, new THREE.CylinderGeometry(barrelRadius, barrelRadius, barrelLen, 6), barrelMat, 0, 0, barrelLen * 0.5, Math.PI / 2, 0, 0);
    // Уплотнительная бронзовая манжета на выходе штока
    addPart(barrelPivot, new THREE.CylinderGeometry(barrelRadius * 1.12, barrelRadius * 1.12, 0.028, 6), matCopperCoil, 0, 0, barrelLen, Math.PI / 2, 0, 0);

    const rodPivot = new THREE.Group();
    rigRootGroup.add(rodPivot);

    const rodRadius = barrelRadius * 0.56;
    addPart(rodPivot, new THREE.CylinderGeometry(barrelRadius * 1.05, barrelRadius * 1.05, barrelRadius * 1.6, 6), matDarkFrame, 0, 0, 0, 0, 0, Math.PI / 2);
    addPart(rodPivot, new THREE.CylinderGeometry(rodRadius, rodRadius, rodLen, 6), matChromeRod, 0, 0, rodLen * 0.5, Math.PI / 2, 0, 0);

    activePistons.push({
      parentA,
      localA: localVecA.clone(),
      parentB,
      localB: localVecB.clone(),
      barrelPivot,
      rodPivot
    });
  }

  const _vPistonDir = new THREE.Vector3();
  const _vPistonUp = new THREE.Vector3();
  const _vPistonRight = new THREE.Vector3();
  const _vPistonOrthoUp = new THREE.Vector3();
  const _vPistonLateral = new THREE.Vector3(1, 0, 0);
  const _mPiston = new THREE.Matrix4();

  function orientPiston(pivot: THREE.Object3D, fromPos: THREE.Vector3, toPos: THREE.Vector3): void {
    pivot.position.copy(fromPos);
    _vPistonDir.subVectors(toPos, fromPos);
    const dist = _vPistonDir.length();
    if (dist < 0.0001) return;
    _vPistonDir.divideScalar(dist);

    // Цилиндры ориентированы вдоль оси Z в локальной системе координат.
    // Суставы коленей и лодыжек сгибаются в сагиттальной плоскости (Y-Z), поэтому вектор
    // цилиндра никогда не коллинеарен латеральной оси X (1,0,0).
    // Поперечное произведение (1,0,0) x _vPistonDir дает гладкую непрерывную нормаль
    // без пороговых переключений и скачков на 90 градусов.
    _vPistonRight.crossVectors(_vPistonLateral, _vPistonDir);
    if (_vPistonRight.lengthSq() < 0.0001) {
      _vPistonRight.set(0, 1, 0).crossVectors(new THREE.Vector3(0, 1, 0), _vPistonDir);
    }
    _vPistonRight.normalize();
    _vPistonOrthoUp.crossVectors(_vPistonDir, _vPistonRight).normalize();
    _mPiston.makeBasis(_vPistonRight, _vPistonOrthoUp, _vPistonDir);
    pivot.quaternion.setFromRotationMatrix(_mPiston);
  }

  function updateAllHydraulicPistons() {
    for (let i = 0; i < activePistons.length; i++) {
      const p = activePistons[i];
      _pistonPosA.copy(p.localA);
      p.parentA.localToWorld(_pistonPosA);

      _pistonPosB.copy(p.localB);
      p.parentB.localToWorld(_pistonPosB);

      orientPiston(p.barrelPivot, _pistonPosA, _pistonPosB);
      orientPiston(p.rodPivot, _pistonPosB, _pistonPosA);
    }
  }

  // ============================================================================
  // ============================================================================
  // 5. СБОРКА ТЯЖЕЛОГО ПУСТЫННОГО РОБОТА С СЕРВОПРИВОДАМИ И ГИДРАВЛИКОЙ
  // ============================================================================
  const suitRoot = new THREE.Group();
  rigRootGroup.add(suitRoot);

  const BASE_PELVIS_Y = 0.95;
  const pelvisGroup = new THREE.Group();
  pelvisGroup.position.set(0, BASE_PELVIS_Y, 0);
  suitRoot.add(pelvisGroup);

  // --- 5.1 МАССИВНЫЙ ТАЗОВЫЙ СИЛОВОЙ УЗЕЛ, ВИЛКИ БЕДЕР И ОПОРНЫЙ ПОГОН ТАЛИИ ---
  // Центральная несущая люлька таза и глубокий нижний паховый киль (соединяет корпус между бедрами)
  addPart(pelvisGroup, new THREE.BoxGeometry(0.34, 0.18, 0.28), matRustyFrame, 0, -0.01, 0);
  addPart(pelvisGroup, new THREE.BoxGeometry(0.18, 0.15, 0.26), matDarkFrame, 0, -0.11, 0.01);
  addPart(pelvisGroup, new THREE.BoxGeometry(0.14, 0.08, 0.20), matRustyFrame, 0, -0.17, 0.01);

  // Лобовой клиновидный бронеблок паха и передний отбойник с полосами безопасности
  addPart(pelvisGroup, new THREE.BoxGeometry(0.22, 0.20, 0.14), matDesertArmor, 0, -0.04, 0.13, 0.18, 0, 0);
  addPart(pelvisGroup, new THREE.BoxGeometry(0.16, 0.12, 0.10), matDesertArmor, 0, -0.14, 0.11, -0.25, 0, 0);
  addPart(pelvisGroup, new THREE.BoxGeometry(0.18, 0.08, 0.06), matHazardStripe, 0, -0.07, 0.18, 0.18, 0, 0);

  // Задний силовой коллектор таза с гидрораспределителем и бронеплитой
  addPart(pelvisGroup, new THREE.BoxGeometry(0.30, 0.18, 0.12), matDesertArmor, 0, 0.0, -0.14, -0.14, 0, 0);
  addPart(pelvisGroup, new THREE.BoxGeometry(0.20, 0.12, 0.10), matServoDrum, 0, -0.10, -0.12);

  // Широкий опорно-поворотный погон талии (турельное кольцо) и гофрированный пыльник между тазом и торсом
  addPart(pelvisGroup, new THREE.CylinderGeometry(0.155, 0.17, 0.06, 8), matServoDrum, 0, 0.10, -0.01);
  addPart(pelvisGroup, new THREE.CylinderGeometry(0.135, 0.145, 0.11, 8), matRubberHose, 0, 0.15, -0.01);
  addPart(pelvisGroup, new THREE.CylinderGeometry(0.085, 0.095, 0.18, 8), matRustyFrame, 0, 0.13, -0.01);
  addPart(pelvisGroup, new THREE.CylinderGeometry(0.105, 0.105, 0.03, 8), matCopperCoil, 0, 0.15, -0.01);

  // Массивные боковые силовые мосты, кронштейны-вилки тазобедренных сервоприводов и набедренные щитки
  for (let s of [-1, 1]) {
    // Поперечный силовой мост от центра таза к бедру
    addPart(pelvisGroup, new THREE.BoxGeometry(0.14, 0.15, 0.24), matRustyFrame, s * 0.16, -0.03, 0);
    // Главный барабан тазобедренного сервопривода
    addServoDrum(pelvisGroup, 0.095, 0.13, s * 0.20, -0.04, 0, 'x');
    // Передняя и задняя щеки силовой вилки, охватывающей верх бедра
    addPart(pelvisGroup, new THREE.BoxGeometry(0.13, 0.14, 0.05), matRustyFrame, s * 0.20, -0.04, 0.11);
    addPart(pelvisGroup, new THREE.BoxGeometry(0.13, 0.14, 0.05), matRustyFrame, s * 0.20, -0.04, -0.11);
    // Верхний шарнирный бронекожух таза (накрывает стык корпуса и ноги)
    addPart(pelvisGroup, new THREE.BoxGeometry(0.12, 0.14, 0.28), matDesertArmor, s * 0.22, 0.06, 0, 0, 0, -s * 0.24);
    addPart(pelvisGroup, new THREE.BoxGeometry(0.05, 0.15, 0.24), matDesertArmor, s * 0.28, -0.02, 0, 0, 0, -s * 0.12);
    addPart(pelvisGroup, new THREE.BoxGeometry(0.055, 0.06, 0.14), matHazardStripe, s * 0.285, 0.01, 0.04, 0, 0, -s * 0.12);
    // Толстые перепускные гидрошланги от тазового коллектора к бедрам
    addPart(pelvisGroup, new THREE.CylinderGeometry(0.022, 0.022, 0.18, 6), matRubberHose, s * 0.16, 0.08, -0.09, 0.35, 0, -s * 0.35);
  }

  // --- 5.2 НАГРУДНЫЙ СИЛОВОЙ КАРКАС, ПЛЕЧЕВЫЕ СЕРВОУЗЛЫ И ДИЗЕЛЬ-ГЕНЕРАТОР ---
  const torsoGroup = new THREE.Group();
  torsoGroup.position.set(0, 0.18, 0);
  pelvisGroup.add(torsoGroup);

  // Нижний подбрюшный силовой пояс торса (плотно стыкуется с поворотным погоном таза)
  addPart(torsoGroup, new THREE.CylinderGeometry(0.165, 0.15, 0.08, 8), matRustyFrame, 0, 0.04, -0.01);
  addPart(torsoGroup, new THREE.BoxGeometry(0.32, 0.12, 0.24), matDarkFrame, 0, 0.09, 0.0);

  // Внутренний темный силовой блок грудной клетки
  addPart(torsoGroup, new THREE.BoxGeometry(0.38, 0.34, 0.26), matRustyFrame, 0, 0.24, -0.01);

  // Четыре рабочих гидроцилиндра торса (2 передних и 2 задне-боковых), мощно связывающих таз и грудную клетку
  for (let s of [-1, 1]) {
    registerHydraulicPiston(
      pelvisGroup, new THREE.Vector3(s * 0.12, 0.04, 0.09),
      torsoGroup,  new THREE.Vector3(s * 0.135, 0.11, 0.10),
      0.028, 0.14, 0.14, matRustyFrame
    );
    registerHydraulicPiston(
      pelvisGroup, new THREE.Vector3(s * 0.14, 0.05, -0.08),
      torsoGroup,  new THREE.Vector3(s * 0.15, 0.12, -0.09),
      0.024, 0.14, 0.14, matServoDrum
    );
  }

  // Многослойная граненая нагрудная броня в цвете пустынной охры
  addPart(torsoGroup, new THREE.BoxGeometry(0.44, 0.22, 0.14), matDesertArmor, 0, 0.27, 0.11, -0.16, 0, 0);
  addPart(torsoGroup, new THREE.BoxGeometry(0.34, 0.13, 0.12), matDesertArmor, 0, 0.11, 0.10, 0.26, 0, 0);
  // Центральная вставка с черно-желтыми полосами безопасности и такелажными скобами
  addPart(torsoGroup, new THREE.BoxGeometry(0.16, 0.18, 0.04), matHazardStripe, 0, 0.26, 0.175, -0.16, 0, 0);

  // Боковые решетки радиаторов охлаждения и открытые медные шины на груди
  for (let s of [-1, 1]) {
    addPart(torsoGroup, new THREE.BoxGeometry(0.09, 0.16, 0.06), matServoDrum, s * 0.16, 0.26, 0.16, -0.16, s * 0.22, 0);
    // Выступающие кронштейны плечевых сервоприводов
    addPart(torsoGroup, new THREE.BoxGeometry(0.14, 0.14, 0.20), matRustyFrame, s * 0.25, 0.33, 0.0);
    addServoDrum(torsoGroup, 0.082, 0.09, s * 0.28, 0.33, 0.0, 'z');
  }

  // Нагрудный оптический датчик / лазерный дальномер и защитная стальная дуга (Roll-bar)
  addPart(torsoGroup, new THREE.CylinderGeometry(0.034, 0.034, 0.05, 6), matRustyFrame, -0.14, 0.34, 0.18, Math.PI / 2, 0, 0);
  addPart(torsoGroup, new THREE.CylinderGeometry(0.024, 0.024, 0.054, 6), matAmberOptic, -0.14, 0.34, 0.182, Math.PI / 2, 0, 0);
  // Трубчатая защитная дуга вокруг воротниковой зоны
  addPart(torsoGroup, new THREE.CylinderGeometry(0.015, 0.015, 0.34, 5), matRustyFrame, 0, 0.41, 0.17, 0, 0, Math.PI / 2);
  for (let s of [-1, 1]) {
    addPart(torsoGroup, new THREE.CylinderGeometry(0.015, 0.015, 0.14, 5), matRustyFrame, s * 0.16, 0.40, 0.11, Math.PI / 2, 0, 0);
  }

  // Пылезащитный брезентовый воротник-кожух вокруг шейного шарнира и левого плеча (пост-апок деталь)
  const dustCollar = addPart(torsoGroup, new THREE.ConeGeometry(0.22, 0.16, 7, 1, true), matDesertShroud, 0, 0.41, -0.01, 0.06, 0.4, 0);
  dustCollar.scale.set(1.15, 1.0, 0.9);

  // --- 5.3 СПИННОЙ СИЛОВОЙ АГРЕГАТ (ГИДРОНАСОСНАЯ СТАНЦИЯ, ВЫХЛОП И БАЛЛОНЫ) ---
  const backpackGroup = new THREE.Group();
  backpackGroup.position.set(0, 0.23, -0.19);
  torsoGroup.add(backpackGroup);

  // Основной бронекожух силовой установки со скошенными гранями
  addPart(backpackGroup, new THREE.BoxGeometry(0.36, 0.34, 0.18), matDesertArmor, 0, 0.03, -0.05);
  addPart(backpackGroup, new THREE.BoxGeometry(0.28, 0.12, 0.14), matHazardStripe, 0, 0.16, -0.06, 0.25, 0, 0);
  // Решетка заднего радиатора и блок маслоохладителя
  addPart(backpackGroup, new THREE.BoxGeometry(0.24, 0.18, 0.05), matServoDrum, 0, 0.01, -0.14);

  // Два наклонных цилиндрических аккумулятора гидравлического давления снизу ранца
  for (let s of [-1, 1]) {
    addPart(backpackGroup, new THREE.CylinderGeometry(0.058, 0.058, 0.24, 7), matRustyFrame, s * 0.13, -0.14, -0.06, 0.25, 0, s * 0.18);
    addPart(backpackGroup, new THREE.CylinderGeometry(0.062, 0.062, 0.04, 7), matCopperCoil, s * 0.12, -0.10, -0.05, 0.25, 0, s * 0.18);
    // Верхние выхлопные трубы с перфорированными кожухами
    addPart(backpackGroup, new THREE.CylinderGeometry(0.032, 0.038, 0.24, 6), matRustyFrame, s * 0.15, 0.28, -0.06, -0.15, 0, 0);
    addPart(backpackGroup, new THREE.CylinderGeometry(0.044, 0.044, 0.12, 6), matServoDrum, s * 0.15, 0.25, -0.05, -0.15, 0, 0);
  }

  // Армированные гидравлические шланги, идущие от ранца под руками к торсу
  for (let s of [-1, 1]) {
    addPart(torsoGroup, new THREE.CylinderGeometry(0.025, 0.025, 0.28, 6), matRubberHose, s * 0.21, 0.13, -0.02, Math.PI / 2, 0, s * 0.18);
  }

  // Высокая штыревая антенна телеметрии справа на ранце
  addPart(backpackGroup, new THREE.CylinderGeometry(0.006, 0.014, 0.52, 5), matRustyFrame, 0.16, 0.44, -0.02);

  // --- 5.4 МЕХАНИЧЕСКАЯ СЕНСОРНАЯ ГОЛОВА РОБОТА НА ГИДРОПРИВОДАХ ---
  // Шейный сервошарнир
  addServoDrum(torsoGroup, 0.062, 0.09, 0, 0.44, 0.0, 'x');

  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.49, 0.01);
  torsoGroup.add(headGroup);

  // Пара шейных гидроцилиндров стабилизации головы
  for (let s of [-1, 1]) {
    registerHydraulicPiston(
      torsoGroup, new THREE.Vector3(s * 0.085, 0.38, 0.07),
      headGroup,  new THREE.Vector3(s * 0.075, 0.06, 0.05),
      0.016, 0.08, 0.08, matRustyFrame
    );
  }

  // Граненый бронекорпус сенсорной головы (угловатый индустриальный блок с козырьком)
  addPart(headGroup, new THREE.BoxGeometry(0.22, 0.17, 0.26), matDesertArmor, 0, 0.11, 0.01);
  // Скошенная верхняя крышка с ребрами радиатора и противопыльным козырьком над оптикой
  addPart(headGroup, new THREE.BoxGeometry(0.24, 0.045, 0.28), matDesertArmor, 0, 0.20, 0.03, 0.12, 0, 0);
  addPart(headGroup, new THREE.BoxGeometry(0.16, 0.03, 0.16), matServoDrum, 0, 0.225, -0.02);
  // Нижняя челюстная рама с черно-желтой маркировкой
  addPart(headGroup, new THREE.BoxGeometry(0.18, 0.055, 0.22), matHazardStripe, 0, 0.02, 0.03);

  // Темная лицевая панель оптической матрицы
  addPart(headGroup, new THREE.BoxGeometry(0.20, 0.11, 0.04), matDarkFrame, 0, 0.11, 0.13);

  // Асимметричный блок оптики: крупный главный объектив справа + спаренные целеуказатели слева + узкая щель визора
  // 1) Крупный телеобъектив с янтарной линзой
  addPart(headGroup, new THREE.CylinderGeometry(0.052, 0.056, 0.07, 7), matRustyFrame, -0.045, 0.11, 0.16, Math.PI / 2, 0, 0);
  addPart(headGroup, new THREE.CylinderGeometry(0.044, 0.044, 0.075, 7), matCopperCoil, -0.045, 0.11, 0.162, Math.PI / 2, 0, 0);
  addPart(headGroup, new THREE.CylinderGeometry(0.035, 0.035, 0.08, 7), matAmberOptic, -0.045, 0.11, 0.165, Math.PI / 2, 0, 0);

  // 2) Два малых вертикальных сенсора слева
  for (let vy of [0.135, 0.082]) {
    addPart(headGroup, new THREE.CylinderGeometry(0.024, 0.026, 0.06, 6), matRustyFrame, 0.055, vy, 0.155, Math.PI / 2, 0, 0);
    addPart(headGroup, new THREE.CylinderGeometry(0.017, 0.017, 0.065, 6), matAmberOptic, 0.055, vy, 0.158, Math.PI / 2, 0, 0);
  }

  // Боковые цилиндрические сервоприводы поворота оптической оси и боковая антенна
  for (let s of [-1, 1]) {
    addServoDrum(headGroup, 0.045, 0.04, s * 0.125, 0.11, -0.02, 'x');
  }
  addPart(headGroup, new THREE.CylinderGeometry(0.006, 0.01, 0.22, 5), matRustyFrame, -0.12, 0.26, -0.06);

  // ============================================================================
  // 6. МЕХАНИЧЕСКИЕ КОНЕЧНОСТИ С СЕРВОБАРАБАНАМИ, ГИДРАВЛИКОЙ И TWO-BONE 3D IK
  // ============================================================================
  const THIGH_LEN = 0.45;
  const SHIN_LEN = 0.45;
  const FOOT_HEIGHT = 0.11;

  const UPPER_ARM_LEN = 0.34;
  const FOREARM_LEN = 0.33;

  function createRobotLeg(sideSign: number) {
    const hipMount = new THREE.Group();
    hipMount.position.set(sideSign * 0.20, -0.05, 0);
    pelvisGroup.add(hipMount);

    // --- БЕДРО РОБОТА (ориентируется через IK вдоль локальной оси +Z) ---
    const thighBone = new THREE.Group();
    rigRootGroup.add(thighBone);

    // Массивный верхний поворотный кулак бедра (входит внутрь вилки таза без пустот)
    addPart(thighBone, new THREE.BoxGeometry(0.125, 0.15, 0.16), matRustyFrame, 0, 0, 0.04);
    addServoDrum(thighBone, 0.082, 0.14, 0, 0, 0.01, 'x');
    // Продольный барабан сервопривода отведения бедра (по оси Y/крену)
    addServoDrum(thighBone, 0.074, 0.13, 0, 0, 0.09, 'y');

    // Внутренний двутавровый силовой каркас бедра
    addPart(thighBone, new THREE.BoxGeometry(0.095, 0.12, THIGH_LEN), matDarkFrame, 0, 0, THIGH_LEN * 0.5);

    // Большой барабан коленного сервопривода
    addServoDrum(thighBone, 0.086, 0.145, 0, 0, THIGH_LEN, 'x');

    // Объемные угловатые бронеплиты бедра (спереди, сзади и снаружи), формирующие плотный силуэт ноги
    addPart(thighBone, new THREE.BoxGeometry(0.145, 0.095, THIGH_LEN * 0.76), matDesertArmor, 0, 0.055, THIGH_LEN * 0.46, -0.05, 0, 0);
    addPart(thighBone, new THREE.BoxGeometry(0.06, 0.145, THIGH_LEN * 0.72), matDesertArmor, sideSign * 0.068, 0.005, THIGH_LEN * 0.44);
    addPart(thighBone, new THREE.BoxGeometry(0.125, 0.065, THIGH_LEN * 0.55), matRustyFrame, 0, -0.05, THIGH_LEN * 0.42);
    addPart(thighBone, new THREE.BoxGeometry(0.13, 0.045, 0.11), matHazardStripe, 0, 0.085, THIGH_LEN * 0.78);

    // --- РАБОЧИЕ ТАЗОБЕДРЕННЫЕ ГИДРОЦИЛИНДРЫ (связывают таз напрямую с бедром) ---
    // Передний силовой гидроцилиндр сгибателя бедра
    registerHydraulicPiston(
      pelvisGroup, new THREE.Vector3(sideSign * 0.135, 0.04, 0.11),
      thighBone,   new THREE.Vector3(sideSign * 0.015, 0.085, THIGH_LEN * 0.34),
      0.025, 0.16, 0.16, matRustyFrame
    );
    // Задний силовой гидроцилиндр разгибателя/стабилизатора бедра
    registerHydraulicPiston(
      pelvisGroup, new THREE.Vector3(sideSign * 0.15, 0.02, -0.11),
      thighBone,   new THREE.Vector3(sideSign * 0.02, -0.075, THIGH_LEN * 0.30),
      0.024, 0.15, 0.15, matServoDrum
    );

    // --- ГОЛЕНЬ РОБОТА (ориентируется через IK вдоль локальной оси +Z) ---
    const shinBone = new THREE.Group();
    rigRootGroup.add(shinBone);

    // Несущая стальная штанга голени и массивный коленный бронещиток-отбойник
    addPart(shinBone, new THREE.BoxGeometry(0.075, 0.09, SHIN_LEN), matDarkFrame, 0, -0.01, SHIN_LEN * 0.5);
    addPart(shinBone, new THREE.BoxGeometry(0.145, 0.11, 0.15), matDesertArmor, 0, 0.075, 0.04, -0.22, 0, 0);
    addPart(shinBone, new THREE.BoxGeometry(0.125, 0.05, 0.08), matHazardStripe, 0, 0.105, 0.06, -0.22, 0, 0);

    // Передний наклонный бронещит голени (прикрывает верхнюю часть, оставляя открытыми штоки внизу)
    addPart(shinBone, new THREE.BoxGeometry(0.13, 0.075, SHIN_LEN * 0.48), matDesertArmor, 0, 0.055, SHIN_LEN * 0.36, 0.08, 0, 0);
    // Нижний бронеманжет над голеностопным сервоприводом
    addPart(shinBone, new THREE.BoxGeometry(0.125, 0.095, 0.11), matRustyFrame, 0, 0.01, SHIN_LEN * 0.84);
    addServoDrum(shinBone, 0.068, 0.13, 0, 0, SHIN_LEN, 'x');

    // --- РАБОЧАЯ ГИДРАВЛИКА НОГИ (реально сжимается и разжимается при сгибе колена и стопы) ---
    // 1) Задний силовой гидроцилиндр коленного сустава (между бедром и голенью)
    registerHydraulicPiston(
      thighBone, new THREE.Vector3(0, -0.075, THIGH_LEN * 0.25),
      shinBone,  new THREE.Vector3(0, -0.085, SHIN_LEN * 0.32),
      0.028, 0.18, 0.18, matRustyFrame
    );

    // --- МЕХАНИЧЕСКАЯ СТОПА С ДВУМЯ ПЕРЕДНИМИ ГРУНТОЗАЦЕПАМИ И ПЯТОЧНЫМ УПОРОМ ---
    const footGroup = new THREE.Group();
    rigRootGroup.add(footGroup);

    // Центральный блок лодыжки и подошвенная рама
    addPart(footGroup, new THREE.BoxGeometry(0.12, 0.08, 0.14), matRustyFrame, 0, 0.065, 0.0);
    addPart(footGroup, new THREE.BoxGeometry(0.15, 0.05, 0.11), matDesertArmor, 0, 0.065, 0.05, 0.25, 0, 0);

    // Два разведенных передних механических пальца-упора с полосами безопасности
    for (let t of [-1, 1]) {
      addPart(footGroup, new THREE.BoxGeometry(0.068, 0.048, 0.15), matDesertArmor, t * 0.048, 0.026, 0.13, 0.08, t * 0.12, 0);
      addPart(footGroup, new THREE.BoxGeometry(0.064, 0.026, 0.08), matDarkFrame, t * 0.052, 0.015, 0.18, 0, t * 0.12, 0);
    }
    // Задняя пяточная шпора-амортизатор
    addPart(footGroup, new THREE.BoxGeometry(0.095, 0.042, 0.12), matRustyFrame, 0, 0.022, -0.09, -0.1, 0, 0);

    // 2) Пара боковых и задний гидроцилиндры голеностопа (между голенью и стопой)
    registerHydraulicPiston(
      shinBone,  new THREE.Vector3(0, -0.07, SHIN_LEN * 0.44),
      footGroup, new THREE.Vector3(0, 0.045, -0.10),
      0.022, 0.16, 0.16, matRustyFrame
    );
    for (let s of [-1, 1]) {
      registerHydraulicPiston(
        shinBone,  new THREE.Vector3(s * 0.068, 0.025, SHIN_LEN * 0.42),
        footGroup, new THREE.Vector3(s * 0.058, 0.055, 0.06),
        0.018, 0.15, 0.15, matServoDrum
      );
    }

    return {
      sideSign,
      hipMount,
      thighBone,
      shinBone,
      footGroup,
      ankleTarget: new THREE.Vector3(sideSign * 0.19, FOOT_HEIGHT, 0)
    };
  }

  function createRobotArm(sideSign: number) {
    const shoulderMount = new THREE.Group();
    shoulderMount.position.set(sideSign * 0.31, 0.33, 0.0);
    torsoGroup.add(shoulderMount);

    // --- ПЛЕЧО РОБОТА (ориентируется через IK вдоль локальной оси +Z) ---
    const upperArmBone = new THREE.Group();
    rigRootGroup.add(upperArmBone);

    // Верхний барабан плечевого сервопривода
    addServoDrum(upperArmBone, 0.072, 0.11, 0, 0, 0.02, 'x');

    // Асимметричные бронированные наплечники: слева — тяжелый щит с полосами безопасности, справа — граненый кожух с брезентовым пыльником
    if (sideSign < 0) {
      addPart(upperArmBone, new THREE.BoxGeometry(0.15, 0.16, 0.18), matDesertArmor, -0.03, 0.02, 0.06, 0, 0, 0.25);
      addPart(upperArmBone, new THREE.BoxGeometry(0.155, 0.06, 0.16), matHazardStripe, -0.035, 0.02, 0.12, 0, 0, 0.25);
    } else {
      addPart(upperArmBone, new THREE.BoxGeometry(0.13, 0.13, 0.15), matDesertArmor, 0.02, 0.02, 0.05, 0, 0, -0.22);
      addPart(upperArmBone, new THREE.CylinderGeometry(0.088, 0.095, 0.12, 7), matDesertShroud, 0.01, 0.0, 0.09, Math.PI / 2, 0, 0);
    }

    // Открытая стальная балка плеча, бронепластина и локтевой сервобарабан
    addPart(upperArmBone, new THREE.BoxGeometry(0.065, 0.075, UPPER_ARM_LEN), matDarkFrame, 0, 0, UPPER_ARM_LEN * 0.5);
    addPart(upperArmBone, new THREE.BoxGeometry(0.095, 0.065, UPPER_ARM_LEN * 0.55), matRustyFrame, sideSign * 0.02, 0.02, UPPER_ARM_LEN * 0.54);
    addServoDrum(upperArmBone, 0.066, 0.11, 0, 0, UPPER_ARM_LEN, 'x');

    // --- ПРЕДПЛЕЧЬЕ И ТРЕХПАЛАЯ МЕХАНИЧЕСКАЯ КЛЕШНЯ (ориентируются вдоль локальной оси +Z) ---
    const forearmBone = new THREE.Group();
    rigRootGroup.add(forearmBone);

    // Несущая штанга предплечья и локтевой отбойник
    addPart(forearmBone, new THREE.BoxGeometry(0.065, 0.075, FOREARM_LEN), matDarkFrame, 0, 0, FOREARM_LEN * 0.5);
    addPart(forearmBone, new THREE.BoxGeometry(0.105, 0.07, 0.10), matDesertArmor, 0, -0.045, 0.03, 0.2, 0, 0);

    // Внешний кожух предплечья с открытыми направляющими и запястным сервоприводом
    addPart(forearmBone, new THREE.BoxGeometry(0.11, 0.085, FOREARM_LEN * 0.62), matDesertArmor, 0, 0.025, FOREARM_LEN * 0.48);
    addPart(forearmBone, new THREE.BoxGeometry(0.095, 0.04, 0.08), matHazardStripe, 0, 0.055, FOREARM_LEN * 0.72);
    addServoDrum(forearmBone, 0.052, 0.085, 0, 0, FOREARM_LEN, 'y');

    // Рабочий гидроцилиндр привода локтя (между плечом и предплечьем)
    registerHydraulicPiston(
      upperArmBone, new THREE.Vector3(0, 0.062, UPPER_ARM_LEN * 0.34),
      forearmBone,  new THREE.Vector3(0, 0.065, FOREARM_LEN * 0.32),
      0.020, 0.14, 0.14, matRustyFrame
    );

    // Индустриальный трехпалый захват-клешня на конце предплечья
    addPart(forearmBone, new THREE.BoxGeometry(0.095, 0.065, 0.075), matRustyFrame, 0, 0, FOREARM_LEN + 0.035);
    // Два верхних шарнирных пальца-клешни
    for (let f of [-0.028, 0.028]) {
      addPart(forearmBone, new THREE.BoxGeometry(0.026, 0.028, 0.085), matDesertArmor, f, 0.024, FOREARM_LEN + 0.09, 0.22, 0, 0);
      addPart(forearmBone, new THREE.BoxGeometry(0.022, 0.024, 0.055), matDarkFrame, f, 0.005, FOREARM_LEN + 0.14, 0.55, 0, 0);
    }
    // Нижний противопоставленный силовой палец-упор
    addPart(forearmBone, new THREE.BoxGeometry(0.042, 0.028, 0.085), matRustyFrame, 0, -0.028, FOREARM_LEN + 0.09, -0.28, 0, 0);

    return {
      sideSign,
      shoulderMount,
      upperArmBone,
      forearmBone,
      wristTarget: new THREE.Vector3(sideSign * 0.39, 0.88, 0.08)
    };
  }

  const leftLeg = createRobotLeg(-1);
  const rightLeg = createRobotLeg(1);
  const legs = [leftLeg, rightLeg];

  const leftArm = createRobotArm(-1);
  const rightArm = createRobotArm(1);
  const arms = [leftArm, rightArm];

  // ============================================================================
  // 7. АНАЛИТИЧЕСКИЙ 3D TWO-BONE IK СОЛВЕР (ДЛЯ НОГ И РУК)
  // ============================================================================
  const _vDir = new THREE.Vector3();
  const _vPole = new THREE.Vector3();
  const _vOrtho = new THREE.Vector3();
  const _vBendDir = new THREE.Vector3();
  const _vMid = new THREE.Vector3();
  const _vUp = new THREE.Vector3(0, 1, 0);
  const _vX = new THREE.Vector3();
  const _vY = new THREE.Vector3();
  const _vZ = new THREE.Vector3();
  const _vEffectiveTarget = new THREE.Vector3();
  const _vBlendedNormal = new THREE.Vector3();
  const _mBasis = new THREE.Matrix4();
  const _plateQuat = new THREE.Quaternion();
  const _yawQuat = new THREE.Quaternion();
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

  function solveTwoBoneIK(
    rootWorldPos: THREE.Vector3,
    targetWorldPos: THREE.Vector3,
    poleDirectionWorld: THREE.Vector3,
    len1: number,
    len2: number,
    bone1Group: THREE.Object3D,
    bone2Group: THREE.Object3D
  ): void {
    _vDir.subVectors(targetWorldPos, rootWorldPos);
    const rawDist = _vDir.length();
    const minDist = Math.abs(len1 - len2) + 0.02;
    const maxReach = (len1 + len2);

    // Мягкое кинематическое торможение (Soft IK) перед сингулярностью выпрямления ноги:
    // исключает жесткий удар колена о предел 180° ("коленный стук / knee pop")
    const softThreshold = 0.04;
    const d0 = maxReach - softThreshold;
    let clampedDist;
    if (rawDist > d0) {
      clampedDist = maxReach - softThreshold * Math.exp(-(rawDist - d0) / softThreshold);
    } else {
      clampedDist = Math.max(minDist, rawDist);
    }

    if (rawDist > 0.0001) {
      _vDir.divideScalar(rawDist);
    } else {
      _vDir.set(0, -1, 0);
    }

    const cosAngle1 = THREE.MathUtils.clamp(
      (len1 * len1 + clampedDist * clampedDist - len2 * len2) / (2 * len1 * clampedDist),
      -1.0,
      1.0
    );
    const sinAngle1 = Math.sqrt(Math.max(0.0, 1.0 - cosAngle1 * cosAngle1));

    _vPole.copy(poleDirectionWorld).normalize();
    _vOrtho.crossVectors(_vDir, _vPole);
    if (_vOrtho.lengthSq() < 0.0001) {
      _vOrtho.set(1, 0, 0);
    } else {
      _vOrtho.normalize();
    }
    _vBendDir.crossVectors(_vOrtho, _vDir).normalize();

    _vMid.copy(rootWorldPos)
      .addScaledVector(_vDir, len1 * cosAngle1)
      .addScaledVector(_vBendDir, len1 * sinAngle1);

    // Устойчивый ортонормированный базис без сингулярностей lookAt
    _vX.copy(_vOrtho).negate();

    // Кость 1: от root к mid
    _vZ.subVectors(_vMid, rootWorldPos).normalize();
    _vY.crossVectors(_vZ, _vX).normalize();
    _mBasis.makeBasis(_vX, _vY, _vZ);
    bone1Group.position.copy(rootWorldPos);
    bone1Group.quaternion.setFromRotationMatrix(_mBasis);

    // Эффективная цель для кости 2: если targetWorldPos дальше предельной длины (maxDist),
    // кость 2 заканчивается ровно в пределах длины конечности, исключая разрывы суставов
    _vEffectiveTarget.copy(rootWorldPos).addScaledVector(_vDir, clampedDist);

    // Кость 2: от mid к effectiveTarget
    _vZ.subVectors(_vEffectiveTarget, _vMid).normalize();
    _vY.crossVectors(_vZ, _vX).normalize();
    _mBasis.makeBasis(_vX, _vY, _vZ);
    bone2Group.position.copy(_vMid);
    bone2Group.quaternion.setFromRotationMatrix(_mBasis);
  }

  // ============================================================================
  // 8. ПУБЛИЧНЫЙ API РИГА РОБОТА (ДЛЯ ИНТЕГРАЦИИ ПОД СОБСТВЕННУЮ ИНПУТ-СИСТЕМУ)
  // ============================================================================
  const _hipWorldPos = new THREE.Vector3();
  const _shoulderWorldPos = new THREE.Vector3();
  const _forwardWorld = new THREE.Vector3();
  const _rightWorld = new THREE.Vector3();
  const _legPoleWorld = new THREE.Vector3();
  const _armPoleWorld = new THREE.Vector3();
  const _ankleWorldTarget = new THREE.Vector3();

  let smoothPelvisDrop = 0;

  // Переменные рэгдолл-инерции и плавного вторичного движения (Secondary Motion)
  let smoothBobY = 0;
  let smoothSwayX = 0;
  let smoothRollZ = 0;
  let smoothPitchX = 0;
  let smoothYawY = 0;

  let smoothTorsoPitch = 0;
  let smoothTorsoTwist = 0;
  let smoothTorsoRoll = 0;

  let smoothHeadPitch = 0;
  let smoothHeadYaw = 0;
  let smoothHeadRoll = 0;

  const _smoothLeftFootNormal = new THREE.Vector3(0, 1, 0);
  const _smoothRightFootNormal = new THREE.Vector3(0, 1, 0);

  const _smoothLeftHandPos = new THREE.Vector3();
  const _smoothRightHandPos = new THREE.Vector3();
  let handPositionsInitialized = false;

  const robotRig = {
    // Корневой контейнер всего рига
    group: rigRootGroup,

    // Константы геометрии костей для расчетов шага и досягаемости
    constants: {
      BASE_PELVIS_Y,
      THIGH_LEN,
      SHIN_LEN,
      FOOT_HEIGHT,
      UPPER_ARM_LEN,
      FOREARM_LEN
    },

    // Прямой доступ к узлам скелета
    joints: {
      suitRoot,
      pelvisGroup,
      torsoGroup,
      headGroup,
      backpackGroup,
      leftLeg,
      rightLeg,
      leftArm,
      rightArm
    },

    // Поза корпуса
    pose: {
      rootPosition: new THREE.Vector3(0, 0, 0),
      rootYaw: 0.0,
      pelvisOffset: new THREE.Vector3(0, 0, 0),
      pelvisRotation: new THREE.Euler(0, 0, 0),
      torsoRotation: new THREE.Euler(0, 0, 0),
      headRotation: new THREE.Euler(0, 0, 0)
    },

    locomotion: {
      phase: 0,
      amount: 0,
      moveX: 0,
      moveZ: 0,
      bankingRoll: 0,
      isSliding: false,
      slideSpeed: 0,
      isSprinting: false
    },

    setLocomotion({ phase = 0, amount = 0, moveX = 0, moveZ = 0, bankingRoll = 0, isSliding = false, slideSpeed = 0, isSprinting = false } = {}) {
      this.locomotion.phase = phase;
      this.locomotion.amount = THREE.MathUtils.clamp(amount, 0, 1);
      this.locomotion.moveX = moveX;
      this.locomotion.moveZ = moveZ;
      this.locomotion.bankingRoll = bankingRoll;
      this.locomotion.isSliding = Boolean(isSliding);
      this.locomotion.slideSpeed = slideSpeed || 0;
      this.locomotion.isSprinting = Boolean(isSprinting);
    },

    // Мировые IK-цели конечностей
    ikTargets: {
      leftFoot: {
        position: new THREE.Vector3(-0.19, 0.0, 0.0),
        pitch: 0.0,
        yawOffset: 0.0,
        roll: 0.0,
        contactWeight: 1.0,
        normal: null as THREE.Vector3 | null,
        surfaceType: undefined as string | undefined,
        groundY: 0
      },
      rightFoot: {
        position: new THREE.Vector3(0.19, 0.0, 0.0),
        pitch: 0.0,
        yawOffset: 0.0,
        roll: 0.0,
        contactWeight: 1.0,
        normal: null as THREE.Vector3 | null,
        surfaceType: undefined as string | undefined,
        groundY: 0
      },
      leftHand: {
        position: new THREE.Vector3(-0.39, 0.88, 0.08)
      },
      rightHand: {
        position: new THREE.Vector3(0.39, 0.88, 0.08)
      }
    },

    // Сброс всех IK-целей в базовую стойку относительно текущих rootPosition и rootYaw
    resetTargetsToStance() {
      const sinY = Math.sin(this.pose.rootYaw);
      const cosY = Math.cos(this.pose.rootYaw);
      _forwardWorld.set(sinY, 0, cosY);
      _rightWorld.set(cosY, 0, -sinY);

      this.ikTargets.leftFoot.position.copy(this.pose.rootPosition).addScaledVector(_rightWorld, -0.19);
      this.ikTargets.leftFoot.position.y = 0;
      this.ikTargets.leftFoot.pitch = 0;
      this.ikTargets.leftFoot.yawOffset = 0;
      this.ikTargets.leftFoot.roll = 0;
      this.ikTargets.leftFoot.contactWeight = 1.0;

      this.ikTargets.rightFoot.position.copy(this.pose.rootPosition).addScaledVector(_rightWorld, 0.19);
      this.ikTargets.rightFoot.position.y = 0;
      this.ikTargets.rightFoot.pitch = 0;
      this.ikTargets.rightFoot.yawOffset = 0;
      this.ikTargets.rightFoot.roll = 0;
      this.ikTargets.rightFoot.contactWeight = 1.0;

      this.ikTargets.leftHand.position.copy(this.pose.rootPosition)
        .addScaledVector(_rightWorld, -0.39)
        .addScaledVector(_forwardWorld, 0.08);
      this.ikTargets.leftHand.position.y = this.pose.rootPosition.y + 0.82 + this.pose.pelvisOffset.y;

      this.ikTargets.rightHand.position.copy(this.pose.rootPosition)
        .addScaledVector(_rightWorld, 0.39)
        .addScaledVector(_forwardWorld, 0.08);
      this.ikTargets.rightHand.position.y = this.pose.rootPosition.y + 0.82 + this.pose.pelvisOffset.y;
    },

    // Сброс темпоральных рэгдолл-сглаживателей при телепортации или респавне
    resetSmoothing() {
      smoothPelvisDrop = 0;
      smoothBobY = 0;
      smoothSwayX = 0;
      smoothRollZ = 0;
      smoothPitchX = 0;
      smoothYawY = 0;

      smoothTorsoPitch = 0;
      smoothTorsoTwist = 0;
      smoothTorsoRoll = 0;

      smoothHeadPitch = 0;
      smoothHeadYaw = 0;
      smoothHeadRoll = 0;

      _smoothLeftFootNormal.set(0, 1, 0);
      _smoothRightFootNormal.set(0, 1, 0);
      handPositionsInitialized = false;
    },

    // Вызывайте один раз за кадр после обновления pose и ikTargets
    update(groundAt: ((x: number, z: number) => number | { y: number; normal?: THREE.Vector3 | null; surfaceType?: string } | null) | null = null) {
      const sinYaw = Math.sin(this.pose.rootYaw);
      const cosYaw = Math.cos(this.pose.rootYaw);
      _forwardWorld.set(sinYaw, 0, cosYaw);
      _rightWorld.set(cosYaw, 0, -sinYaw);

      const amount = this.locomotion.amount;
      const phase = this.locomotion.phase;

      // Определение фактического вектора шага в мировых координатах
      let stepDirX = _forwardWorld.x;
      let stepDirZ = _forwardWorld.z;
      const moveLen = Math.hypot(this.locomotion.moveX, this.locomotion.moveZ);
      if (moveLen > 0.01) {
        stepDirX = (_forwardWorld.x * this.locomotion.moveZ + _rightWorld.x * this.locomotion.moveX) / moveLen;
        stepDirZ = (_forwardWorld.z * this.locomotion.moveZ + _rightWorld.z * this.locomotion.moveX) / moveLen;
      }

      const isSprinting = Boolean(this.locomotion.isSprinting);
      const stride = (isSprinting ? 0.35 : 0.28) * amount;
      const maxLift = (isSprinting ? 0.14 : 0.10) * amount;

      const isSliding = this.locomotion.isSliding;

      if (isSliding) {
        // === ПОЗА ПЕСЧАНОГО СЕРФИНГА ===
        // Стопы расставлены шире и разнесены в продольной стойке (разножка)
        // Правая нога вынесена вперед (+0.16м), левая чуть назад (-0.14м), обе прижаты к песку
        const slideStance = [
          { leg: leftLeg, target: this.ikTargets.leftFoot, offsetFwd: -0.14, lateral: -0.22, pitch: 0.08 },
          { leg: rightLeg, target: this.ikTargets.rightFoot, offsetFwd: 0.16, lateral: 0.22, pitch: 0.08 }
        ];

        for (let i = 0; i < slideStance.length; i++) {
          const item = slideStance[i];
          const neutralX = this.pose.rootPosition.x + _rightWorld.x * item.lateral + _forwardWorld.x * item.offsetFwd;
          const neutralZ = this.pose.rootPosition.z + _rightWorld.z * item.lateral + _forwardWorld.z * item.offsetFwd;

          item.target.position.x = neutralX;
          item.target.position.z = neutralZ;

          let groundY = this.pose.rootPosition.y;
          if (typeof groundAt === 'function') {
            const sample = groundAt(item.target.position.x, item.target.position.z);
            if (typeof sample === 'number') {
              groundY = sample;
              item.target.normal = null;
            } else if (sample && typeof sample.y === 'number') {
              groundY = sample.y;
              item.target.normal = sample.normal || null;
              if (sample.surfaceType) item.target.surfaceType = sample.surfaceType;
            } else {
              item.target.normal = null;
            }
          }
          item.target.groundY = groundY;
          item.target.position.y = groundY;
          item.target.pitch = item.pitch;
          item.target.contactWeight = 1.0;
        }
      } else {
        // 1. Двуногий цикл шага: опорная и маховая фазы ног
        const legPhases = [
          { leg: leftLeg, target: this.ikTargets.leftFoot, phi: phase % (Math.PI * 2), side: -1 },
          { leg: rightLeg, target: this.ikTargets.rightFoot, phi: (phase + Math.PI) % (Math.PI * 2), side: 1 }
        ];

        for (let i = 0; i < legPhases.length; i++) {
          const item = legPhases[i];
          let phi = item.phi;
          while (phi < 0) phi += Math.PI * 2;
          while (phi >= Math.PI * 2) phi -= Math.PI * 2;

          let u = 0;
          let lift = 0;
          let pitch = 0;
          let contactWeight = 1.0;

          if (amount > 0.001) {
            if (phi < Math.PI) {
              // Маховая фаза (Swing Phase): перенос стопы вперед
              const p = phi / Math.PI; // 0..1
              u = -Math.cos(p * Math.PI); // от -1 (сзади) до +1 (впереди)
              lift = Math.sin(p * Math.PI) * (1.0 + 0.22 * Math.cos(p * Math.PI)) * maxLift;
              contactWeight = Math.max(0, 1.0 - lift / 0.025);

              if (p < 0.22) {
                pitch = -0.22 * (1.0 - p / 0.22); // отрыв носка
              } else if (p < 0.72) {
                pitch = 0.14 * Math.sin(((p - 0.22) / 0.50) * Math.PI); // клиренс носка в воздухе
              } else {
                pitch = 0.18 * ((p - 0.72) / 0.28); // касание пяткой
              }
            } else {
              // Опорная фаза (Stance Phase): линейный накат тела поверх зафиксированной стопы
              const q = (phi - Math.PI) / Math.PI; // 0..1
              // Линейная зависимость скорости: устраняет проскальзывание (Foot Skating)
              u = 1.0 - 2.0 * q; // от +1 до -1 с постоянной относительной скоростью
              lift = 0;
              contactWeight = 1.0;

              if (q < 0.20) {
                pitch = 0.18 * (1.0 - q / 0.20); // опускание с пятки на подошву
              } else if (q < 0.75) {
                pitch = 0.0; // плотный контакт всей подошвой с песком
              } else {
                pitch = -0.22 * ((q - 0.75) / 0.25); // подъем пятки перед толчком
              }
            }
          }

          // Циркумдукция маховой ноги (небольшая дуга наружу для анатомической естественности)
          const swingArc = (phi < Math.PI && amount > 0.01) ? (Math.sin(phi) * item.side * 0.022) : 0;
          const neutralX = this.pose.rootPosition.x + _rightWorld.x * (item.side * 0.19 + swingArc);
          const neutralZ = this.pose.rootPosition.z + _rightWorld.z * (item.side * 0.19 + swingArc);

          item.target.position.x = neutralX + stepDirX * (u * stride);
          item.target.position.z = neutralZ + stepDirZ * (u * stride);

          // Точное сэмплирование рельефа песка в фактической точке шага
          let groundY = this.pose.rootPosition.y;
          if (typeof groundAt === 'function') {
            const sample = groundAt(item.target.position.x, item.target.position.z);
            if (typeof sample === 'number') {
              groundY = sample;
              item.target.normal = null;
            } else if (sample && typeof sample.y === 'number') {
              groundY = sample.y;
              item.target.normal = sample.normal || null;
              if (sample.surfaceType) item.target.surfaceType = sample.surfaceType;
            } else {
              item.target.normal = null;
            }
          }
          item.target.groundY = groundY;
          item.target.position.y = groundY + lift;

          item.target.pitch = pitch;
          item.target.contactWeight = contactWeight;
        }
      }

      // 2. Биомеханика таза и торса (покачивание, боковой перенос массы, наклон)
      const bobY = isSliding ? 0 : (-Math.cos(phase * 2.0) * 0.022 * amount);
      const swayX = isSliding ? 0 : (-Math.sin(phase) * 0.024 * amount);
      const rollZ = isSliding ? -0.05 : (Math.sin(phase) * 0.035 * amount);
      const pitchX = isSliding ? -0.12 : ((isSprinting ? 0.055 : 0.035) * amount);
      const yawY = isSliding ? 0.22 : (-Math.sin(phase) * 0.045 * amount);

      // Снижение центра массы таза при спринте (исключает перевыпрямление и щелчки коленных суставов)
      const runPelvisDrop = isSprinting ? (0.045 * amount) : 0;

      // Динамическая адаптация таза к уклону: рассчитывается по высоте рельефа под стопами (groundY),
      // полностью исключая скачки от махового подъема (lift) ноги в воздухе
      const leftGround = this.ikTargets.leftFoot.groundY ?? (this.ikTargets.leftFoot.position.y);
      const rightGround = this.ikTargets.rightFoot.groundY ?? (this.ikTargets.rightFoot.position.y);
      const minTerrainY = Math.min(leftGround, rightGround);
      const rootY = this.pose.rootPosition.y;
      const targetPelvisDrop = Math.min(0, (minTerrainY - rootY) * 0.5);
      smoothPelvisDrop += (targetPelvisDrop - smoothPelvisDrop) * 0.16;

      suitRoot.position.copy(this.pose.rootPosition);
      suitRoot.rotation.y = this.pose.rootYaw;

      const bankRoll = this.locomotion.bankingRoll || 0;

      pelvisGroup.position.set(
        this.pose.pelvisOffset.x + swayX,
        BASE_PELVIS_Y + this.pose.pelvisOffset.y + bobY + smoothPelvisDrop - runPelvisDrop,
        this.pose.pelvisOffset.z
      );
      pelvisGroup.rotation.set(
        this.pose.pelvisRotation.x + pitchX,
        this.pose.pelvisRotation.y + yawY,
        this.pose.pelvisRotation.z + rollZ + bankRoll
      );

      // Противоповорот торса (counter-rotation для компенсации вращательного импульса) + наклон в вираж
      const torsoTwistYaw = isSliding ? -0.18 : (Math.sin(phase) * 0.065 * amount);
      const torsoLeanPitch = isSliding ? -0.06 : ((isSprinting ? 0.08 : 0.035) * amount);
      const torsoCounterRoll = isSliding ? 0.04 : (-Math.sin(phase) * 0.02 * amount);

      torsoGroup.rotation.set(
        this.pose.torsoRotation.x + torsoLeanPitch,
        this.pose.torsoRotation.y + torsoTwistYaw,
        this.pose.torsoRotation.z + torsoCounterRoll + bankRoll * 1.2
      );

      // Стабилизация сенсорной головы (удерживает горизонт камеры)
      headGroup.rotation.set(
        this.pose.headRotation.x - torsoLeanPitch * 0.7,
        this.pose.headRotation.y - torsoTwistYaw * 0.75,
        this.pose.headRotation.z - torsoCounterRoll * 0.75
      );

      suitRoot.updateMatrixWorld(true);

      // 3. Синхронизация движения рук (рэгдолл-маятник с фазовым запаздыванием и сгибанием локтей)
      if (isSliding) {
        // Серф-поза рук: широко разведены в стороны для аэродинамического баланса
        const targetLX = this.pose.rootPosition.x - _rightWorld.x * 0.52 - _forwardWorld.x * 0.12;
        const targetLZ = this.pose.rootPosition.z - _rightWorld.z * 0.52 - _forwardWorld.z * 0.12;
        const targetLY = this.pose.rootPosition.y + 0.88 + this.pose.pelvisOffset.y;

        const targetRX = this.pose.rootPosition.x + _rightWorld.x * 0.48 + _forwardWorld.x * 0.20;
        const targetRZ = this.pose.rootPosition.z + _rightWorld.z * 0.48 + _forwardWorld.z * 0.20;
        const targetRY = this.pose.rootPosition.y + 0.94 + this.pose.pelvisOffset.y;

        if (!handPositionsInitialized) {
          _smoothLeftHandPos.set(targetLX, targetLY, targetLZ);
          _smoothRightHandPos.set(targetRX, targetRY, targetRZ);
          handPositionsInitialized = true;
        } else {
          _smoothLeftHandPos.x += (targetLX - _smoothLeftHandPos.x) * 0.25;
          _smoothLeftHandPos.y += (targetLY - _smoothLeftHandPos.y) * 0.25;
          _smoothLeftHandPos.z += (targetLZ - _smoothLeftHandPos.z) * 0.25;
          _smoothRightHandPos.x += (targetRX - _smoothRightHandPos.x) * 0.25;
          _smoothRightHandPos.y += (targetRY - _smoothRightHandPos.y) * 0.25;
          _smoothRightHandPos.z += (targetRZ - _smoothRightHandPos.z) * 0.25;
        }

        this.ikTargets.leftHand.position.copy(_smoothLeftHandPos);
        this.ikTargets.rightHand.position.copy(_smoothRightHandPos);
      } else {
        const armMultiplier = isSprinting ? 1.35 : 1.0;
        const armPhase = phase - 0.25; // Фазовый лаг маятника рук относительно шага
        const armSwing = Math.sin(armPhase) * 0.22 * amount * armMultiplier;
        const armLift = Math.abs(Math.sin(armPhase)) * 0.035 * amount * armMultiplier;

        for (let s of [-1, 1]) {
          const hand = s < 0 ? this.ikTargets.leftHand : this.ikTargets.rightHand;
          const smoothHand = s < 0 ? _smoothLeftHandPos : _smoothRightHandPos;
          const armSign = -s;
          const neutralHandX = this.pose.rootPosition.x + _rightWorld.x * (s * 0.39) + _forwardWorld.x * 0.08;
          const neutralHandZ = this.pose.rootPosition.z + _rightWorld.z * (s * 0.39) + _forwardWorld.z * 0.08;
          const neutralHandY = this.pose.rootPosition.y + 0.82 + this.pose.pelvisOffset.y;

          const forwardOffset = armSign * armSwing;
          const targetX = neutralHandX + stepDirX * forwardOffset;
          const targetZ = neutralHandZ + stepDirZ * forwardOffset;
          // На махе вперед локоть и кисть сгибаются вверх и вперед естественным образом (атлетичный спринт)
          const flexUp = Math.max(0, forwardOffset) * (isSprinting ? 0.22 : 0.14);
          const targetY = neutralHandY + armLift + flexUp;

          if (!handPositionsInitialized) {
            smoothHand.set(targetX, targetY, targetZ);
          } else {
            smoothHand.x += (targetX - smoothHand.x) * 0.28;
            smoothHand.y += (targetY - smoothHand.y) * 0.28;
            smoothHand.z += (targetZ - smoothHand.z) * 0.28;
          }

          hand.position.copy(smoothHand);
        }
        handPositionsInitialized = true;
      }

      // 4. Решаем Two-Bone 3D IK для обеих ног (со сглаживанием нормали опоры стоп)
      const footConfigs = [
        { leg: leftLeg, target: this.ikTargets.leftFoot, smoothNormal: _smoothLeftFootNormal },
        { leg: rightLeg, target: this.ikTargets.rightFoot, smoothNormal: _smoothRightFootNormal }
      ];

      for (let i = 0; i < footConfigs.length; i++) {
        const { leg, target, smoothNormal } = footConfigs[i];

        leg.footGroup.position.copy(target.position);
        if (target.normal) {
          smoothNormal.lerp(target.normal, 0.22).normalize();
          const cw = target.contactWeight !== undefined ? target.contactWeight : 1.0;
          _plateQuat.setFromUnitVectors(_vUp, _vBlendedNormal.copy(_vUp).lerp(smoothNormal, cw).normalize());
          _euler.set(target.pitch || 0, this.pose.rootYaw + (target.yawOffset || 0), target.roll || 0, 'YXZ');
          _yawQuat.setFromEuler(_euler);
          leg.footGroup.quaternion.copy(_plateQuat).multiply(_yawQuat);
        } else {
          smoothNormal.lerp(_vUp, 0.22).normalize();
          leg.footGroup.rotation.set(
            target.pitch || 0,
            this.pose.rootYaw + (target.yawOffset || 0),
            target.roll || 0
          );
        }

        _ankleWorldTarget.copy(target.position);
        if (target.normal) {
          _ankleWorldTarget.addScaledVector(smoothNormal, FOOT_HEIGHT);
        } else {
          _ankleWorldTarget.y += FOOT_HEIGHT;
        }
        leg.ankleTarget.copy(_ankleWorldTarget);

        leg.hipMount.getWorldPosition(_hipWorldPos);

        // Направление коленного сустава (вперед и наружу)
        _legPoleWorld.copy(_forwardWorld)
          .multiplyScalar(1.0)
          .addScaledVector(_rightWorld, leg.sideSign * 0.16)
          .normalize();

        solveTwoBoneIK(
          _hipWorldPos,
          _ankleWorldTarget,
          _legPoleWorld,
          THIGH_LEN,
          SHIN_LEN,
          leg.thighBone,
          leg.shinBone
        );
      }

      // 5. Решаем Two-Bone 3D IK для обеих рук
      const handConfigs = [
        { arm: leftArm, target: this.ikTargets.leftHand },
        { arm: rightArm, target: this.ikTargets.rightHand }
      ];

      for (let i = 0; i < handConfigs.length; i++) {
        const { arm, target } = handConfigs[i];
        arm.shoulderMount.getWorldPosition(_shoulderWorldPos);
        arm.wristTarget.copy(target.position);

        _armPoleWorld.copy(_forwardWorld)
          .multiplyScalar(-0.85)
          .addScaledVector(_rightWorld, arm.sideSign * 0.65)
          .normalize();

        solveTwoBoneIK(
          _shoulderWorldPos,
          target.position,
          _armPoleWorld,
          UPPER_ARM_LEN,
          FOREARM_LEN,
          arm.upperArmBone,
          arm.forearmBone
        );
      }

      // 6. Обновляем мировые матрицы костей и гидроцилиндры
      leftLeg.thighBone.updateMatrixWorld(true);
      leftLeg.shinBone.updateMatrixWorld(true);
      leftLeg.footGroup.updateMatrixWorld(true);
      rightLeg.thighBone.updateMatrixWorld(true);
      rightLeg.shinBone.updateMatrixWorld(true);
      rightLeg.footGroup.updateMatrixWorld(true);
      leftArm.upperArmBone.updateMatrixWorld(true);
      leftArm.forearmBone.updateMatrixWorld(true);
      rightArm.upperArmBone.updateMatrixWorld(true);
      rightArm.forearmBone.updateMatrixWorld(true);

      updateAllHydraulicPistons();
    },

    dispose() {
      if (rigRootGroup.parent) {
        rigRootGroup.parent.remove(rigRootGroup);
      }
      rigRootGroup.traverse((obj: THREE.Object3D) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
          else mesh.material.dispose();
        }
      });
      [desertArmorTex, hazardStripeTex, servoDrumTex, rustyFrameTex, chromeRodTex, rubberHoseTex, amberOpticTex, desertShroudTex].forEach(t => t.dispose());
    }
  };
    robotRig.resetTargetsToStance();
    robotRig.update();
    robotRig.group.scale.setScalar(scale);
    return robotRig;
}

export type PlayerModel = ReturnType<typeof createPlayerModel>;


