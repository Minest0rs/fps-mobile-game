/** Minimal procedural sound effects layer. We synthesise short noise +
 *  oscillator bursts in the WebAudio graph rather than ship binary
 *  assets, keeping the bundle small and the sounds tweakable. The first
 *  call to any `play…` method lazily resumes the AudioContext (browser
 *  autoplay policy requires a user gesture before sound can start). */
export class Sounds {
  private ctx: AudioContext | null = null;
  /** Master gain — let users mute the whole game by setting `master` to 0. */
  private master = 0.6;
  /** Time-of-last-shot per weapon so rapid fire doesn't clip each other. */
  private lastShotAt = 0;
  /** Footstep cadence accumulator. */
  private stepAccum = 0;
  /** Underwater low-pass — adds a "muffled" feel while submerged. */
  private underwaterFilter: BiquadFilterNode | null = null;
  /** Drives the underwater bubble loop on/off. */
  private bubbleNode: AudioBufferSourceNode | null = null;
  private bubbleGain: GainNode | null = null;
  private outputNode: AudioNode | null = null;

  private ensureCtx(): AudioContext | null {
    if (!this.ctx) {
      // Some browsers expose the prefixed constructor only.
      const Ctor = (window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      });
      const C = Ctor.AudioContext ?? Ctor.webkitAudioContext;
      if (!C) return null;
      this.ctx = new C();
      // Build a master output: → underwaterFilter → destination so
      // we can switch the filter on/off without rewiring per-sound.
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 22000; // pass-through above water
      filter.connect(this.ctx.destination);
      this.underwaterFilter = filter;
      this.outputNode = filter;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  /** Switch the master output between dry (above water) and muffled
   *  (head submerged). Smoothly ramps the cutoff so transitions don't
   *  click. */
  setUnderwater(under: boolean) {
    const ctx = this.ensureCtx();
    if (!ctx || !this.underwaterFilter) return;
    const target = under ? 600 : 22000;
    const now = ctx.currentTime;
    this.underwaterFilter.frequency.cancelScheduledValues(now);
    this.underwaterFilter.frequency.linearRampToValueAtTime(target, now + 0.12);
  }

  /** Short, low-pitched clack for weapon fire. Pitch follows the
   *  weapon's caliber (sniper = low boom, pistol = sharp click). */
  playShot(weaponId: string) {
    const ctx = this.ensureCtx();
    if (!ctx || !this.outputNode) return;
    // Prevent the same shot stacking on top of itself within 30 ms —
    // avoids buzzy clipping on auto-fire weapons.
    if (ctx.currentTime - this.lastShotAt < 0.018) return;
    this.lastShotAt = ctx.currentTime;
    const dur = 0.12;
    const now = ctx.currentTime;
    // Noise burst — the "crack" of the shot.
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const noiseHP = ctx.createBiquadFilter();
    noiseHP.type = "highpass";
    noiseHP.frequency.value = 800;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = this.master * 0.5;
    noise.connect(noiseHP).connect(noiseGain).connect(this.outputNode);
    noise.start(now);
    noise.stop(now + dur);

    // Low thump — body of the shot. Different per weapon.
    const profile: Record<string, { freq: number; gain: number; dur: number }> = {
      pistol:  { freq: 220, gain: 0.30, dur: 0.06 },
      rifle:   { freq: 150, gain: 0.45, dur: 0.10 },
      smg:     { freq: 240, gain: 0.32, dur: 0.05 },
      shotgun: { freq:  90, gain: 0.65, dur: 0.18 },
      sniper:  { freq:  70, gain: 0.85, dur: 0.30 },
    };
    const w = profile[weaponId] ?? profile.rifle;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(w.freq * 1.6, now);
    osc.frequency.exponentialRampToValueAtTime(w.freq, now + w.dur);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(this.master * w.gain, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + w.dur);
    osc.connect(oscGain).connect(this.outputNode);
    osc.start(now);
    osc.stop(now + w.dur);
  }

  /** Quick click + ratchet for the magazine drop / load. */
  playReload() {
    const ctx = this.ensureCtx();
    if (!ctx || !this.outputNode) return;
    const now = ctx.currentTime;
    [0, 0.18, 0.36].forEach((t) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = 1800 + Math.random() * 400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now + t);
      g.gain.linearRampToValueAtTime(this.master * 0.18, now + t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.05);
      osc.connect(g).connect(this.outputNode!);
      osc.start(now + t);
      osc.stop(now + t + 0.06);
    });
  }

  /** Soft low thump per footstep, modulated by speed. Call every frame
   *  with `(speed, dt, grounded)`; the helper keeps an internal cadence
   *  accumulator so you only get a sound at footstep intervals. */
  tickFootsteps(speed: number, dt: number, grounded: boolean, underwater: boolean) {
    if (!grounded || speed < 1.5 || underwater) {
      this.stepAccum = 0;
      return;
    }
    // Faster cadence at higher speeds.
    const cadence = 0.35 - Math.min(0.15, speed * 0.03);
    this.stepAccum += dt;
    if (this.stepAccum >= cadence) {
      this.stepAccum = 0;
      this.playStep();
    }
  }

  private playStep() {
    const ctx = this.ensureCtx();
    if (!ctx || !this.outputNode) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 70 + Math.random() * 40;
    const g = ctx.createGain();
    g.gain.setValueAtTime(this.master * 0.18, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.10);
    osc.connect(g).connect(this.outputNode);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** Splash on entering / leaving water. */
  playSplash() {
    const ctx = this.ensureCtx();
    if (!ctx || !this.outputNode) return;
    const now = ctx.currentTime;
    const dur = 0.35;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.pow(1 - i / data.length, 1.4);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, now);
    lp.frequency.exponentialRampToValueAtTime(200, now + dur);
    const g = ctx.createGain();
    g.gain.value = this.master * 0.55;
    noise.connect(lp).connect(g).connect(this.outputNode);
    noise.start(now);
    noise.stop(now + dur);
  }

  /** Distant rolling thunder. Triggered on lightning flashes. */
  playThunder() {
    const ctx = this.ensureCtx();
    if (!ctx || !this.outputNode) return;
    const now = ctx.currentTime;
    const dur = 1.6;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      const env = Math.exp(-t * 1.6) * (0.6 + 0.4 * Math.sin(t * 6));
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.value = this.master * 0.7;
    noise.connect(lp).connect(g).connect(this.outputNode);
    noise.start(now);
    noise.stop(now + dur);
  }

  /** Hit confirmation — short metallic ping at a high frequency so it
   *  cuts through the gun fire. */
  playHit() {
    const ctx = this.ensureCtx();
    if (!ctx || !this.outputNode) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(this.master * 0.32, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(g).connect(this.outputNode);
    osc.start(now);
    osc.stop(now + 0.10);
  }
}
