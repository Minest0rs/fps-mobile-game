/** Unified input layer used by the controller. Sources: keyboard+mouse on desktop,
 *  touch joystick + drag-to-look + on-screen buttons on mobile. */

export interface InputState {
  move: { x: number; y: number };
  lookDelta: { x: number; y: number };
  fireHeld: boolean;
  aimHeld: boolean;
  jumpRequested: boolean;
  /** Held-down state of jump (Space / on-screen jump button). Used
   *  underwater to swim upward as long as it's pressed. */
  jumpHeld: boolean;
  toggleScoreboard: boolean;
}

export class InputManager {
  private state: InputState = {
    move: { x: 0, y: 0 },
    lookDelta: { x: 0, y: 0 },
    fireHeld: false,
    aimHeld: false,
    jumpRequested: false,
    jumpHeld: false,
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
      joystickZone: HTMLElement;
      lookArea: HTMLElement;
      fireButton: HTMLElement;
      fireButtonLeft: HTMLElement;
      aimButton: HTMLElement;
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
      aimHeld: this.state.aimHeld,
      jumpRequested: this.state.jumpRequested,
      jumpHeld: this.state.jumpHeld,
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
      if (e.code === "Space") {
        this.state.jumpRequested = true;
        this.state.jumpHeld = true;
      }
      if (e.code === "Tab") { e.preventDefault(); this.state.toggleScoreboard = true; }
    });
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "Space") this.state.jumpHeld = false;
    });
    addEventListener("blur", () => this.keys.clear());
  }

  private bindMouse() {
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.state.fireHeld = true;
      if (e.button === 2) { e.preventDefault(); this.state.aimHeld = true; }
    });
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.state.fireHeld = false;
      if (e.button === 2) this.state.aimHeld = false;
    });
    // Right-click context menu would otherwise interrupt aim-down-sights.
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.state.lookDelta.x += e.movementX * this.mouseSens;
      this.state.lookDelta.y += e.movementY * this.mouseSens;
    });
  }

  private bindTouch() {
    const { joystickBase, joystickHandle, joystickZone, lookArea,
            fireButton, fireButtonLeft, aimButton, jumpButton, scoreboardButton } = this.ui;
    const radius = 70;

    // Dynamic joystick: the joystick base/handle teleport to wherever the
    // first touch lands inside joystickZone (the left half of the screen).
    // This matches modern shooters where the joystick anchors to your thumb
    // rather than to a fixed screen position.
    joystickZone.addEventListener("pointerdown", (e) => {
      if (this.joystickActive) return;
      this.joystickActive = true;
      this.joystickPointer = e.pointerId;
      this.joystickCenter = { x: e.clientX, y: e.clientY };
      joystickBase.style.left = `${e.clientX}px`;
      joystickBase.style.top  = `${e.clientY}px`;
      joystickBase.classList.add("active");
      joystickZone.setPointerCapture(e.pointerId);
      this.updateJoystick(e.clientX, e.clientY, radius, joystickHandle);
    });
    joystickZone.addEventListener("pointermove", (e) => {
      if (!this.joystickActive || e.pointerId !== this.joystickPointer) return;
      this.updateJoystick(e.clientX, e.clientY, radius, joystickHandle);
    });
    const endJoystick = (e: PointerEvent) => {
      if (e.pointerId !== this.joystickPointer) return;
      this.joystickActive = false;
      this.joystickPointer = -1;
      this.joystickValue = { x: 0, y: 0 };
      joystickHandle.style.transform = "";
      joystickBase.classList.remove("active");
    };
    joystickZone.addEventListener("pointerup", endJoystick);
    joystickZone.addEventListener("pointercancel", endJoystick);

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

    // Two fire buttons (one per thumb). Each tracks its own pointer so
    // releasing one doesn't cancel a fire-hold on the other.
    const fireDownIds = new Set<number>();
    const bindFire = (btn: HTMLElement) => {
      btn.addEventListener("pointerdown", (e) => {
        fireDownIds.add(e.pointerId);
        this.state.fireHeld = true;
      });
      const release = (e: PointerEvent) => {
        fireDownIds.delete(e.pointerId);
        if (fireDownIds.size === 0) this.state.fireHeld = false;
      };
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
    };
    bindFire(fireButton);
    bindFire(fireButtonLeft);

    aimButton.addEventListener("pointerdown",  () => { this.state.aimHeld = true; });
    aimButton.addEventListener("pointerup",    () => { this.state.aimHeld = false; });
    aimButton.addEventListener("pointercancel",() => { this.state.aimHeld = false; });
    jumpButton.addEventListener("pointerdown", () => {
      this.state.jumpRequested = true;
      this.state.jumpHeld = true;
    });
    jumpButton.addEventListener("pointerup", () => { this.state.jumpHeld = false; });
    jumpButton.addEventListener("pointercancel", () => { this.state.jumpHeld = false; });
    scoreboardButton.addEventListener("pointerdown", () => { this.state.toggleScoreboard = true; });
  }

  private updateJoystick(cx: number, cy: number, radius: number, handle: HTMLElement) {
    let dx = cx - this.joystickCenter.x;
    let dy = cy - this.joystickCenter.y;
    const len = Math.hypot(dx, dy);
    if (len > radius) { dx = (dx / len) * radius; dy = (dy / len) * radius; }
    this.joystickValue = { x: dx / radius, y: -dy / radius };
    // CSS already centres the handle (margin-left/top: -30px); only apply
    // the displacement so the handle visually tracks the thumb.
    handle.style.transform = `translate(${dx}px, ${dy}px)`;
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
