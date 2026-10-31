import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayerModel } from '../src/character/playerModel.ts';

test('createPlayerModel initializes joints and neutral stance correctly', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    assert.ok(model.joints.suitRoot);
    assert.ok(model.joints.pelvisGroup);
    assert.ok(model.joints.leftLeg);
    assert.ok(model.joints.rightLeg);
    assert.ok(model.joints.leftArm);
    assert.ok(model.joints.rightArm);

    // Initial stance foot targets
    assert.equal(model.ikTargets.leftFoot.position.x, -0.19);
    assert.equal(model.ikTargets.rightFoot.position.x, 0.19);
    assert.equal(model.ikTargets.leftFoot.position.y, 0);
    assert.equal(model.ikTargets.rightFoot.position.y, 0);

    model.dispose();
});

test('playerModel locomotion produces bipedal swing and stance phases with natural ankle pitch', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    // Step 1: Walking forward (amount = 1, phase = 0.75 * PI -> left foot past mid-swing moving forward, right foot stance)
    model.setLocomotion({ phase: Math.PI * 0.75, amount: 1.0, moveX: 0, moveZ: 1 });
    model.update();

    // Left foot is in swing phase (lifted, moving forward)
    assert.ok(model.ikTargets.leftFoot.position.y > 0.05, 'Left foot must lift off ground during swing');
    assert.ok(model.ikTargets.leftFoot.position.z > 0, 'Left foot must swing forward (+Z)');
    assert.ok(model.ikTargets.leftFoot.contactWeight < 0.5, 'Swing foot contact weight must be near zero');

    // Right foot is in stance phase (firmly on ground, supporting)
    assert.equal(model.ikTargets.rightFoot.position.y, 0, 'Right foot must remain planted on ground during stance');
    assert.ok(model.ikTargets.rightFoot.position.z < 0, 'Right foot travels backwards relative to pelvis during stance');
    assert.equal(model.ikTargets.rightFoot.contactWeight, 1.0, 'Stance foot must have full contact weight');

    model.dispose();
});

test('playerModel dynamically adapts foot positions and normal to sloped terrain via groundAt', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });
    const normalSlope = new THREE.Vector3(0, 0.9, 0.4).normalize();

    // Walking forward uphill
    model.pose.rootPosition.set(0, 1.0, 5.0);
    model.setLocomotion({ phase: Math.PI * 0.5, amount: 1.0, moveX: 0, moveZ: 1 });

    const groundAt = (x, z) => ({
        y: 1.0 + z * 0.2, // dune sloping up in Z
        normal: normalSlope
    });

    model.update(groundAt);

    // Left foot (swing) target position Y must account for the actual stepped terrain height + lift
    const expectedGroundLeft = 1.0 + model.ikTargets.leftFoot.position.z * 0.2;
    assert.ok(model.ikTargets.leftFoot.position.y > expectedGroundLeft, 'Swing foot Y must be above the terrain at that step location');

    // Right foot (stance) target position Y must match the exact terrain height at its stepped location
    const expectedGroundRight = 1.0 + model.ikTargets.rightFoot.position.z * 0.2;
    assert.ok(Math.abs(model.ikTargets.rightFoot.position.y - expectedGroundRight) < 1e-4, 'Stance foot Y must match terrain height exactly');

    // Stance foot normal must match terrain normal
    assert.ok(model.ikTargets.rightFoot.normal);
    assert.equal(model.ikTargets.rightFoot.normal, normalSlope);

    model.dispose();
});

test('playerModel exhibits dynamic pelvis bobbing, lateral sway and torso counter-rotation', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    // Mid-swing: phase = PI / 2
    model.setLocomotion({ phase: Math.PI * 0.5, amount: 1.0, moveX: 0, moveZ: 1 });
    model.update();

    // Lateral sway shifts weight towards support leg
    assert.ok(Math.abs(model.joints.pelvisGroup.position.x) > 0.01, 'Pelvis must sway laterally for weight shift');

    // Pelvis bobs vertically
    assert.notEqual(model.joints.pelvisGroup.position.y, model.constants.BASE_PELVIS_Y, 'Pelvis must bob vertically during locomotion');

    // Torso counter-rotates in yaw opposing the hips
    assert.ok(Math.abs(model.joints.torsoGroup.rotation.y) > 0.02, 'Torso must counter-twist for angular momentum balance');

    // Torso leans forward into running motion
    assert.ok(model.joints.torsoGroup.rotation.x > 0.02, 'Torso must lean forward into movement');

    model.dispose();
});

test('playerModel hydraulic pistons maintain finite matrices without gimbal lock or NaN', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    // Force extreme crouch and leg splay
    model.pose.pelvisOffset.y = -0.35;
    model.pose.pelvisRotation.set(0.2, 0.3, -0.2);
    model.pose.torsoRotation.set(-0.3, 0.4, 0.1);
    model.setLocomotion({ phase: 2.5, amount: 1.0, moveX: 1, moveZ: 1 });
    model.update();

    // Check all bone groups and matrices are finite numbers
    for (const leg of [model.joints.leftLeg, model.joints.rightLeg]) {
        assert.ok(Number.isFinite(leg.thighBone.position.x));
        assert.ok(Number.isFinite(leg.thighBone.quaternion.x));
        assert.ok(Number.isFinite(leg.shinBone.position.y));
        assert.ok(Number.isFinite(leg.shinBone.quaternion.w));
    }

    for (const arm of [model.joints.leftArm, model.joints.rightArm]) {
        assert.ok(Number.isFinite(arm.upperArmBone.position.z));
        assert.ok(Number.isFinite(arm.forearmBone.quaternion.z));
    }

    model.dispose();
});

test('playerModel Soft IK prevents knee popping at maximum leg extension', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    // Place foot target far away (over-extension)
    model.ikTargets.leftFoot.position.set(-0.19, -0.9, 0.6);
    model.update();

    // Check that thigh and shin stay attached and form a valid knee joint without NaN or detachment
    const thighPos = model.joints.leftLeg.thighBone.position;
    const shinPos = model.joints.leftLeg.shinBone.position;
    const kneeDist = thighPos.distanceTo(shinPos);

    assert.ok(Math.abs(kneeDist - model.constants.THIGH_LEN) < 1e-3, 'Thigh length must remain constant in Soft IK');
    assert.ok(Number.isFinite(shinPos.y));

    model.dispose();
});

test('playerModel responds to banking roll in pelvis and torso', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    model.setLocomotion({ phase: 0, amount: 1.0, moveX: 0, moveZ: 1, bankingRoll: 0.12 });
    model.update();

    assert.ok(model.joints.pelvisGroup.rotation.z > 0.05, 'Pelvis must lean into banking roll');
    assert.ok(model.joints.torsoGroup.rotation.z > 0.08, 'Torso must bank into turn with extra compliance');

    model.dispose();
});

test('playerModel sprint drops pelvis height to prevent knee lock and pops', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    // Walk state
    model.setLocomotion({ phase: 0, amount: 1.0, isSprinting: false });
    model.update();
    const walkPelvisY = model.joints.pelvisGroup.position.y;

    // Sprint state (with lower center of gravity)
    model.setLocomotion({ phase: 0, amount: 1.0, isSprinting: true });
    model.update();
    const sprintPelvisY = model.joints.pelvisGroup.position.y;

    assert.ok(sprintPelvisY < walkPelvisY, 'Sprint posture must lower pelvis for athletic stance and bent knees');
    assert.ok(Math.abs(walkPelvisY - sprintPelvisY - 0.045) < 1e-4, 'Pelvis drop must equal 0.045m at full sprint amount');

    model.dispose();
});

test('playerModel arms exhibit ragdoll pendulum follow with elbow flexion on forward swing', () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel({ scene, scale: 1.0 });

    // Step 1: Initialize neutral
    model.resetTargetsToStance();
    model.setLocomotion({ phase: Math.PI * 0.5, amount: 1.0, moveZ: 1 });
    model.update();

    // With phase = PI/2, armPhase = PI/2 - 0.25 -> armSwing > 0
    // Right arm swings forward (armSign = -s = -1 for right s=1? Wait, left s=-1 -> armSign = 1 forward)
    // Left hand swings forward: forwardOffset > 0, elbow flexes upward
    const leftHandY = model.ikTargets.leftHand.position.y;
    const baseHandY = model.pose.rootPosition.y + 0.82;

    assert.ok(leftHandY > baseHandY, 'Forward swinging arm must flex upward at elbow');
    assert.ok(Number.isFinite(model.ikTargets.leftHand.position.x));
    assert.ok(Number.isFinite(model.ikTargets.rightHand.position.z));

    model.dispose();
});
