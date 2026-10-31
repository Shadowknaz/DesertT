// Походка шестиногого шагохода: трипод «три ноги шагают — три стоят».
// Модуль решает, когда триподу переступать, ведет дугу переноса, обновляет
// кинематические тела стоп и решает 3D-IK всех шести ног.
//
// Нагрузку стоящих лап назначает силовой контакт, поэтому здесь только флаги
// опоры и давление в песок: просадка и уплотнение считаются по той же силе,
// которая держит корпус. Боксование лапы превращается в борозду и сдвиг поля.
import * as THREE from 'three';
import { GAIT, MECH, SANDFIELD, SAND } from '../config.ts';
import { solveHexapodLeg } from './hexapodIK.ts';
import { evaluateContact } from './contactModel.ts';
import { copyGroundSample, type GroundSampler } from '../world/groundSampler.ts';
import type { SandField } from '../world/sandField.ts';
import type { DustSystem } from '../world/dustParticles.ts';
import type { SandGranules } from '../world/sandGranules.ts';
import type { HexapodLeg } from './hexapodModel.ts';

const upAxis = new THREE.Vector3(0, 1, 0);

export interface GaitOptions {
    legs: HexapodLeg[];
    sampler: GroundSampler;
    dust: DustSystem;
    sandField: SandField;
    granules?: SandGranules | null;
    syncBody?: ((motion: any) => void) | null;
    syncSand?: ((x: number, z: number, radius: number) => void) | null;
}

export interface GaitStepResult {
    finishedStep: boolean;
    stomped: boolean;
    landed: boolean;
}

export interface GaitController {
    update(dt: number, motion: any): GaitStepResult;
    applySand(dt: number, motion: any): void;
}

export function createGaitController({
    legs, sampler, dust, sandField, granules = null, syncBody = null, syncSand = null
}: GaitOptions): GaitController {
    let activeGaitGroup = 0;
    let gaitCooldown = 0.0;
    let stompCooldown = 0.0;
    let wasAirborne = false;
    let impactChangedGround = false;

    // Черновики, чтобы горячий цикл не создавал мусор
    const scratchLocal = new THREE.Vector3();
    const scratchWorld = new THREE.Vector3();
    const scratchTurnLead = new THREE.Quaternion();
    const group0Legs = legs.filter(leg => leg.gaitGroup === 0);
    const group1Legs = legs.filter(leg => leg.gaitGroup === 1);
    const _soleOptions = {
        useSoleShape: true,
        terramechanics: true,
        width: 0.82,
        length: 0.82,
        heading: 0,
        pitch: 0,
        roll: 0
    };
    const _footholdResult = { x: 0, y: 0, z: 0 };
    const _footKinTranslation = { x: 0, y: 0, z: 0 };

    // Точка поджатой лапы в системе корпуса: колено согнуто, стопа под брюхом
    const tuckLocals = legs.map(leg => leg.hipLocal.clone().lerp(leg.restLocal, 0.55));

    // Удар по песку: воронка в поле и клуб пыли над ней — всегда парой.
    // Отпечаток сразу уходит и в физический heightfield (syncSand):
    // коллайдер не должен ждать бюджета перестройки мешей.
    function syncSandAt(x: number, z: number, radius: number): void {
        if (syncSand) syncSand(x, z, radius);
        impactChangedGround = true;
    }

    // Gait owns achieved motion; force saturation and modeled yield are not
    // evidence of sliding. The groove flag makes sand consumption one-shot.
    function clearAnchorMotion(leg: HexapodLeg, discardPending = true): void {
        (leg.anchorDisplacement ||= new THREE.Vector3()).set(0, 0, 0);
        (leg.slipVelocity ||= new THREE.Vector3()).set(0, 0, 0);
        leg.slip = 0;
        leg.groovePending = false;
        if (discardPending) {
            leg.pendingAnchorShift = null;
            if (leg.yieldVelocity) leg.yieldVelocity.x = leg.yieldVelocity.y = leg.yieldVelocity.z = 0;
        }
    }
    for (const leg of legs) clearAnchorMotion(leg);

    // Every retained surface is an owned, complete snapshot, including normal.
    // Refresh material before the force solve and again around field mutations.
    function sampleContact(leg: HexapodLeg, x = leg.currentFootPos.x, z = leg.currentFootPos.z): any {
        const surface = sampler.sample(x, z);
        const previous = leg.groundContact;
        if (!previous || previous.surfaceType !== surface.surfaceType
            || previous.colliderHandle !== surface.colliderHandle) {
            leg.sinkRate = 0;
            clearAnchorMotion(leg);
        }
        leg.groundContact = copyGroundSample(surface, previous || undefined);
        leg.packing = surface.packing;
        leg.sink = surface.sink;
        leg.traction = surface.friction * (leg.normalLoad || 0);
        if (surface.surfaceType === 'solid') {
            leg.sinkRate = 0;
            clearAnchorMotion(leg);
        }
        return leg.groundContact;
    }

    const anchorStart = new THREE.Vector3();
    const anchorProbe: any = { currentFootPos: new THREE.Vector3(), groundGap: 0, contactBlend: 1 };

    function applyPendingAnchor(leg: HexapodLeg, dt: number, motion: any): void {
        const pending = leg.pendingAnchorShift;
        leg.pendingAnchorShift = null; // Consume even a rejected/clipped request.
        if (!pending || !(dt > 0) || !Number.isFinite(dt)
            || !leg.isPlanted || leg.isStepping) return;
        const surface = leg.groundContact;
        if (surface?.surfaceType !== 'sand' || pending.surface.surfaceType !== 'sand'
            || surface.colliderHandle !== pending.surface.colliderHandle
            || !(leg.normalLoad > SANDFIELD.loadEpsilon)
            || !(leg.groundGap !== undefined && leg.groundGap <= MECH.contactGapFull)) return;
        const length = Math.hypot(pending.x, pending.y, pending.z);
        if (!Number.isFinite(length) || !(length > GAIT.anchorPositionEpsilon)
            || !(Math.hypot(pending.x, pending.z) > GAIT.anchorPositionEpsilon)) return;
        if (!(evaluateContact(leg, motion.bodyPos, motion.bodyQuat).weight > 0)) return;
        anchorStart.copy(leg.currentFootPos);
        anchorProbe.hipLocal = leg.hipLocal;

        // Trace short segments and stop at the FIRST material, height or reach
        // boundary. Sand yielding cannot pull a foot through/onto a rock.
        // Shared reach geometry avoids a second, inconsistent IK model.
        const accepts = (fraction: number): boolean => {
            const x = anchorStart.x + pending.x * fraction;
            const z = anchorStart.z + pending.z * fraction;
            const hit = sampler.sample(x, z);
            if (hit.surfaceType !== 'sand' || !Number.isFinite(hit.y)
                || Math.abs(hit.y - (anchorStart.y + pending.y * fraction)) > MECH.contactGapFull
                || Math.hypot(x - anchorStart.x, hit.y - anchorStart.y, z - anchorStart.z)
                    > length + GAIT.anchorPositionEpsilon) return false;
            anchorProbe.currentFootPos.set(x, hit.y, z);
            return evaluateContact(anchorProbe, motion.bodyPos, motion.bodyQuat).reachFactor >= 1;
        };
        let fraction = 0;
        const segments = Math.max(1, Math.ceil(length / GAIT.anchorPathStep));
        for (let i = 1; i <= segments; i++) {
            const next = i / segments;
            if (accepts(next)) {
                fraction = next;
                continue;
            }
            let upper = next;
            for (let j = 0; j < GAIT.anchorClipIterations; j++) {
                const middle = (fraction + upper) * 0.5;
                if (accepts(middle)) fraction = middle;
                else upper = middle;
            }
            break;
        }
        if (!(fraction * Math.hypot(pending.x, pending.z) > GAIT.anchorPositionEpsilon)) return;
        const accepted = sampleContact(leg, anchorStart.x + pending.x * fraction,
            anchorStart.z + pending.z * fraction);
        leg.currentFootPos.set(anchorStart.x + pending.x * fraction, accepted.y,
            anchorStart.z + pending.z * fraction);
        leg.groundNormal.copy(accepted.normal);
        leg.groundGap = 0;
        leg.anchorDisplacement.copy(leg.currentFootPos).sub(anchorStart);
        leg.slipVelocity.copy(leg.anchorDisplacement).divideScalar(dt);
        leg.slip = leg.slipVelocity.length();
        leg.groovePending = true;
    }

    function isSandAt(x: number, z: number): boolean {
        return sampler.sample(x, z).surfaceType === 'sand';
    }

    function sandDust(position: THREE.Vector3, count: number, intensity: number): void {
        if (isSandAt(position.x, position.z)) {
            dust.spawnSplash(position, count, intensity);
        }
    }

    function sandImpact(position: THREE.Vector3, radius: number, depth: number, dustCount: number, dustIntensity: number): void {
        if (!isSandAt(position.x, position.z)) return;
        sandField.stampCrater(position.x, position.z, radius, depth, 0.14);
        syncSandAt(position.x, position.z, radius * 1.3);
        dust.spawnSplash(position, dustCount, dustIntensity);
        if (granules) granules.spawnThrusterBurst(position, Math.min(32, dustCount * 2), dustIntensity);
    }

    function landFoot(leg: HexapodLeg, impactSpeed: number, load: number, dustCount: number, dustIntensity: number, motion: any = null): void {
        if (leg.groundContact?.surfaceType !== 'sand') return;
        const ny = Math.max(0.2, leg.groundNormal?.y || 1.0);
        const nx = leg.groundNormal?.x || 0;
        const nz = leg.groundNormal?.z || 0;
        const yaw = motion?.currentYaw || 0;
        const sinY = Math.sin(yaw);
        const cosY = Math.cos(yaw);
        const pitch = Math.atan2(-(nx * sinY + nz * cosY), ny);
        const roll = Math.atan2(nx * cosY - nz * sinY, ny);

        _soleOptions.width = leg.footWidth || 0.82;
        _soleOptions.length = leg.footLength || 0.82;
        _soleOptions.heading = yaw;
        _soleOptions.pitch = pitch;
        _soleOptions.roll = roll;
        sandField.land(leg.currentFootPos.x, leg.currentFootPos.z,
            SAND.stepFootprintRadius, impactSpeed, load, _soleOptions);
        syncSandAt(leg.currentFootPos.x, leg.currentFootPos.z, SAND.stepFootprintRadius * 1.3);
        dust.spawnSplash(leg.currentFootPos, dustCount, dustIntensity);
        if (granules) granules.spawnFootEjection(leg.currentFootPos, leg.slipVelocity, 12, 0.95);
    }

    // Опорные лапы держат корпус, качающиеся — нет. Вес им больше не
    // назначается: нормальную силу считает силовой контакт, а здесь только
    // флаги, чтобы давление в песок совпадало с реальной нагрузкой.
    // Зазор до песка ведется для силового слоя: стоящая лапа, повисшая
    // над поверхностью, опорой не считается.
    function updatePlantFlags(): void {
        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i];
            if (leg.isStepping) {
                leg.isPlanted = false;
                leg.groundGap = Infinity;
                leg.contactBlend = 0.0;
                leg.normalLoad = 0.0;
                leg.traction = 0.0;
                leg.sink = 0.0;
                continue;
            }
            leg.isPlanted = true;
        }
    }

    // Суммарная нагрузка трипода: по ней выбирается, какими лапами
    // переступать, когда опора уходит из-под корпуса.
    function groupLoad(group: number): number {
        let sum = 0.0;
        for (let i = 0; i < legs.length; i++) {
            if (legs[i].gaitGroup === group) sum += legs[i].normalLoad || 0.0;
        }
        return sum;
    }

    // Контакт лапы с грунтом: давление просаживает песок, уплотняет его
    // и возвращает локомотиву предельную тягу. Всё вытесненное остаётся
    // в поле валиком, поэтому след и опора не расходятся.
    function updateFootContacts(dt: number, motion: any): void {
        for (const leg of legs) {
            if (motion.airborne || !leg.isPlanted || leg.isStepping) {
                clearAnchorMotion(leg);
                leg.sink = 0;
                leg.sinkRate = 0;
                leg.traction = 0;
                continue;
            }
            if (sampleContact(leg).surfaceType !== 'sand') continue;
            // The exact achieved vector is consumed once, independently of the
            // new force request. Body velocity and saturation cannot make a groove.
            const displacement = leg.groovePending ? leg.anchorDisplacement : null;
            leg.groovePending = false;

            const ny = Math.max(0.2, leg.groundNormal?.y || 1.0);
            const nx = leg.groundNormal?.x || 0;
            const nz = leg.groundNormal?.z || 0;
            const yaw = motion?.currentYaw || 0;
            const sinY = Math.sin(yaw);
            const cosY = Math.cos(yaw);
            const pitch = Math.atan2(-(nx * sinY + nz * cosY), ny);
            const roll = Math.atan2(nx * cosY - nz * sinY, ny);

            _soleOptions.width = leg.footWidth || 0.82;
            _soleOptions.length = leg.footLength || 0.82;
            _soleOptions.heading = yaw;
            _soleOptions.pitch = pitch;
            _soleOptions.roll = roll;
            const contact = sandField.contact(
                leg.currentFootPos.x,
                leg.currentFootPos.z,
                SAND.stepFootprintRadius,
                leg.normalLoad || 0,
                SANDFIELD.footArea,
                dt,
                displacement,
                isSandAt,
                _soleOptions
            );
            leg.sinkRate = contact.sinkRate;
            if (granules && leg.slip > 0.08) {
                granules.spawnFootEjection(leg.currentFootPos, leg.slipVelocity, 6, 0.75);
            }
        }
        // A later footprint can change packing beneath an earlier one. Keep
        // ALL owned surface snapshots current after this deformation pass.
        for (const leg of legs) {
            if (!motion.airborne && leg.isPlanted && !leg.isStepping) sampleContact(leg);
        }
    }

    // Запуск шага для активного трипода
    // Адаптивная постановка лап: обход камней, крутых гребней и глубоких воронок
    function findAdaptiveFoothold(_leg: HexapodLeg, idealX: number, idealZ: number): { x: number; y: number; z: number } {
        const base = sampler.sample(idealX, idealZ);
        if (base.normal.y >= 0.92 && (!base.sink || base.sink < 0.12)) {
            _footholdResult.x = idealX;
            _footholdResult.y = base.y;
            _footholdResult.z = idealZ;
            return _footholdResult;
        }

        let bestX = idealX;
        let bestZ = idealZ;
        let bestY = base.y;
        let bestScore = base.normal.y * 3.0 - (base.sink || 0) * 2.0;

        const radius = GAIT.footholdSearchRadius || 0.38;
        const samples = GAIT.footholdSamples || 8;

        for (let ring = 1; ring <= 2; ring++) {
            const r = (ring / 2) * radius;
            for (let i = 0; i < samples; i++) {
                const angle = (i / samples) * Math.PI * 2;
                const cx = idealX + Math.cos(angle) * r;
                const cz = idealZ + Math.sin(angle) * r;
                const hit = sampler.sample(cx, cz);

                const slopeScore = hit.normal.y * 3.5;
                const sinkScore = -(hit.sink || 0) * 2.5;
                const distScore = -r * 0.7;

                let edgePenalty = 0;
                if (hit.surfaceType === 'solid') {
                    const testSide = sampler.sample(cx + 0.1, cz + 0.1);
                    if (testSide.surfaceType !== 'solid') edgePenalty = -2.5;
                }

                const score = slopeScore + sinkScore + distScore + edgePenalty;
                if (score > bestScore + 0.1) {
                    bestScore = score;
                    bestX = cx;
                    bestZ = cz;
                    bestY = hit.y;
                }
            }
        }
        _footholdResult.x = bestX;
        _footholdResult.y = bestY;
        _footholdResult.z = bestZ;
        return _footholdResult;
    }

    function triggerSteps(groupLegs: HexapodLeg[], motion: any): void {
        // Малый поворот для упреждения положения лапы при развороте на месте
        scratchTurnLead.setFromAxisAngle(upAxis, motion.desiredYawRate * GAIT.turnLeadTime);

        for (let i = 0; i < groupLegs.length; i++) {
            const leg = groupLegs[i];
            const idealWorld = scratchWorld
                .copy(scratchLocal.copy(leg.restLocal).applyQuaternion(scratchTurnLead))
                .applyQuaternion(motion.bodyQuat).add(motion.bodyPos);

            // Упреждение шага по текущему вектору движения
            idealWorld.x += motion.desiredVelX * GAIT.stepLeadTime;
            idealWorld.z += motion.desiredVelZ * GAIT.stepLeadTime;

            const foothold = findAdaptiveFoothold(leg, idealWorld.x, idealWorld.z);
            idealWorld.x = foothold.x;
            idealWorld.y = foothold.y;
            idealWorld.z = foothold.z;

            leg.isStepping = true;
            leg.stepProgress = 0.0;
            leg.stepStartPos.copy(leg.currentFootPos);
            leg.stepTargetPos.copy(idealWorld);

            sandDust(leg.currentFootPos, 5, 0.5);
        }
    }

    // Кинематическое тело стопы и IK сегментов ноги
    function applyFootPose(leg: HexapodLeg): void {
        _footKinTranslation.x = leg.currentFootPos.x;
        _footKinTranslation.y = leg.currentFootPos.y + GAIT.footRestOffset;
        _footKinTranslation.z = leg.currentFootPos.z;
        leg.footRb.setNextKinematicTranslation(_footKinTranslation);
        solveHexapodLeg(leg, leg.currentFootPos);
    }

    // Постановка всех лап после срыва в воздухе
    function plantAfterLanding(motion: any): void {
        const { bodyPos, bodyQuat } = motion;
        legs.forEach(leg => {
            const idealWorld = scratchWorld
                .copy(scratchLocal.copy(leg.restLocal).applyQuaternion(bodyQuat)).add(bodyPos);
            const foothold = findAdaptiveFoothold(leg, idealWorld.x, idealWorld.z);
            idealWorld.x = foothold.x;
            idealWorld.y = foothold.y;
            idealWorld.z = foothold.z;

            leg.isStepping = true;
            leg.stepProgress = GAIT.plantProgress;
            leg.stepStartPos.copy(leg.currentFootPos);
            leg.stepTargetPos.copy(idealWorld);
            sandDust(leg.currentFootPos, 9, 1.0);
        });
        gaitCooldown = 0.0;
    }

    // Сопла бьют в песок в момент отрыва: под корпусом остается воронка,
    // из-под лап вылетает пыль. Это единственный след прыжка на грунте.
    function blastTakeoff(motion: any): void {
        const surface = sampler.sample(motion.bodyPos.x, motion.bodyPos.z);
        scratchWorld.set(motion.bodyPos.x, surface.y, motion.bodyPos.z);
        sandImpact(scratchWorld, SAND.jumpBlastRadius, SAND.jumpBlastDepth, 24, 1.6);
        if (granules) granules.spawnThrusterBurst(scratchWorld, 48, 1.8);
        legs.forEach(leg => sandDust(leg.currentFootPos, 6, 0.9));
    }

    // Полет: на подъеме лапы поджаты под брюхо, на спуске выпускаются
    // навстречу песку. Выпуск — не косметика: касание считается по корпусу,
    // и к этому моменту стопы должны уже доставать до грунта, иначе мех
    // сядет на брюхо, а IK останется в поджатой позе.
    function updateAirborne(dt: number, motion: any): void {
        // На кадре отрыва снимок тела еще покоящийся — это подъем, а не спуск
        const extending = !motion.launched && motion.bodyVel.y <= 0.0;
        const blend = 1.0 - Math.exp(-dt * (extending ? GAIT.landingExtendRate : GAIT.tuckBlend));
        const upBlend = 1.0 - Math.exp(-dt * GAIT.tuckUpBlend);

        legs.forEach((leg, index) => {
            const local = extending ? leg.restLocal : tuckLocals[index];
            const target = scratchWorld
                .copy(scratchLocal.copy(local).applyQuaternion(motion.bodyQuat))
                .add(motion.bodyPos);

            let normal = upAxis;
            let surfaceY: number | null = null;
            if (extending) {
                // Стойка не проваливается сквозь песок: как только она
                // дотягивается до поверхности, стопа ложится на нее.
                const surface = sampleContact(leg, target.x, target.z);
                if (target.y < surface.y) target.y = surface.y;
                normal = surface.normal;
                surfaceY = surface.y;
            } else {
                leg.groundContact = null;
                leg.packing = 0;
            }
            leg.sinkRate = 0;

            leg.isStepping = false;
            leg.isPlanted = false;
            leg.normalLoad = 0.0;
            leg.traction = 0.0;
            leg.sink = 0.0;
            leg.currentFootPos.lerp(target, blend);
            leg.groundNormal.lerp(normal, upBlend).normalize();

            // Зазор ведется и в полете: локомотив объявляет посадку
            // только когда стопы действительно дошли до песка, а не
            // когда центр корпуса пересек высоту по своему пробнику.
            leg.groundGap = surfaceY === null
                ? Infinity
                : leg.currentFootPos.y - surfaceY;

            applyFootPose(leg);
        });
    }

    // Посадка после прыжка: стопы уже выпущены к песку, поэтому здесь они
    // фиксируются в точке касания без дуги переноса. Воронки ставятся по
    // скорости снижения: чем тяжелее приземление, тем шире удар.
    function landAfterFlight(motion: any): void {
        const impactSpeed = Math.max(0.0, -motion.bodyVel.y);

        legs.forEach(leg => {
            const target = scratchWorld
                .copy(scratchLocal.copy(leg.restLocal).applyQuaternion(motion.bodyQuat))
                .add(motion.bodyPos);
            const surface = sampleContact(leg, target.x, target.z);

            leg.isStepping = false;
            leg.stepProgress = 1.0;
            leg.stepStartPos.copy(leg.currentFootPos);
            leg.stepTargetPos.set(target.x, surface.y, target.z);
            leg.currentFootPos.copy(leg.stepTargetPos);
            leg.groundNormal.copy(surface.normal);
            leg.isPlanted = true;
            leg.groundGap = 0.0;
            leg.contactBlend = GAIT.contactBlendStart;
            leg.normalLoad = 0.0;
            leg.sink = 0.0;
            leg.traction = 0.0;

            landFoot(leg, impactSpeed, 0, 10 + Math.min(10, Math.round(impactSpeed)), 1.35);
        });

        gaitCooldown = 0.0;
    }

    function update(dt: number, motion: any): GaitStepResult {
        impactChangedGround = false;
        const { bodyPos, bodyQuat, signedWalkSpeed, desiredYawRate } = motion;
        for (const leg of legs) {
            const pending = leg.pendingAnchorShift;
            const stale = pending && leg.currentFootPos.distanceTo(pending.origin) > GAIT.anchorPositionEpsilon;
            const transition = motion.airborne || wasAirborne || motion.landed || motion.recovery
                || leg.isStepping || !leg.isPlanted;
            clearAnchorMotion(leg, transition || stale);
        }

        // Визуальный корпус встает в позу текущего кадра: IK считает мировые
        // матрицы узлов, поэтому корень должен быть уже на месте
        if (syncBody) syncBody(motion);

        // В полете нечем переступать: на подъеме лапы поджаты под брюхо,
        // на спуске выпускаются навстречу песку.
        if (motion.airborne) {
            if (motion.launched) blastTakeoff(motion);
            updateAirborne(dt, motion);
            wasAirborne = true;
            return { finishedStep: false, stomped: false, landed: false };
        }

        let landed = false;
        if (wasAirborne) {
            wasAirborne = false;
            landAfterFlight(motion);
            landed = true;
        }

        // Лебедка подняла опрокинутый корпус: лапы нужно поставить заново,
        // иначе они останутся в позе упавшей машины.
        if (motion.recovery) plantAfterLanding(motion);

        // Вес корпуса на стоящих лапах и давление в песок
        updatePlantFlags();

        // Удар по песку: Пробел продавливает воронки под опорными лапами
        // и в центре корпуса, выбрасывая клубы пыли. Это разовое событие,
        // а не постоянная просадка корпуса.
        let stomped = false;
        stompCooldown -= dt;
        if (motion.stompHeld && stompCooldown <= 0.0) {
            stompCooldown = SAND.stompInterval;
            stomped = true;

            legs.forEach(leg => {
                if (leg.isStepping) return;
                sandImpact(leg.currentFootPos, SAND.stompRadius, SAND.stompDepth, 8, 1.2);
            });

            const centerGround = sampler.sample(bodyPos.x, bodyPos.z);
            const impact = scratchWorld.set(bodyPos.x, centerGround.y, bodyPos.z);
            sandImpact(impact,
                SAND.stompRadius * SAND.stompCenterScale,
                SAND.stompDepth * SAND.stompCenterDepthScale,
                18, 1.6);
        }

        let anyStepping = false;
        for (let i = 0; i < legs.length; i++) {
            if (legs[i].isStepping) {
                anyStepping = true;
                break;
            }
        }
        if (!anyStepping) gaitCooldown -= dt;

        // Проверяем, нужно ли активному триподу сделать следующий шаг.
        // Шаг поднимает половину опоры, поэтому на песке должно стоять не
        // меньше трех лап. Когда запас полигона на пределе, переступать
        // можно только разгруженным триподом: он все равно не держит корпус,
        // а его перестановка подводит полигон обратно под центр масс.
        const plantedCount = motion.plantedCount === undefined ? legs.length : motion.plantedCount;
        const unstable = motion.tippingMargin < GAIT.stumbleMargin;

        if (!anyStepping && gaitCooldown <= 0.0 && plantedCount >= 3) {
            const group = unstable
                ? (groupLoad(0) <= groupLoad(1) ? 0 : 1)
                : activeGaitGroup;
            const groupLegs = group === 0 ? group0Legs : group1Legs;
            let maxError = 0;

            for (let i = 0; i < groupLegs.length; i++) {
                const leg = groupLegs[i];
                const idealWorld = scratchWorld
                    .copy(scratchLocal.copy(leg.restLocal).applyQuaternion(bodyQuat)).add(bodyPos);
                const err = Math.hypot(leg.currentFootPos.x - idealWorld.x, leg.currentFootPos.z - idealWorld.z);
                if (err > maxError) maxError = err;
            }

            const eps = GAIT.moveSpeedEps;
            const isMovingOrTurning = Math.abs(signedWalkSpeed) > eps || Math.abs(desiredYawRate) > eps;
            const stepThreshold = unstable
                ? GAIT.stumbleError
                : (isMovingOrTurning ? GAIT.stepThresholdMoving : GAIT.stepThresholdIdle);

            if (maxError > stepThreshold) {
                triggerSteps(groupLegs, motion);
                activeGaitGroup = group;
            }
        }

        let finishedStep = false;
        const followK = 1.0 - Math.exp(-dt * GAIT.groundFollowRate);
        const normalK = 1.0 - Math.exp(-dt * GAIT.normalBlendRate);
        const blendK = 1.0 - Math.exp(-dt * GAIT.contactBlendRate);

        legs.forEach(leg => {
            if (leg.isStepping) {
                clearAnchorMotion(leg); // Includes a swing triggered in this pass.
                const stepRate = GAIT.stepRateBase
                    + Math.abs(signedWalkSpeed) * GAIT.stepRateSpeedGain
                    + Math.abs(desiredYawRate) * GAIT.stepRateTurnGain;
                leg.stepProgress += dt * stepRate;

                if (leg.stepProgress >= 1.0) {
                    leg.stepProgress = 1.0;
                    leg.isStepping = false;
                    leg.isPlanted = true;
                    leg.currentFootPos.copy(leg.stepTargetPos);

                    const groundHit = sampleContact(leg);
                    leg.currentFootPos.y = groundHit.y;
                    leg.groundNormal.copy(groundHit.normal);
                    leg.groundGap = 0.0;
                    // Стойка после касания нагружается плавно: активный
                    // набор меняется, но момент на корпус не бросается.
                    leg.contactBlend = GAIT.contactBlendStart;

                    // Глубина отпечатка зависит от скорости удара: быстрый шаг
                    // вбивает стопу глубже, чем осторожная постановка.
                    const impactSpeed = GAIT.stepArcHeight * stepRate * 1.4;
                    landFoot(leg, impactSpeed, leg.normalLoad, 12, 0.95);
                    finishedStep = true;
                } else {
                    const p = leg.stepProgress;
                    const smoothP = p * p * (3.0 - 2.0 * p);
                    leg.currentFootPos.lerpVectors(leg.stepStartPos, leg.stepTargetPos, smoothP);

                    // Swing clearance follows the selected upper surface,
                    // including rocks rather than the hidden sand beneath them.
                    const groundMid = sampler.sample(
                        leg.currentFootPos.x,
                        leg.currentFootPos.z
                    ).y;
                    leg.currentFootPos.y = Math.max(leg.stepStartPos.y, groundMid) + Math.sin(p * Math.PI) * GAIT.stepArcHeight;
                }
            } else if (leg.isPlanted) {
                // Опорная стопа прижата к песку и проседает вместе с ним
                const groundNow = sampleContact(leg);
                leg.currentFootPos.y = THREE.MathUtils.lerp(leg.currentFootPos.y, groundNow.y, followK);
                leg.groundNormal.lerp(groundNow.normal, normalK).normalize();

                // Зазор подтверждает касание для силового слоя: лапа,
                // повисшая над песком после крена, перестает нести вес.
                leg.groundGap = leg.currentFootPos.y - groundNow.y;
                applyPendingAnchor(leg, dt, motion);

                // Нагрузка стойки растет до полной за доли секунды
                // после постановки, а не скачком.
                leg.contactBlend = leg.contactBlend === undefined
                    ? 1.0
                    : leg.contactBlend + (1.0 - leg.contactBlend) * blendK;
            }
        });

        // A later impact may also deform an earlier foot's contact patch.
        // Re-sample after ALL synchronous impact/collider updates, before IK
        // and the load solve. Do not snap feet: retain the existing follow law.
        for (const leg of legs) {
            if (impactChangedGround && leg.isPlanted && !leg.isStepping) {
                const surface = sampleContact(leg);
                leg.groundNormal.copy(surface.normal);
                leg.groundGap = leg.currentFootPos.y - surface.y;
            }
            applyFootPose(leg);
        }

        if (finishedStep) {
            // Переключаем очередь на другой трипод
            activeGaitGroup = 1 - activeGaitGroup;
            gaitCooldown = GAIT.stepCooldown;
        }

        return { finishedStep, stomped, landed };
    }

    // Pressure uses this substep's applied normal loads. Grooves consume only
    // the anchor displacement accepted earlier in this gait pass, not the new
    // pending request produced by contacts.solve().
    function applySand(dt: number, motion: any): void {
        updateFootContacts(dt, motion);
    }

    return { update, applySand };
}
