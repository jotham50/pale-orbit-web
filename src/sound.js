/*
 * Procedurally synthesised sound effects (a port of sound.py).
 *
 * Every sound is generated from scratch at start-up using the same recipes
 * as the Python version, then played through the Web Audio API.
 */
(function (root) {
  "use strict";
  const { PyRandom } = (typeof module !== "undefined" && module.exports)
    ? require("./rng.js") : root.PO;

  const RATE = 22050;
  const n = (seconds) => Math.floor(seconds * RATE);

  function tone(f0, f1, seconds, shape = "sine", curve = 1.0) {
    const len = n(seconds), out = new Float32Array(len);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / Math.max(1, len - 1);
      const f = f0 * (f1 / f0) ** (t ** curve);
      phase = (phase + f / RATE) % 1.0;
      let v;
      if (shape === "sine") v = Math.sin(2 * Math.PI * phase);
      else if (shape === "square") v = phase < 0.5 ? 1 : -1;
      else if (shape === "saw") v = 2 * phase - 1;
      else v = 4 * Math.abs(phase - 0.5) - 1;
      out[i] = v;
    }
    return out;
  }

  function noise(seconds, seed = 0) {
    const rng = new PyRandom(seed), len = n(seconds), out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = rng.uniform(-1, 1);
    return out;
  }

  function lowpass(s, c0, c1 = c0) {
    const out = new Float32Array(s.length);
    let y = 0;
    for (let i = 0; i < s.length; i++) {
      const c = c0 + (c1 - c0) * i / Math.max(1, s.length - 1);
      const a = 1 - Math.exp(-2 * Math.PI * c / RATE);
      y += a * (s[i] - y);
      out[i] = y;
    }
    return out;
  }

  function envelope(s, attack = 0.005, release = null, decayPower = 1.0) {
    const len = s.length, a = Math.max(1, n(attack)), out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const g = i < a ? i / a : (1 - (i - a) / Math.max(1, len - a)) ** decayPower;
      out[i] = s[i] * g;
    }
    if (release !== null) {
      const r = n(release);
      for (let i = Math.max(0, len - r); i < len; i++) out[i] *= (len - i) / r;
    }
    return out;
  }

  function mix(tracks, gains) {
    gains = gains || tracks.map(() => 1);
    const len = Math.max(...tracks.map((t) => t.length)), out = new Float32Array(len);
    tracks.forEach((t, k) => { for (let i = 0; i < t.length; i++) out[i] += t[i] * gains[k]; });
    return out;
  }

  function concat(...tracks) {
    const len = tracks.reduce((s, t) => s + t.length, 0), out = new Float32Array(len);
    let o = 0;
    for (const t of tracks) { out.set(t, o); o += t.length; }
    return out;
  }

  const silence = (seconds) => new Float32Array(n(seconds));

  function normalise(s, peak = 0.9) {
    let m = 0;
    for (const v of s) m = Math.max(m, Math.abs(v));
    m = m || 1;
    return s.map((v) => v * peak / m);
  }

  function loopCrossfade(s, fade = 0.08) {
    const f = n(fade), body = s.slice(0, s.length - f), tail = s.slice(s.length - f);
    for (let i = 0; i < f; i++) { const w = i / f; body[i] = body[i] * w + tail[i] * (1 - w); }
    return body;
  }

  const scale = (s, g) => s.map((v) => v * g);

  const RECIPES = {
    laser: () => envelope(lowpass(tone(1800, 220, 0.22, "square", 0.5), 6000, 1500),
                          0.002, null, 2),
    explosion: () => envelope(mix([lowpass(noise(1.3, 1), 2400, 120), tone(90, 35, 1.3)],
                                  [1.0, 0.8]), 0.004, null, 2.5),
    rebuild: () => {
      const parts = [330, 415, 494, 659, 831].map(
        (f) => envelope(tone(f, f * 1.01, 0.18, "triangle"), 0.005, null, 1.5));
      const shimmer = concat(...parts);
      return mix([shimmer, envelope(lowpass(noise(shimmer.length / RATE, 2), 5000),
                                    0.005, null, 3)], [0.8, 0.12]);
    },
    sentry_shot: () => envelope(lowpass(tone(520, 140, 0.28, "saw", 0.6), 3000, 800),
                                0.003, null, 1.8),
    hit: () => envelope(mix([lowpass(noise(0.35, 3), 900, 150), tone(120, 50, 0.35)]),
                        0.002, null, 2),
    jetpack: () => loopCrossfade(mix([lowpass(noise(1.6, 4), 1400), lowpass(noise(1.6, 5), 180)],
                                     [0.6, 1.0])),
    drone: () => loopCrossfade(lowpass(mix([tone(55, 55, 4, "saw"), tone(55.6, 55.6, 4, "saw"),
                                            tone(82.5, 82.5, 4)], [0.5, 0.5, 0.4]), 420), 0.3),
    switch: () => concat(envelope(lowpass(noise(0.05, 6), 4000), 0.001, null, 3),
                         scale(envelope(tone(880, 1320, 0.09, "square"), 0.002, null, 2), 0.4)),
    power_up: () => concat(
      envelope(lowpass(tone(110, 880, 1.1, "saw", 0.7), 400, 4000), 0.05, null, 0.5),
      envelope(mix([tone(440, 440, 0.7, "triangle"), tone(554, 554, 0.7, "triangle"),
                    tone(659, 659, 0.7, "triangle")]), 0.01, null, 1.5)),
    whoosh: () => {
      let w = lowpass(noise(0.9, 7), 300, 5000);
      w = w.map((v, i) => v * Math.sin(Math.PI * i / w.length));
      return mix([w, tone(200, 1600, 0.9, "sine", 0.6)], [1.0, 0.15]);
    },
    pickup: () => concat(envelope(tone(988, 988, 0.08, "triangle")),
                         envelope(tone(1319, 1319, 0.2, "triangle"), 0.005, null, 1.5)),
    denied: () => envelope(mix([tone(110, 104, 0.4, "square"), tone(116, 110, 0.4, "square")]),
                           0.01, 0.05, 0.6),
    deflect: () => envelope(mix([tone(2400, 2300, 0.4), tone(3100, 3000, 0.4)], [1, 0.5]),
                            0.001, null, 3),
    beep: () => concat(envelope(tone(1046, 1046, 0.12, "square"), 0.005, 0.02, 0.3),
                       silence(0.06),
                       envelope(tone(1046, 1046, 0.12, "square"), 0.005, 0.02, 0.3)),
    fanfare: () => concat(...[[523, 0.14], [659, 0.14], [784, 0.14], [1046, 0.5]].map(
      ([f, d]) => envelope(mix([tone(f, f, d, "triangle"), tone(f * 2, f * 2, d)], [1, 0.3]),
                           0.005, null, 1.2))),
    lance_fire: () => concat(
      envelope(lowpass(tone(80, 900, 1.0, "saw", 0.4), 300, 3000), 0.5, null, 0.2),
      envelope(mix([lowpass(noise(2.5, 8), 3000, 80), tone(60, 25, 2.5)]), 0.003, null, 2)),
  };

  /** Plays the effects; keeps the looping jetpack hiss and Lance drone running. */
  class SoundBoard {
    constructor() {
      this.muted = false;
      this.master = 0.8;
      this.ctx = null;
      this.buffers = {};
    }

    /** Must be called from a user gesture (browsers block audio until then). */
    start() {
      if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      for (const [name, recipe] of Object.entries(RECIPES)) {
        const data = normalise(recipe());
        const buf = this.ctx.createBuffer(1, data.length, RATE);
        buf.copyToChannel(data, 0);
        this.buffers[name] = buf;
      }
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.5;
      this.out.connect(this.ctx.destination);
      this.loops = {};
      for (const name of ["jetpack", "drone"]) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.buffers[name];
        src.loop = true;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain).connect(this.out);
        src.start();
        this.loops[name] = { src, gain };
      }
    }

    play(name, volume = 1.0, pitch = 1.0) {
      if (!this.ctx || this.muted || volume <= 0.01 || !this.buffers[name]) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers[name];
      src.playbackRate.value = pitch;
      const gain = this.ctx.createGain();
      gain.gain.value = volume * this.master;
      src.connect(gain).connect(this.out);
      src.start();
    }

    setLoops(jet, drone, dronePitch) {
      if (!this.ctx) return;
      const g = this.muted ? 0 : this.master;
      const t = this.ctx.currentTime;
      this.loops.jetpack.gain.gain.setTargetAtTime(jet * g, t, 0.03);
      this.loops.drone.gain.gain.setTargetAtTime(drone * g, t, 0.1);
      this.loops.drone.src.playbackRate.setTargetAtTime(dronePitch, t, 0.2);
    }

    toggleMute() { this.muted = !this.muted; return this.muted; }
  }

  const api = { SoundBoard, SOUND_RECIPES: RECIPES, SOUND_RATE: RATE, normaliseSound: normalise };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PO = Object.assign(root.PO || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
