/** Unified input layer used by the controller. Sources: keyboard+mouse on desktop,
 *  touch joystick + drag-to-look + on-screen buttons on mobile. */

export interface InputState {
  move: { x: number; y: number };
  lookDelta: { x: number; y: number };
  fireHeld: boolean;
  jumpRequested: boolean;
  toggleScoreboard: boolean;
}

export class InputManager {
  private state: InputState = {
    move: { x: 0, y: 0 },
    lookDelta: { x: 0, y: 0 },
    fireHeld: false,
    jumpRequested: false,
    toggleScoreboard: false,
  };

  // keyboard
  private keys = new Set<string>();

  // touch joystick
  private joystickActive = false;
  private joystickPointer = -1;
  private joystickCenter = { x: 0, y: 0 };
  private joystickValue = { x: 0, y: 0 };

  // touch look
  private lookPointer = -1;
  private lookLast = { x: 0, y: 0 };

  // pointer-lock mouse
  private pointerLocked = false;

  /** Sensitivity multipliers for desktop and mobile look. */
  private mouseSens = 0.0022;
  private touchSens = 0.005;

  constructor(
    private canvas: HTMLElement,
    private ui: {
      joystickBase: HTMLElement;
      joystickHandle: HTMLElement;
      lookArea: HTMLElement;
      fireButton: HTMLElement;
      jumpButton: HTMLElement;
      scoreboardButton: HTMLElement;
    },
  ) {
    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
  }

  /** Read-and-clear semantic events; called once per frame by the game loop. */
  consume(): InputState {
    const keyMove = readKeyMove(this.keys);
    const move = magnitude(keyMove) > 0.05 ? keyMove : this.joystickValue;
    const out: InputState = {
      move: { ...move },
      lookDelta: { ...this.state.lookDelta },
      fireHeld: this.state.fireHeld,
      jumpRequested: this.state.jumpRequested,
      toggleScoreboard: this.state.toggleScoreboard,
    };
    this.state.lookDelta = { x: 0, y: 0 };
    this.state.jumpRequested = false;
    this.state.toggleScoreboard = false;
    return out;
  }

  requestPointerLock() {
    if (!this.pointerLocked) this.canvas.requestPointerLock?.();
  }

  private bindKeyboard() {
    addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") this.state.jumpRequested = true;
      if (e.code === "Tab") { e.preventDefault(); this.state.toggleScoreboard = true; }
    });
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });
    addEventListener("blur", () => this.keys.clear());
  }

  private bindMouse() {
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.state.fireHeld = true;
    });
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.state.fireHeld = false;
    });
    addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.state.lookDelta.x += e.movementX * this.mouseSens;
      this.state.lookDelta.y += e.movementY * this.mouseSens;
    });
  }

  private bindTouch() {
    const { joystickBase, joystickHandle, lookArea, fireButton, jumpButton, scoreboardButton } = this.ui;
    const radius = 60;

    joystickBase.addEventListener("pointerdown", (e) => {
      this.joystickActive = true;
      this.joystickPointer = e.pointerId;
      const rect = joystickBase.getBoundingClientRect();
      this.joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      joystickBase.setPointerCapture(e.pointerId);
      this.updateJoystick(e.clientX, e.clientY, radius, joystickHandle);
    });
    joystickBase.addEventListener("pointermove", (e) => {
      if (!this.joystickActive || e.pointerId !== this.joystickPointer) return;
      this.updateJoystick(e.clientX, e.clientY, radius, joystickHandle);
    });
    const endJoystick = (e: PointerEvent) => {
      if (e.pointerId !== this.joystickPointer) return;
      this.joystickActive = false;
      this.joystickPointer = -1;
      this.joystickValue = { x: 0, y: 0 };
      joystickHandle.style.transform = "translate(-50%, -50%)";
    };
    joystickBase.addEventListener("pointerup", endJoystick);
    joystickBase.addEventListener("pointercancel", endJoystick);

    lookArea.addEventListener("pointerdown", (e) => {
      this.lookPointer = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      lookArea.setPointerCapture(e.pointerId);
    });
    lookArea.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.lookPointer) return;
      const dx = e.clientX - this.lookLast.x;
      const dy = e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
      this.state.lookDelta.x += dx * this.touchSens;
      this.state.lookDelta.y += dy * this.touchSens;
    });
    const endLook = (e: PointerEvent) => {
      if (e.pointerId === this.lookPointer) this.lookPointer = -1;
    };
    lookArea.addEventListener("pointerup", endLook);
    lookArea.addEventListener("pointercancel", endLook);

    fireButton.addEventListener("pointerdown", () => { this.state.fireHeld = true; });
    fireButton.addEventListener("pointerup",   () => { this.state.fireHeld = false; });
    fireButton.addEventListener("pointercancel",() => { this.state.fireHeld = false; });
    jumpButton.addEventListener("pointerdown", () => { this.state.jumpRequested = true; });
    scoreboardButton.addEventListener("pointerdown", () => { this.state.toggleScoreboard = true; });
  }

  private updateJoystick(cx: number, cy: number, radius: number, handle: HTMLElement) {
    let dx = cx - this.joystickCenter.x;
    let dy = cy - this.joystickCenter.y;
    const len = Math.hypot(dx, dy);
    if (len > radius) { dx = (dx / len) * radius; dy = (dy / len) * radius; }
    this.joystickValue = { x: dx / radius, y: -dy / radius };
    handle.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
}

function readKeyMove(keys: Set<string>): { x: number; y: number } {
  let x = 0, y = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) y += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) y -= 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  return { x, y };
}

function magnitude(v: { x: number; y: number }) { return Math.hypot(v.x, v.y); }
