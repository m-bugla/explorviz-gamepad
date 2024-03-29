import * as THREE from 'three';
import { AxisMapping, ButtonMapping } from './gamepad-mappings'; 
import { Position2D } from 'explorviz-frontend/modifiers/interaction-modifier';

/**
 * Convert an angle given in degrees to radians
 * @param degrees An angle measured in degrees
 * @returns The same angle, but measured in radians
 */
const degreesToRadians = (degrees: number): number => {
  return degrees * (Math.PI / 180);
}

/**
 * Checks an axis position against a fixed threshold to filter out small disturbances
 * @param axis_value The gamepad axis position to be checked against deadzone
 * @returns `axis_value` if outside the deadzone threshold, otherwise 0
 */
const deadzone_clamp = (axis_value: number): number => {
  return (Math.abs(axis_value) > DEADZONE_THRESHOLD) ? axis_value : 0;
}

interface ButtonState {
  [button: number]: boolean;
}

/**
 * How far a joystick / analog trigger has to be moved in any given direction
 * for it to register. This value should be in the range from 0 to 1
 */
const DEADZONE_THRESHOLD: number = 0.1;

/**
 * Speed multiplier for how many units the camera should move in the lateral
 * directions per animation frame
 */
const SPEED_HORIZONTAL: number = 0.03;

/**
 * Speed multiplier for how many units the camera should move up or down
 * per animation frame
 */
const SPEED_VERTICAL: number = 0.03;

/**
 * How many degrees the camera should rotate per frame if direction is held
 */
const ROTATION_ANGLE: number = degreesToRadians(2);

/**
 * This caps the rotation in the up / down direction to avoid the possibility
 * of the camera turning upside-down
 */
const ROTATION_VMAX: number = degreesToRadians(80);

/**
 * Use a fixed popup position for now. One could perhaps imagine moving popups
 * using the dpad, however this is not implemented as of yet
 */
const POPUP_POSITION: Position2D = {x: 100, y: 100};

export type GamepadInteractionCallbacks = {
  lookAt?(intersection: THREE.Intersection | null): void;
  select?(intersection: THREE.Intersection): void;
  interact?(intersection: THREE.Intersection): void;
  inspect?(intersection: THREE.Intersection, canvasPos: Position2D): void;
}

export default class GamepadControls {

  private connectedGamepads: any = {};
  private active: boolean = false;

  private camera: THREE.Camera;
  private scene: THREE.Scene;
  private angleH: number = 0;
  private angleV: number = 0;
  private rotationMatrix: THREE.Matrix4 = new THREE.Matrix4();
  private moveDirection: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  private buttonPressed: ButtonState = {} as ButtonState;
  private buttonJustPressed: ButtonState = {} as ButtonState;
  private callbacks: GamepadInteractionCallbacks;

  constructor(object: THREE.Camera, scene: THREE.Scene, callbacks: GamepadInteractionCallbacks) {
    this.camera = object;
    this.scene = scene;
    this.callbacks = callbacks;

    if (typeof navigator.getGamepads !== 'function') {
      console.log('Error: Gamepad API might not be supported on this browser');
    } else {
      window.addEventListener(
        'gamepadconnected', this.onGamepadConnected.bind(this), false);
      window.addEventListener(
        'gamepaddisconnected', this.onGamepadDisconnected.bind(this), false);

      for (const button in ButtonMapping) {
        if (isNaN(Number(button))) {  // Enum contains both the names and values
          continue;
        }

        this.buttonPressed[button] = false;
        this.buttonJustPressed[button] = false;
      }
    }
  }

  public activate() {
    if (!this.active) {
      this.active = true;
      this.update();
    }
  }

  private deactivate() {
    this.active = false;
  }

  private update() {
    this.pollGamepads();

    if (this.active) {
      requestAnimationFrame(this.update.bind(this));
    }
  }

  private pollGamepads() {
    if (typeof navigator.getGamepads !== 'function') {
      console.log('Error: Could not call navigator.getGamepads()');
      return;
    }

    const gamepads = navigator.getGamepads();

    if (!gamepads || !gamepads[0]) {
      console.log('Error: No connected gamepad could be found');
      return;
    }

    const gp = gamepads[0];

    const STICK_RIGHT_H = deadzone_clamp(gp.axes[AxisMapping.StickRightH]);
    const STICK_RIGHT_V = deadzone_clamp(gp.axes[AxisMapping.StickRightV]);
    const STICK_LEFT_H = deadzone_clamp(gp.axes[AxisMapping.StickLeftH]);
    const STICK_LEFT_V = deadzone_clamp(gp.axes[AxisMapping.StickLeftV]);

    // Update button presses

    for (const button in ButtonMapping) {
      if (isNaN(Number(button))) { // Enum contains both the names and values
        continue;
      }

      this.buttonJustPressed[button] = !this.buttonPressed[button]
                                    && gp.buttons[button].value > 0;
      this.buttonPressed[button] = gp.buttons[button].value > 0;
    }

    //////////////
    // Movement //
    //////////////

    // Rotate according to right stick movement

    this.angleH += ROTATION_ANGLE * STICK_RIGHT_H;
    this.angleV -= ROTATION_ANGLE * STICK_RIGHT_V;

    // Clamp Y rotation to prevent turning upside-down
    this.angleV = Math.max(
      Math.min(this.angleV, ROTATION_VMAX),
      -ROTATION_VMAX
    );

    this.rotationMatrix = new THREE.Matrix4(
      Math.cos(this.angleH), 0, -Math.sin(this.angleH), 0,
               0,            1,           0,            0,
      Math.sin(this.angleH), 0,  Math.cos(this.angleH), 0,
               0,            0,           0,            1
    ).multiply(new THREE.Matrix4(
      1,          0,                      0,            0,
      0, Math.cos(this.angleV), -Math.sin(this.angleV), 0,
      0, Math.sin(this.angleV),  Math.cos(this.angleV), 0,
      0,          0,                      0,            1
    ));

    this.camera.setRotationFromMatrix(this.rotationMatrix);

    // Apply lateral movement according to left stick in camera space.
    // Create a basis vector to transform using camera's rotation

    this.moveDirection.set(STICK_LEFT_H, 0, STICK_LEFT_V);

    this.moveDirection.applyMatrix4(this.rotationMatrix);

    // The more the stick is pressed, the faster the camera should move
    const AXIS_SCALE = Math.sqrt(STICK_LEFT_H ** 2 + STICK_LEFT_V ** 2);

    // Scale directional vector with speed constant. Note we do not want to
    // apply vertical movement if camera faces downward
    this.moveDirection.setY(0)
      .normalize()
      .multiplyScalar(AXIS_SCALE)
      .multiplyScalar(SPEED_HORIZONTAL);

    // Apply vertical movement if face buttons are pressed
    const BUTTON_UP: number = gp.buttons[ButtonMapping.FaceDown].value > 0 ? 1 : 0;
    const BUTTON_DOWN: number = gp.buttons[ButtonMapping.FaceRight].value > 0 ? 1 : 0;

    // One button counts positive, one negative.
    // If both buttons are pressed, they cancel out
    this.moveDirection.setY((BUTTON_UP - BUTTON_DOWN) * SPEED_VERTICAL);

    this.camera.position.add(this.moveDirection);
    
    ////////////////////////
    // Object Interaction //
    ////////////////////////

    // Raycast to find which mesh we are looking at

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersections = raycaster.intersectObjects(this.scene.children, true);

    // Find the closest object which is visible. Raycaster.intersectObjects()
    // sorts objects by distance, but some intersected objects may be invisible
    
    let objClosest = null;

    if (intersections) {
      for (const intersection of intersections) {
        if (intersection.object.visible) {
          objClosest = intersection;
          break;
        }
      }
    }

    // Highlight looked-at object. If objClosest is null, we unhighlight all
    if (this.callbacks.lookAt) {
      this.callbacks.lookAt(objClosest);
    }

    if (objClosest) {
      if (this.buttonJustPressed[ButtonMapping.ShoulderLeft]) {
        if (this.callbacks.select) {
          this.callbacks.select(objClosest);  
        }
      }

      if (this.buttonJustPressed[ButtonMapping.ShoulderRight]) {
        if (this.callbacks.interact) {
          this.callbacks.interact(objClosest);
        }
      }

      if (this.buttonJustPressed[ButtonMapping.TriggerLeft]) {
        if (this.callbacks.inspect) {
          this.callbacks.inspect(objClosest, POPUP_POSITION);
        }
      }
    }
  }

  private onGamepadConnected(event: GamepadEvent) {
    console.log(event);
    this.connectedGamepads[event.gamepad.id] = event.gamepad;
    this.activate();
  }

  private onGamepadDisconnected(event: GamepadEvent) {
    console.log(event);
    delete this.connectedGamepads[event.gamepad.id];
    if (Object.keys(this.connectedGamepads).length == 0)
      this.deactivate();
  }

  public setRotation(newAngleH: number, newAngleV: number) {
    this.angleH = newAngleH;
    this.angleV = newAngleV;
  }
}
