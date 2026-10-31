# Архитектура PS1 Desert Mech Diorama

Документ описывает фактическое состояние проекта на 30.10.2026. Проект представляет собой браузерную low-poly/PS1 диораму пустыни: бесконечно потоковый рельеф, шестиногий мех, двуногий робот Cosmo, динамическая погода и песок с сохранением массы. Боевых сущностей нет.

## 1. Технологическая база

| Область | Реализация |
|---|---|
| Сборка и запуск | Vite 5, TypeScript 5, ES modules, `index.html -> src/main.ts` |
| Рендеринг | Three.ts 0.160, процедурные меши и canvas-текстуры |
| Физика | Rapier 3D compat 0.12, WASM, единый мир |
| Тесты | `node --test`, 251 тест (`npm test`) |
| Типизация | TypeScript strict (`strict: true`, `noImplicitAny: true`, `npm run typecheck`) |
| Ассеты | Внешние ассеты не требуются; модели, материалы и текстуры создаются кодом |
| Визуальный стиль | `antialias:false`, низкое внутреннее разрешение, vertex snap, ограниченная палитра, fog, BasicShadowMap |

Команды: `npm install`, `npm run dev`, `npm run typecheck`, `npm test`, `npm run build`, `npm run preview`.

`npm test` и `npm run build` проходят. Сборка выдаёт только предупреждение о размере JS-бандла (~2.69 MB до gzip).

## 2. Границы системы

```text
index.html -> src/main.ts -> createDioramaApp()
                              ├─ simulation: Rapier, actors, sand
                              ├─ environment: chunks, weather, day/night
                              ├─ presentation: camera, lighting, sky, PS1, HUD
                              └─ lifecycle: start(), dispose(), diagnostics
```

`src/app.ts` — единственный композиционный корень. Модули получают зависимости через аргументы фабрик и не используют глобальные игровые синглтоны. Единственная точка импорта Rapier — `src/world/physics.ts`: она выполняет `RAPIER.init()`, создаёт `World` и задаёт фиксированный timestep.

## 3. Слои и зависимости

```text
L4  main.ts
L3  app.ts                         композиция и главный цикл
L2  actor/, control/, input/, mech/, character/, ui/, world/* directors
L1  world/physics, terrain, groundSampler, chunkWorld, sandField
L0  config.ts, core/*, render primitives, IK/math helpers
```

Правила:

1. `config.ts`, `core/*` и вычислительные части `mech/*` не владеют DOM.
2. `world/chunkWorld.ts` владеет жизненным циклом чанков, мешей, heightfield-коллайдеров и props.
3. `actor/*` адаптирует конкретную сущность к общему контракту и не маршрутизирует физику другого актёра.
4. Рендер читает состояние симуляции, но не меняет его.
5. Песчаное поле является источником высоты, плотности и контакта; mesh и Rapier heightfield синхронизируются из одного состояния.

## 4. Структура исходников

### Composition и shared services

- `src/main.ts` — асинхронный вход и запуск.
- `src/app.ts` — создание сцены, фабрик, fixed-step loop, resize/dispose и diagnostics.
- `src/config.ts` — параметры мира, физики, меха, Cosmo, камеры, погоды и песка.
- `src/world/physics.ts` — Rapier WASM gateway.
- `src/types/index.ts` — строгие контракты, базовые интерфейсы и типы актеров/мира.

### Core

- `core/noise.ts`, `duneField.ts` — детерминированный рельеф, нормали и маски гор.
- `core/chunkCoords.ts` — преобразование мировых координат в координаты чанков.
- `core/windField.ts` — аналитическое поле ветра.
- `core/rng.ts` — seeded Mulberry32 для воспроизводимых эффектов.
- `core/textures.ts` — процедурные текстуры.

### World и sand

- `world/chunkWorld.ts` — загрузка/выгрузка сетки чанков и передача weather/sand updates.
- `world/terrain.ts` — меш чанка, skirt/frame и Rapier heightfield.
- `world/groundSampler.ts` — единый probe поверхности: песок, камень, нормаль и material metadata.
- `world/sandField.ts` — L1 CPU-поле: height delta, packing, sink, shear, traction, crater/sole, wind transport и reserve.
- `world/sandDeformation.ts` — применение L1 к вершинам/цветам и синхронизация heightfield.
- `world/sandGranules.ts` — L2 локальные гранулы: выброс, полёт, оседание и возврат массы.
- `world/terramechanics.ts` — Bekker sinkage, Janosi-Hanamoto shear, Terzaghi bearing и bulldozing drag.
- `world/props.ts` — детерминированные rocks/debris и динамика обломков.
- `world/weather.ts`, `sandStorm.ts`, `dustParticles.ts`, `dayCycle.ts` — ветер, буря, пыль и сутки.

### Mech

- `mech/mechRig.ts` — Rapier dynamic chassis, шесть kinematic foot bodies и visual sync.
- `mech/hexapodModel.ts`, `hexapodMaterials.ts` — procedural PS1-модель.
- `mech/hexapodIK.ts` — аналитический IK coxa/femur/tibia.
- `mech/gait.ts` — tripod gait, swing arc, touchdown, jet jump и sand effects.
- `mech/legSupport.ts`, `contactModel.ts`, `legContacts.ts` — опоры, нормальные нагрузки, friction ellipse и chassis wrench.
- `mech/locomotion.ts` — drive/turn, slope hold, attitude recovery, jump/landing.

### Cosmo

- `character/playerRig.ts` — Rapier `kinematicPositionBased` body, capsule collider и Kinematic Character Controller.
- `character/playerController.ts` — camera-relative movement, gravity, autostep/snap-to-ground, sprint, crouch, sliding, jump и interpolation.
- `character/playerModel.ts`, `playerActor.ts` — procedural biped IK/animation, footprints, dust и granules.

### Actors, input и presentation

- `actor/actorRegistry.ts` — регистрация, активация и lifecycle actors; `V` переключает активного актёра.
- `actor/mechActor.ts` — adapter меха.
- `control/mechDirector.ts` — manual/autopilot arbitration и семипольная `MechCommand`.
- `control/cameraDirector.ts` — pointer lock/drag look, zoom, actor-specific follow и ground clearance.
- `input/deviceState.ts` — физические клавиши/мышь, click tolerance и blur reset.
- `input/inputRouter.ts`, `bindings.ts` — логические действия и контексты `global/mech/cosmo`.
- `input/picking.ts` — screen-to-world raycast.
- `render/*` — PS1 pipeline, lighting и sky.
- `ui/hud.ts` — hints, clock и debug telemetry.

## 5. Контракт актёра

```js
{
  id, contextId, hintsKey, cameraConfig,
  controller,
  getPose(), simulateStep(dt, command, weatherState),
  syncVisuals(alpha), updateWorld(context), getDebug(),
  onActivate(), onDeactivate(), dispose()
}
```

Активация меняет input context и настройки камеры. Неактивный мех переводится в fixed body, чтобы физическая сцена не продолжала разрушать его позу. Физический мир продолжает шагать только через `activeActor.simulateStep`, поэтому переключение актёра является режимом управления, а не двумя независимыми simulation loops.

## 6. Главный цикл кадра

`app.ts` выполняет фазы в следующем порядке:

1. `day.update(frameDt)` — время суток и palette keyframes.
2. `weather.update(frameDt, bodyPos, dayState)` — ветер, gusts, fog, clouds и storm.
3. `activeActor.controller.update(...)` — command из input snapshot и camera azimuth.
4. `advancePhysicsAccumulator()` — перенос времени в fixed-step accumulator.
5. Для каждого подшага `activeActor.simulateStep(1/60, command, weatherState)`; мех выполняет plan → gait → support/contact solve → sand → `world.step()`, Cosmo выполняет KCC movement и `world.step()`.
6. `syncVisuals(alpha)` у всех actors; `alpha = accumulator / fixedDt`.
7. `chunks.update(...)` — streaming и песок ровно на реально симулированное время.
8. Actor-specific world effects, dust и sandstorm.
9. Camera follow/clearance, lighting, sky, HUD, PS1 postprocess и render.
10. `dispose()` удаляет listeners, actors, chunks, Rapier bodies, renderer и WASM world.

Параметры времени: `fixedDt = 1/60`, максимум 3 подшага на кадр, `maxFrameDt = 3/60`. При перегрузке отбрасываются только целые просроченные подшаги, дробный остаток сохраняется; counters доступны через `getPhysicsTiming()`.

## 7. Физическая модель

### Мех

Мех — dynamic rigid body Rapier. Шесть foot bodies являются kinematic probes, а итоговые силы считаются виртуально. `computeFootSupport()` строит support plane/polygon по подтверждённым planted feet, `solveNormalLoads()` распределяет нагрузку относительно мирового CoM, `legContacts.solve()` применяет spring/damper, slope-aware friction ellipse и drive traction, а `locomotion` добавляет тягу, yaw torque, wind drift, recovery и jet impulse. `gait.applySand()` передаёт фактическое давление и сдвиг в `sandField`.

Состояние корпуса после gait/jump/stomp перечитывается до финального contact solve, поэтому импульсы текущего подшага участвуют в нагрузках этого же подшага.

### Cosmo

Cosmo использует Rapier KCC, а не dynamic rigid-body controller: capsule на `kinematicPositionBased` body, slide, max slope, snap-to-ground, optional autostep и `setApplyImpulsesToDynamicBodies(true)` для debris. Headless fallback в `playerController.ts` используется тестами без Rapier world. Ноги и корпус визуально решаются procedural IK, footprint — oriented sole operation.

## 8. Поток песка и сохранение массы

- **L0** — аналитический base terrain (`duneField`), не хранит локальные изменения.
- **L1** — sparse per-chunk field с height delta, packing и локальными операциями.
- **L2** — ограниченный радиус гранул вокруг активного актёра.
- **reserve** — масса, временно не представленная активными ячейками/гранулами.

Контакты, отпечатки, ветровой перенос и осыпь изменяют L1. L2 при оседании возвращает массу в L1; исчезновение гранулы переводит массу в reserve. При пересечении границ чанков и LRU-detach состояние переносится через записи поля/evicted store. `chunkWorld.syncSandAt()` немедленно перестраивает затронутый Rapier heightfield, поэтому стопа видит свежую просадку до следующего визуального flush.

## 9. Input и камера

Глобальные действия: `1..4` — weather presets, `R` — weather cycle, `T` — time scale, `V` — actor switch.

Mech: `WASD/arrows`, `Space` stomp, `Shift` jump. Cosmo: camera-relative `WASD/arrows`, `Q/Ctrl` crouch, `E` stand, `Space` jump, `Shift` sprint/run. Клик и drag разделены `deviceState.clickTolerancePx`; камера управляется `cameraDirector` через Pointer Lock или drag. Ray picking остаётся отдельным сервисом.

## 10. Детерминизм и диагностика

Weather, props и L2 используют seeded RNG. Воспроизводимая сцена: `?weather=sandstorm&time=0.62&timeScale=0&clouds=0.6&seed=1337&debug`.

`app.getDiagnostics()` возвращает объём L1+L2, reserve, sand/granule stats, contact debug и physics timing. `?debug` выводит эти данные в HUD.

## 11. Проверка

- `npm test`: 251 passed, 0 failed.
- `npm run build`: успешно, 54 modules transformed.
- Тесты покрывают actor registry, input router/device state, camera director, меховый contact/gait/locomotion, Cosmo KCC/controller/model, chunk/heightfield sync, sand mass balance, streaming, determinism и lifecycle dispose.

## 12. Ограничения и следующие риски

1. Бандл после minification крупный; при росте контента стоит вынести Rapier/Three.ts или debug-only код в manual chunks.
2. Дальняя песчаная динамика остаётся CPU-бюджетной моделью; полный rigid-body simulation всех гранул не соответствует текущей архитектуре.
3. Дальний рельеф аналитический, а локальная деформация существует только в загруженных/сохранённых записях чанков.
4. Camera, HUD и браузерный input требуют ручного browser playtest; headless tests не подтверждают Pointer Lock, resize и визуальное качество PS1 pipeline.
5. Каждый новый actor должен определить `simulateStep`, `syncVisuals`, `cameraConfig`, input context и lifecycle semantics.

При расширении сначала обновляются контракты и fixed-step data flow, затем конкретный actor/world subsystem. Изменение mesh без обновления `groundSampler` и heightfield создаёт рассинхрон визуала и физики.

