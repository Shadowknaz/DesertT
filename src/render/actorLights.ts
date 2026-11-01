import * as THREE from 'three';
import { applyPS1VertexSnap } from './ps1Material.ts';
import type { MechRig } from '../mech/mechRig.ts';
import type { PlayerModel } from '../character/playerModel.ts';
import type { IVehicleModel } from '../transport/types.ts';
import type { DayState } from '../world/dayCycle.ts';
import type { WeatherState } from '../world/weather.ts';

export type LightActorId = 'mech' | 'cosmo' | 'buggy';

export interface CreateActorLightsParams {
  scene?: THREE.Scene;
  mechRig?: MechRig | null;
  playerModel?: PlayerModel | null;
  buggyModel?: IVehicleModel | null;
  initialEnabled?: boolean | { mech?: boolean; cosmo?: boolean; buggy?: boolean };
}

export interface ActorLightsSystem {
  isEnabled(actorId?: LightActorId | string): boolean;
  setEnabled(actorIdOrEnabled: LightActorId | string | boolean, enabled?: boolean): boolean;
  toggle(actorId?: LightActorId | string): boolean;
  update(dt?: number, dayState?: DayState | null, weatherState?: WeatherState | null): void;
  dispose(): void;
  mechLightGroup: THREE.Group;
  cosmoHeadLightGroup: THREE.Group;
  cosmoTorsoLightGroup: THREE.Group;
  buggyLightGroup: THREE.Group;
  lights: THREE.Light[];
  mechLights: THREE.Light[];
  cosmoLights: THREE.Light[];
  buggyLights: THREE.Light[];
}

interface ActorLightBucket {
  enabled: boolean;
  mainLensMat: THREE.MeshBasicMaterial;
  coreBulbMat: THREE.MeshBasicMaterial;
  amberLensMat: THREE.MeshBasicMaterial;
  emissiveMeshes: THREE.Mesh[];
  spotLights: { light: THREE.SpotLight; baseIntensity: number }[];
  pointLights: { light: THREE.PointLight; baseIntensity: number }[];
  lights: THREE.Light[];
}

function normalizeActorId(actorId?: string): LightActorId {
  if (actorId === 'cosmo' || actorId === 'character' || actorId === 'player') {
    return 'cosmo';
  }
  if (actorId === 'buggy' || actorId === 'transport' || actorId === 'vehicle') {
    return 'buggy';
  }
  return 'mech';
}

export function createActorLights({
  mechRig = null,
  playerModel = null,
  buggyModel = null,
  initialEnabled = false,
}: CreateActorLightsParams = {}): ActorLightsSystem {
  const initialMech =
    typeof initialEnabled === 'boolean' ? initialEnabled : Boolean(initialEnabled?.mech);
  const initialCosmo =
    typeof initialEnabled === 'boolean' ? initialEnabled : Boolean(initialEnabled?.cosmo);
  const initialBuggy =
    typeof initialEnabled === 'boolean' ? initialEnabled : Boolean(initialEnabled?.buggy);

  let elapsed = 0;

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const lights: THREE.Light[] = [];

  function trackGeo<T extends THREE.BufferGeometry>(geo: T): T {
    geometries.push(geo);
    return geo;
  }

  function trackMat<T extends THREE.Material>(mat: T): T {
    materials.push(mat);
    return mat;
  }

  // Shared PS1-styled industrial materials for lantern housings & reflectors
  const housingMat = trackMat(
    new THREE.MeshLambertMaterial({
      color: 0x232528,
      flatShading: true,
    }),
  );
  applyPS1VertexSnap(housingMat);

  const brassRimMat = trackMat(
    new THREE.MeshLambertMaterial({
      color: 0x9c6e3b,
      flatShading: true,
    }),
  );
  applyPS1VertexSnap(brassRimMat);

  const lensOnColor = new THREE.Color(0xffeab3);
  const lensOffColor = new THREE.Color(0x181e24);
  const coreBulbOnColor = new THREE.Color(0xffffff);
  const coreBulbOffColor = new THREE.Color(0x252b30);
  const lensAmberOnColor = new THREE.Color(0xffb84d);
  const lensAmberOffColor = new THREE.Color(0x241910);

  function createBucket(enabled: boolean): ActorLightBucket {
    return {
      enabled,
      mainLensMat: trackMat(
        new THREE.MeshBasicMaterial({
          color: enabled ? lensOnColor : lensOffColor,
        }),
      ),
      coreBulbMat: trackMat(
        new THREE.MeshBasicMaterial({
          color: enabled ? coreBulbOnColor : coreBulbOffColor,
        }),
      ),
      amberLensMat: trackMat(
        new THREE.MeshBasicMaterial({
          color: enabled ? lensAmberOnColor : lensAmberOffColor,
        }),
      ),
      emissiveMeshes: [],
      spotLights: [],
      pointLights: [],
      lights: [],
    };
  }

  const buckets: Record<LightActorId, ActorLightBucket> = {
    mech: createBucket(initialMech),
    cosmo: createBucket(initialCosmo),
    buggy: createBucket(initialBuggy),
  };

  // ============================================================================
  // 1. MECH LANTERNS & HEADLIGHTS (attached to mechRig.chassisGroup)
  // ============================================================================
  const mechBucket = buckets.mech;
  const mechLightGroup = new THREE.Group();
  mechLightGroup.name = 'mechActorLights';

  const mechHousingGeo = trackGeo(new THREE.CylinderGeometry(0.22, 0.26, 0.38, 6));
  mechHousingGeo.rotateX(Math.PI / 2);
  const mechRimGeo = trackGeo(new THREE.CylinderGeometry(0.24, 0.24, 0.08, 6));
  mechRimGeo.rotateX(Math.PI / 2);
  const mechLensGeo = trackGeo(new THREE.CylinderGeometry(0.18, 0.18, 0.04, 6));
  mechLensGeo.rotateX(Math.PI / 2);
  const mechBulbGeo = trackGeo(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 6));
  mechBulbGeo.rotateX(Math.PI / 2);

  const roofBarGeo = trackGeo(new THREE.BoxGeometry(1.5, 0.08, 0.14));
  const roofBar = new THREE.Mesh(roofBarGeo, housingMat);
  roofBar.position.set(0, 2.04, 2.15);
  mechLightGroup.add(roofBar);

  for (const side of [-1, 1]) {
    // Roof searchlight pod
    const roofPod = new THREE.Group();
    roofPod.position.set(side * 0.55, 2.16, 2.22);
    roofPod.rotation.x = 0.22;

    const podBody = new THREE.Mesh(mechHousingGeo, housingMat);
    roofPod.add(podBody);

    const podRim = new THREE.Mesh(mechRimGeo, brassRimMat);
    podRim.position.z = 0.18;
    roofPod.add(podRim);

    const podLens = new THREE.Mesh(mechLensGeo, mechBucket.mainLensMat);
    podLens.position.z = 0.205;
    roofPod.add(podLens);

    const podBulb = new THREE.Mesh(mechBulbGeo, mechBucket.coreBulbMat);
    podBulb.position.z = 0.215;
    roofPod.add(podBulb);

    mechLightGroup.add(roofPod);

    // Nose upper twin headlight glowing lenses
    const upperNosePod = new THREE.Group();
    upperNosePod.position.set(side * 1.18, 0.54, 4.43);
    upperNosePod.rotation.x = 0.18;

    const upperLens = new THREE.Mesh(mechLensGeo, mechBucket.mainLensMat);
    upperNosePod.add(upperLens);

    const upperBulb = new THREE.Mesh(mechBulbGeo, mechBucket.coreBulbMat);
    upperBulb.position.z = 0.012;
    upperNosePod.add(upperBulb);

    const upperRim = new THREE.Mesh(mechRimGeo, brassRimMat);
    upperRim.position.z = -0.02;
    upperNosePod.add(upperRim);

    mechLightGroup.add(upperNosePod);

    // Chin fog/flood amber lantern lenses
    const chinPodGroup = new THREE.Group();
    chinPodGroup.position.set(side * 1.05, -0.30, 4.34);
    chinPodGroup.rotation.x = 0.26;

    const chinLens = new THREE.Mesh(mechLensGeo, mechBucket.amberLensMat);
    chinLens.scale.setScalar(0.85);
    chinPodGroup.add(chinLens);

    mechLightGroup.add(chinPodGroup);
  }

  // Wide, 100% soft-penumbra forward SpotLights + graduated PointLights so there is NO hard geometric cone
  for (const side of [-1, 1]) {
    const spot = new THREE.SpotLight(
      0xffebc2,
      mechBucket.enabled ? 11.5 : 0,
      62,
      Math.PI / 2.05,
      1.0,
      1.45,
    );
    spot.position.set(side * 1.1, 1.35, 4.5);
    spot.castShadow = false;
    spot.target.position.set(side * 3.2, -4.5, 26.0);
    mechLightGroup.add(spot);
    mechLightGroup.add(spot.target);
    lights.push(spot);
    mechBucket.lights.push(spot);
    mechBucket.spotLights.push({ light: spot, baseIntensity: 11.5 });
  }

  // Fixture & nose glow PointLight (illuminates the Mech's own head, front armor, and front legs)
  const mechFixtureLight = new THREE.PointLight(
    0xffe2a8,
    mechBucket.enabled ? 3.8 : 0,
    15,
    1.5,
  );
  mechFixtureLight.position.set(0, 0.85, 5.2);
  mechLightGroup.add(mechFixtureLight);
  lights.push(mechFixtureLight);
  mechBucket.lights.push(mechFixtureLight);
  mechBucket.pointLights.push({ light: mechFixtureLight, baseIntensity: 3.8 });

  // Mid-range forward fill PointLight so the sand ahead transitions smoothly without a cone edge
  const mechForwardFillLight = new THREE.PointLight(
    0xffe6b5,
    mechBucket.enabled ? 6.5 : 0,
    34,
    1.45,
  );
  mechForwardFillLight.position.set(0, 1.6, 13.5);
  mechLightGroup.add(mechForwardFillLight);
  lights.push(mechForwardFillLight);
  mechBucket.lights.push(mechForwardFillLight);
  mechBucket.pointLights.push({ light: mechForwardFillLight, baseIntensity: 6.5 });

  // Under-chassis amber utility PointLight
  const mechUnderLight = new THREE.PointLight(0xffb85c, mechBucket.enabled ? 2.8 : 0, 12, 1.55);
  mechUnderLight.position.set(0, -1.0, 2.2);
  mechLightGroup.add(mechUnderLight);
  lights.push(mechUnderLight);
  mechBucket.lights.push(mechUnderLight);
  mechBucket.pointLights.push({ light: mechUnderLight, baseIntensity: 2.8 });

  if (mechRig?.chassisGroup) {
    mechRig.chassisGroup.add(mechLightGroup);
  }

  // ============================================================================
  // 2. COSMO LANTERNS & FLASHLIGHTS (attached to headGroup and torsoGroup)
  // ============================================================================
  const cosmoBucket = buckets.cosmo;
  const cosmoHeadLightGroup = new THREE.Group();
  cosmoHeadLightGroup.name = 'cosmoHeadLights';

  const cosmoTorsoLightGroup = new THREE.Group();
  cosmoTorsoLightGroup.name = 'cosmoTorsoLights';

  const helmetLampPod = new THREE.Group();
  helmetLampPod.position.set(0.138, 0.125, 0.055);
  helmetLampPod.rotation.x = 0.12;

  const smallBodyGeo = trackGeo(new THREE.CylinderGeometry(0.026, 0.03, 0.11, 6));
  smallBodyGeo.rotateX(Math.PI / 2);
  const smallRimGeo = trackGeo(new THREE.CylinderGeometry(0.031, 0.031, 0.022, 6));
  smallRimGeo.rotateX(Math.PI / 2);
  const smallLensGeo = trackGeo(new THREE.CylinderGeometry(0.024, 0.024, 0.012, 6));
  smallLensGeo.rotateX(Math.PI / 2);
  const smallBulbGeo = trackGeo(new THREE.CylinderGeometry(0.012, 0.012, 0.014, 6));
  smallBulbGeo.rotateX(Math.PI / 2);

  const helmetLampBody = new THREE.Mesh(smallBodyGeo, housingMat);
  helmetLampPod.add(helmetLampBody);

  const helmetLampRim = new THREE.Mesh(smallRimGeo, brassRimMat);
  helmetLampRim.position.z = 0.052;
  helmetLampPod.add(helmetLampRim);

  const helmetLampLens = new THREE.Mesh(smallLensGeo, cosmoBucket.mainLensMat);
  helmetLampLens.position.z = 0.06;
  helmetLampPod.add(helmetLampLens);

  const helmetLampBulb = new THREE.Mesh(smallBulbGeo, cosmoBucket.coreBulbMat);
  helmetLampBulb.position.z = 0.063;
  helmetLampPod.add(helmetLampBulb);

  cosmoHeadLightGroup.add(helmetLampPod);

  const opticGlowGeo = trackGeo(new THREE.CircleGeometry(0.039, 8));
  const opticGlowMesh = new THREE.Mesh(opticGlowGeo, cosmoBucket.amberLensMat);
  opticGlowMesh.position.set(-0.045, 0.11, 0.174);
  opticGlowMesh.visible = cosmoBucket.enabled;
  cosmoBucket.emissiveMeshes.push(opticGlowMesh);
  cosmoHeadLightGroup.add(opticGlowMesh);

  // Wide, 100% soft-penumbra headlamp SpotLight on Cosmo's head (no harsh cone edge)
  const cosmoHeadSpot = new THREE.SpotLight(
    0xffedc4,
    cosmoBucket.enabled ? 11.0 : 0,
    32,
    Math.PI / 2.1,
    1.0,
    1.45,
  );
  cosmoHeadSpot.position.set(0.08, 0.14, 0.24);
  cosmoHeadSpot.castShadow = false;
  cosmoHeadSpot.target.position.set(0, -1.5, 11.0);
  cosmoHeadLightGroup.add(cosmoHeadSpot);
  cosmoHeadLightGroup.add(cosmoHeadSpot.target);
  lights.push(cosmoHeadSpot);
  cosmoBucket.lights.push(cosmoHeadSpot);
  cosmoBucket.spotLights.push({ light: cosmoHeadSpot, baseIntensity: 11.0 });

  // Mid-range forward fill PointLight along Cosmo's gaze for natural radial light dispersion
  const cosmoForwardFill = new THREE.PointLight(
    0xffe6b3,
    cosmoBucket.enabled ? 4.2 : 0,
    18,
    1.45,
  );
  cosmoForwardFill.position.set(0, -0.15, 3.6);
  cosmoHeadLightGroup.add(cosmoForwardFill);
  lights.push(cosmoForwardFill);
  cosmoBucket.lights.push(cosmoForwardFill);
  cosmoBucket.pointLights.push({ light: cosmoForwardFill, baseIntensity: 4.2 });

  const chestLanternGroup = new THREE.Group();
  chestLanternGroup.position.set(0.135, 0.34, 0.185);
  chestLanternGroup.rotation.x = 0.18;

  const chestBoxGeo = trackGeo(new THREE.BoxGeometry(0.068, 0.068, 0.065));
  const chestBox = new THREE.Mesh(chestBoxGeo, housingMat);
  chestLanternGroup.add(chestBox);

  const chestRim = new THREE.Mesh(smallRimGeo, brassRimMat);
  chestRim.scale.setScalar(1.08);
  chestRim.position.z = 0.034;
  chestLanternGroup.add(chestRim);

  const chestLens = new THREE.Mesh(smallLensGeo, cosmoBucket.amberLensMat);
  chestLens.scale.setScalar(1.1);
  chestLens.position.z = 0.042;
  chestLanternGroup.add(chestLens);

  const chestBulb = new THREE.Mesh(smallBulbGeo, cosmoBucket.coreBulbMat);
  chestBulb.position.z = 0.045;
  chestLanternGroup.add(chestBulb);

  cosmoTorsoLightGroup.add(chestLanternGroup);

  // Near-field PointLight on Cosmo's torso so Cosmo's suit and immediate ground are softly lit
  const cosmoNearLight = new THREE.PointLight(0xffdfa6, cosmoBucket.enabled ? 2.6 : 0, 9.0, 1.5);
  cosmoNearLight.position.set(0, 0.36, 0.52);
  cosmoTorsoLightGroup.add(cosmoNearLight);
  lights.push(cosmoNearLight);
  cosmoBucket.lights.push(cosmoNearLight);
  cosmoBucket.pointLights.push({ light: cosmoNearLight, baseIntensity: 2.6 });

  if (playerModel?.joints?.headGroup) {
    playerModel.joints.headGroup.add(cosmoHeadLightGroup);
  }
  if (playerModel?.joints?.torsoGroup) {
    playerModel.joints.torsoGroup.add(cosmoTorsoLightGroup);
  }

  // ============================================================================
  // 3. BUGGY MOTORCYCLE TWIN HALOGEN HEADLIGHT (attached to headlightGroup)
  // ============================================================================
  const buggyBucket = buckets.buggy;
  const buggyLightGroup = new THREE.Group();
  buggyLightGroup.name = 'buggyHeadLights';

  const buggyGlowMainGeo = trackGeo(new THREE.CircleGeometry(0.058, 8));
  const buggyGlowMain = new THREE.Mesh(buggyGlowMainGeo, buggyBucket.mainLensMat);
  buggyGlowMain.position.set(-0.065, 0.01, 0.142);
  buggyGlowMain.visible = buggyBucket.enabled;
  buggyBucket.emissiveMeshes.push(buggyGlowMain);
  buggyLightGroup.add(buggyGlowMain);

  const buggyGlowAuxGeo = trackGeo(new THREE.CircleGeometry(0.038, 7));
  const buggyGlowAux = new THREE.Mesh(buggyGlowAuxGeo, buggyBucket.amberLensMat);
  buggyGlowAux.position.set(0.075, 0.02, 0.13);
  buggyGlowAux.visible = buggyBucket.enabled;
  buggyBucket.emissiveMeshes.push(buggyGlowAux);
  buggyLightGroup.add(buggyGlowAux);

  const buggyHeadSpot = new THREE.SpotLight(
    0xffebc2,
    buggyBucket.enabled ? 13.5 : 0,
    46,
    Math.PI / 2.05,
    1.0,
    1.4,
  );
  buggyHeadSpot.position.set(0, 0.05, 0.22);
  buggyHeadSpot.castShadow = false;
  buggyHeadSpot.target.position.set(0, -2.2, 18.0);
  buggyLightGroup.add(buggyHeadSpot);
  buggyLightGroup.add(buggyHeadSpot.target);
  lights.push(buggyHeadSpot);
  buggyBucket.lights.push(buggyHeadSpot);
  buggyBucket.spotLights.push({ light: buggyHeadSpot, baseIntensity: 13.5 });

  const buggyForwardFill = new THREE.PointLight(
    0xffe4ad,
    buggyBucket.enabled ? 5.2 : 0,
    24,
    1.45,
  );
  buggyForwardFill.position.set(0, 0.1, 6.5);
  buggyLightGroup.add(buggyForwardFill);
  lights.push(buggyForwardFill);
  buggyBucket.lights.push(buggyForwardFill);
  buggyBucket.pointLights.push({ light: buggyForwardFill, baseIntensity: 5.2 });

  const buggyNearLight = new THREE.PointLight(0xffd896, buggyBucket.enabled ? 3.0 : 0, 10.0, 1.5);
  buggyNearLight.position.set(0, 0.15, 0.65);
  buggyLightGroup.add(buggyNearLight);
  lights.push(buggyNearLight);
  buggyBucket.lights.push(buggyNearLight);
  buggyBucket.pointLights.push({ light: buggyNearLight, baseIntensity: 3.0 });

  if (buggyModel?.joints?.headlightGroup) {
    buggyModel.joints.headlightGroup.add(buggyLightGroup);
  }

  function applyBucketState(
    bucket: ActorLightBucket,
    dayState?: DayState | null,
    weatherState?: WeatherState | null,
  ): void {
    let envBoost = 1.0;
    if (dayState && typeof dayState.sunElevation === 'number') {
      const nightFactor = Math.max(0, Math.min(1, (0.25 - dayState.sunElevation) / 0.45));
      envBoost += nightFactor * 0.25;
    }
    if (weatherState) {
      const stormVal = typeof weatherState.stormIntensity === 'number'
        ? weatherState.stormIntensity
        : (typeof weatherState.intensity === 'number' ? weatherState.intensity : 0);
      envBoost += stormVal * 0.2;
    }

    const isOn = bucket.enabled;
    bucket.mainLensMat.color.copy(isOn ? lensOnColor : lensOffColor);
    bucket.coreBulbMat.color.copy(isOn ? coreBulbOnColor : coreBulbOffColor);
    bucket.amberLensMat.color.copy(isOn ? lensAmberOnColor : lensAmberOffColor);

    const pulse = isOn ? 0.985 + 0.015 * Math.sin(elapsed * 8.0) : 0;

    for (const mesh of bucket.emissiveMeshes) {
      mesh.visible = isOn;
    }

    for (const entry of bucket.spotLights) {
      entry.light.intensity = isOn ? entry.baseIntensity * envBoost * pulse : 0;
      entry.light.target.updateMatrixWorld(true);
    }

    for (const entry of bucket.pointLights) {
      entry.light.intensity = isOn ? entry.baseIntensity * envBoost * pulse : 0;
    }
  }

  function applyState(dayState?: DayState | null, weatherState?: WeatherState | null): void {
    applyBucketState(buckets.mech, dayState, weatherState);
    applyBucketState(buckets.cosmo, dayState, weatherState);
    applyBucketState(buckets.buggy, dayState, weatherState);
  }

  applyState();

  return {
    isEnabled(actorId?: LightActorId | string): boolean {
      if (actorId !== undefined) {
        return buckets[normalizeActorId(actorId)].enabled;
      }
      return buckets.mech.enabled || buckets.cosmo.enabled || buckets.buggy.enabled;
    },
    setEnabled(actorIdOrEnabled: LightActorId | string | boolean, enabled?: boolean): boolean {
      if (typeof actorIdOrEnabled === 'boolean') {
        buckets.mech.enabled = actorIdOrEnabled;
        buckets.cosmo.enabled = actorIdOrEnabled;
        buckets.buggy.enabled = actorIdOrEnabled;
        applyState();
        return actorIdOrEnabled;
      }
      const target = normalizeActorId(actorIdOrEnabled);
      buckets[target].enabled = Boolean(enabled);
      applyState();
      return buckets[target].enabled;
    },
    toggle(actorId: LightActorId | string = 'mech'): boolean {
      const target = normalizeActorId(actorId);
      buckets[target].enabled = !buckets[target].enabled;
      applyState();
      return buckets[target].enabled;
    },
    update(dt = 0, dayState = null, weatherState = null): void {
      if (dt > 0) {
        elapsed += dt;
      }
      applyState(dayState, weatherState);
    },
    dispose(): void {
      if (mechLightGroup.parent) {
        mechLightGroup.parent.remove(mechLightGroup);
      }
      if (cosmoHeadLightGroup.parent) {
        cosmoHeadLightGroup.parent.remove(cosmoHeadLightGroup);
      }
      if (cosmoTorsoLightGroup.parent) {
        cosmoTorsoLightGroup.parent.remove(cosmoTorsoLightGroup);
      }
      if (buggyLightGroup.parent) {
        buggyLightGroup.parent.remove(buggyLightGroup);
      }
      for (const geo of geometries) {
        geo.dispose();
      }
      for (const mat of materials) {
        mat.dispose();
      }
    },
    mechLightGroup,
    cosmoHeadLightGroup,
    cosmoTorsoLightGroup,
    buggyLightGroup,
    lights,
    mechLights: buckets.mech.lights,
    cosmoLights: buckets.cosmo.lights,
    buggyLights: buckets.buggy.lights,
  };
}

