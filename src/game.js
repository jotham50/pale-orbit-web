/*
 * Pale Orbit: three.js front end (a port of game.py).
 *
 * All rules live in logic.js. This file builds the sector you are standing
 * in, moves the player, draws the HUD and the map, and feeds actions to the
 * Moon.
 *
 * Coordinates: the rules (and the Python version) use a left-handed, y-up
 * frame where +z is "north". three.js is right-handed, so every position is
 * mapped (x, y, z) -> (x, y, -z) and every yaw angle is negated. The world
 * then looks exactly as it does in the Python version.
 */
(function (root) {
  "use strict";
  const PO = root.PO;
  const { Moon, LATTICE_COLOURS, SECTOR_HALF_SIZE, gatePosition, toLocal, formatTime,
          Textures, SoundBoard } = PO;

  // ------------------------------------------------------------------------
  // Tunables (same values as the Python version)
  // ------------------------------------------------------------------------
  const GRAVITY = 7.0, THRUST = 17.0, MAX_RISE = 10.0, WALK_SPEED = 9.0;
  const EYE_HEIGHT = 2.7, CEILING = 45.0, SHOT_COOLDOWN = 0.22;
  const SENTRY_RANGE = 48.0, SENTRY_COOLDOWN = 1.2, BOLT_SPEED = 30.0, BOLT_DAMAGE = 14.0;
  const PLANET_DIRECTION = PO.norm([-0.35, 0.55, -0.76]);
  const BINARY_BITS = 10;
  const DEG = Math.PI / 180;
  const SAVE_KEY = "pale_orbit_save";

  /** How many rectangles are red counting down from the top of the counter
   *  (0..10). It only ever goes up, faster and faster towards the end. */
  function lanceStage(charge, bits = BINARY_BITS) {
    const v = binaryCounter(charge, bits);
    let n = 0;
    for (let i = bits - 1; i >= 0 && (v >> i & 1); i--) n++;
    return n;
  }

  function binaryCounter(charge, bits = BINARY_BITS) {
    const top = (1 << bits) - 1;
    return charge >= 1 ? top : Math.min(top - 1, Math.floor(charge * top + 1e-6));
  }

  // ------------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------------
  const V = (x, y, z) => new THREE.Vector3(x, y, -z);          // rules -> three
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + (b - a) * Math.random();
  const rgbCss = (c, a = 1) =>
    `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

  function hsv(h, s, v) {
    h = ((h % 360) + 360) % 360 / 60;
    const i = Math.floor(h), f = h - i;
    const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  }
  const scaleRgb = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

  // shared geometries (never disposed)
  const GEO = {
    box: new THREE.BoxGeometry(1, 1, 1),
    sphere: new THREE.SphereGeometry(0.5, 24, 16),
    ico: new THREE.IcosahedronGeometry(0.5, 1),
    circle: new THREE.CircleGeometry(0.5, 32),
    quad: new THREE.PlaneGeometry(1, 1),
  };
  GEO.octa = (() => {
    const top = [0, 1, 0], bot = [0, -1, 0];
    const ring = [[0.55, 0, 0], [0, 0, 0.55], [-0.55, 0, 0], [0, 0, -0.55]];
    const pos = [], col = [];
    for (let i = 0; i < 4; i++) {
      const a = ring[i], b = ring[(i + 1) % 4];
      for (const [tri, shade] of [[[top, a, b], 1.0], [[bot, b, a], 0.6]]) {
        for (const v of tri) { pos.push(v[0], v[1], -v[2]); col.push(shade, shade, shade); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  })();

  function litMat(c, extra = {}) {
    return new THREE.MeshLambertMaterial(Object.assign(
      { color: new THREE.Color(c[0], c[1], c[2]), flatShading: true }, extra));
  }
  function unlitMat(c, a = 1, extra = {}) {
    const m = new THREE.MeshBasicMaterial(Object.assign(
      { color: new THREE.Color(c[0], c[1], c[2]) }, extra));
    if (a < 1) { m.transparent = true; m.opacity = a; m.depthWrite = false; }
    return m;
  }

  /**
   * Make a mesh using the Python version's conventions: x/y/z in rule
   * coordinates, `bottom: true` for Ursina's origin_y=-0.5 (y is the base),
   * `rotY` in degrees as in Ursina.
   */
  function mk(parent, geo, mat, o = {}) {
    const m = new THREE.Mesh(geo, mat);
    let s = o.scale === undefined ? 1 : o.scale;
    if (typeof s === "number") s = [s, s, s];
    m.scale.set(s[0], s[1], s[2]);
    m.position.set(o.x || 0, (o.y || 0) + (o.bottom ? s[1] / 2 : 0), -(o.z || 0));
    if (o.rotY) m.rotation.y = -o.rotY * DEG;
    if (o.rot) m.rotation.set(o.rot[0] * DEG, -o.rot[1] * DEG, o.rot[2] * DEG);
    if (o.flat) m.rotation.x = -Math.PI / 2;     // circles/planes lying on the ground
    parent.add(m);
    return m;
  }

  function group(parent, x = 0, y = 0, z = 0, rotY = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, -z);
    g.rotation.y = -rotY * DEG;
    parent.add(g);
    return g;
  }

  // text rendered to a canvas, as a camera-facing sprite or a flat plane
  function textCanvas(text, color, alpha = 1) {
    const lines = String(text).split("\n");
    const px = 64, font = `bold ${px}px "DejaVu Sans Mono", Consolas, Menlo, monospace`;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.font = font;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 8) + 16;
    const h = lines.length * px * 1.15 + 8;
    c.width = Math.ceil(w); c.height = Math.ceil(h);
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgbCss(color, alpha);
    lines.forEach((l, i) => ctx.fillText(l, c.width / 2, 4 + px * 1.15 * (i + 0.5)));
    return { canvas: c, lines: lines.length };
  }

  function textSprite(parent, text, o = {}) {
    const { canvas, lines } = textCanvas(text, o.color || [1, 1, 1], o.alpha || 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.userData.own = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    const lineH = (o.scale || 18) * 0.07;
    const h = lines * lineH * 1.15;
    sp.scale.set(h * canvas.width / canvas.height, h, 1);
    sp.position.set(o.x || 0, o.y || 0, -(o.z || 0));
    sp.userData.textOpts = o;
    parent.add(sp);
    return sp;
  }

  function setSpriteText(sp, text) {
    const o = sp.userData.textOpts;
    const { canvas, lines } = textCanvas(text, o.color || [1, 1, 1], o.alpha || 1);
    sp.material.map.dispose();
    sp.material.map = new THREE.CanvasTexture(canvas);
    sp.material.map.minFilter = THREE.LinearFilter;
    sp.material.map.userData.own = true;
    sp.material.needsUpdate = true;
    const h = lines * (o.scale || 18) * 0.07 * 1.15;
    sp.scale.set(h * canvas.width / canvas.height, h, 1);
  }

  function textPlane(parent, text, o = {}) {
    const { canvas } = textCanvas(text, o.color || [1, 1, 1], o.alpha || 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.userData.own = true;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false,
                                              side: THREE.DoubleSide });
    const m = new THREE.Mesh(GEO.quad, mat);
    const h = o.height || 1;
    m.scale.set(h * canvas.width / canvas.height, h, 1);
    m.position.set(o.x || 0, o.y || 0, o.z3 !== undefined ? o.z3 : -(o.z || 0));
    if (o.rotY3) m.rotation.y = o.rotY3;
    parent.add(m);
    return m;
  }

  function glowSprite(parent, color, alpha, scale, o = {}) {
    const mat = new THREE.SpriteMaterial({ map: Textures.glow(), transparent: true,
                                           depthWrite: false,
                                           color: new THREE.Color(...color), opacity: alpha });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(scale, scale, 1);
    sp.position.set(o.x || 0, o.y || 0, -(o.z || 0));
    parent.add(sp);
    return sp;
  }

  /** Free GPU memory for a removed object. Shared geometries and the cached
   *  procedural textures are kept; per-object text textures are freed. */
  function disposeTree(obj) {
    obj.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map && m.map.userData.own) m.map.dispose();
          m.dispose();
        }
      }
      if (o.geometry && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose();
    });
  }

  function shadedSphereGeometry(lightDir, base, night, segments = 32) {
    const l = new THREE.Vector3(...lightDir).normalize();
    const pos = [], col = [], idx = [];
    for (let i = 0; i <= segments; i++) {
      const lat = Math.PI * (i / segments - 0.5);
      for (let j = 0; j <= segments; j++) {
        const lon = 2 * Math.PI * j / segments;
        const n = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
        pos.push(n[0] * 0.5, n[1] * 0.5, -n[2] * 0.5);
        const t = clamp((n[0] * l.x + n[1] * l.y + n[2] * l.z) * 1.6 + 0.15, 0, 1);
        const band = 0.08 * Math.sin(lat * 9 + Math.sin(lon * 3) * 1.5);
        for (let k = 0; k < 3; k++) col.push(clamp(lerp(night[k], base[k], t) + band * t, 0, 1));
      }
    }
    const w = segments + 1;
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < segments; j++) {
        const a = i * w + j, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    return g;
  }

  function starfield(count = 1400, radius = 900) {
    const rng = new PO.PyRandom(42);
    const pos = [], col = [];
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(rng.gauss(0, 1), Math.abs(rng.gauss(0, 1)) * 1.2 - 0.15,
                                  rng.gauss(0, 1)).normalize().multiplyScalar(radius);
      pos.push(v.x, v.y, -v.z);
      const b = rng.uniform(0.35, 1.0);
      const tint = rng.choice([[1, 1, 1], [0.8, 0.9, 1], [1, 0.9, 0.8]]);
      col.push(tint[0] * b, tint[1] * b, tint[2] * b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false,
                                                           vertexColors: true }));
  }

  // ------------------------------------------------------------------------
  // HUD (HTML overlay)
  // ------------------------------------------------------------------------
  const STORY = `KESSAR-4, a mining moon in orbit around the colony world Halcyon.

The foundry intelligence ARBITER has seized the moon's mass driver,
the Lance, and turned it on Halcyon. Prism cores on relay pylons
across all twenty sectors feed it power, linked together in lattices.

A destroyed core rebuilds itself if BOTH of its linked neighbours are
still alive. Find the end of each lattice and work inwards.
Some end cores are shielded by wards: find and shoot the breaker.
Sealed sectors can only be reached by transporter. Power one by
shooting its switches until every switch shows green. Vault gates
open when you solve the sliding-tile control wall beside them.
Refractor-shielded cores need a beam: turn the relays, then shoot the
emitter.

The sun circles the moon: sunlit cores feed the Lance fastest, and
sectors drift from day to night. Every core destroyed slows the
countdown. Chasms can only be crossed with the jetpack.`;

  const CONTROLS = "WASD move   MOUSE look   LMB fire   SPACE jetpack   SHIFT run\n" +
    "TAB map (pauses)   M mute   F5 save   F9 load   ESC pause   R new moon (after the end)";

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  class HUD {
    constructor(game) {
      this.game = game;
      const m = game.moon;
      this.root = el("div", "hud", document.getElementById("ui"));
      el("div", "crosshair", this.root);
      const top = el("div", "timerbox", this.root);
      el("div", "lance-label", top, "THE LANCE FIRES IN");
      this.timer = el("div", "timer", top);
      const pb = el("div", "powerbar", top);
      this.power = el("div", "powerfill", pb);
      this.powerText = el("div", "powertext", top);
      const tl = el("div", "topleft", this.root);
      this.sector = el("div", "sector", tl);
      this.sun = el("div", "sun", tl);
      this.droneText = el("div", "dronetext", tl);
      const bl = el("div", "bottomleft", this.root);
      this.shield = this._bar(bl, "SHIELD", "#4db3ff");
      this.fuel = this._bar(bl, "JETPACK", "#ff9933");
      const br = el("div", "bottomright", this.root);
      el("div", "lattitle", br, "LATTICES");
      this.rows = m.lattices.map((_, i) => {
        const row = el("div", "latrow", br);
        const sq = el("span", "latsq", row);
        sq.style.background = rgbCss(LATTICE_COLOURS[i]);
        const t = el("span", "lattext", row);
        return { sq, t };
      });
      const bits = el("div", "bits", this.root);
      el("div", "bitslabel", bits, "LANCE");
      this.bits = [];
      for (let i = BINARY_BITS - 1; i >= 0; i--) this.bits[i] = el("div", "bit", bits);
      this.msgs = el("div", "messages", this.root);
      el("div", "hint", this.root, "[TAB] map   [LMB] fire   [SPACE] jetpack   [M] mute");
    }

    _bar(parent, label, colour) {
      const wrap = el("div", "bar", parent);
      el("div", "barlabel", wrap, label);
      const back = el("div", "barback", wrap);
      const fill = el("div", "barfill", back);
      fill.style.background = colour;
      return fill;
    }

    say(msg, colour = [1, 1, 1], life = 4.5) {
      const e = el("div", "msg", null, msg);
      e.style.color = rgbCss(colour);
      this.msgs.prepend(e);
      setTimeout(() => e.classList.add("fade"), life * 1000);
      setTimeout(() => e.remove(), life * 1000 + 1100);
    }

    update() {
      const m = this.game.moon;
      const ttf = m.timeToFire;
      this.timer.textContent = formatTime(ttf);
      this.timer.style.color = ttf < 120 ? "#ff4d40" : "#fff";
      const value = binaryCounter(m.charge);
      this.bits.forEach((b, i) => b.classList.toggle("on", !!(value >> i & 1)));
      this.power.style.width = `${clamp(m.power, 0, 1) * 100}%`;
      this.powerText.textContent =
        `POWER ${(m.power * 100).toFixed(0).padStart(3)}%   CHARGE ${(m.charge * 100).toFixed(1).padStart(4)}%`;
      const sec = m.sectors[this.game.sectorId];
      this.sector.textContent = sec.name.toUpperCase();
      const out = PO.outputFor(sec.sunlight);
      const side = sec.sunlight > 0.05 ? "DAYSIDE" : "NIGHTSIDE";
      const trend = m.sunlightTrend(sec.id);
      const moving = trend > .005 ? "RISING" : trend < -.005 ? "SETTING" : "";
      this.sun.textContent = `${side}  SUN ${(sec.sunlight * 100).toFixed(0).padStart(3)}% ` +
        `${moving}  CORE OUTPUT x${out.toFixed(1)}`;
      const d = m.drone;
      if (d.enabled && d.active) {
        let txt, colour;
        if (!d.alive) {
          txt = `HUNTER DRONE: DOWN (${Math.max(0, d.respawnTimer).toFixed(0)}s)`;
          colour = [.6, 1, .7];
        } else {
          const dist = m.droneDistance();
          txt = dist === 0 ? "HUNTER DRONE: IN THIS SECTOR"
            : dist >= 99 ? "HUNTER DRONE: CAN'T REACH YOU HERE"
              : `HUNTER DRONE: ${dist} SECTOR${dist > 1 ? "S" : ""} AWAY`;
          colour = dist <= 1 ? [1, .3, .25] : [1, .7, .4];
        }
        this.droneText.textContent = txt;
        this.droneText.style.color = rgbCss(colour);
      } else {
        this.droneText.textContent = "";
      }
      this.shield.style.width = `${clamp(m.player.shield / PO.PlayerState.MAX_SHIELD, 0, 1) * 100}%`;
      this.fuel.style.width = `${clamp(m.player.fuel / PO.PlayerState.MAX_FUEL, 0, 1) * 100}%`;
      this.rows.forEach(({ sq, t }, i) => {
        const alive = m.latticeAlive(i);
        const locked = m.lockedEnds(i);
        const tag = alive === 0 ? "  CLEAR"
          : locked.length ? "  LOCKED " + locked.map((k) => k.toUpperCase()).join("+") : "";
        t.textContent = `${alive}/${m.lattices[i].length}${tag}`;
        t.style.color = locked.length && alive ? "#ffbf66" : "#fff";
        sq.style.opacity = alive ? 1 : 0.3;
      });
    }

    destroy() { this.root.remove(); }
  }

  // ------------------------------------------------------------------------
  // The survey map (canvas overlay, pauses the game)
  // ------------------------------------------------------------------------
  class MapScreen {
    constructor(game) {
      this.game = game;
      this.canvas = el("canvas", "mapcanvas", document.getElementById("ui"));
      this.canvas.style.display = "none";
      this.yaw = 0;      // how far the moon is turned east-west on the map (degrees)
      this.pitch = 0;    // and north-south
    }
    get enabled() { return this.canvas.style.display !== "none"; }
    set enabled(v) {
      this.canvas.style.display = v ? "block" : "none";
      if (v) { this.centre(); this.draw(); }
    }

    /** Turn the map so the sector you're in is in the middle. */
    centre() {
      const [lat, lon] = PO.faceLatLon(this.game.sectorId);
      this.yaw = lon; this.pitch = lat;
    }

    scroll(dYaw, dPitch) {
      this.yaw = ((this.yaw + dYaw) % 360 + 540) % 360 - 180;
      this.pitch = ((this.pitch + dPitch) % 360 + 540) % 360 - 180;
      this.draw();
    }

    draw() {
      const cnv = this.canvas, m = this.game.moon;
      cnv.width = window.innerWidth; cnv.height = window.innerHeight;
      const ctx = cnv.getContext("2d");
      const U = Math.min(cnv.height, cnv.width / 1.7);
      const W = 1.5, H = 0.75;
      const P = (x, y) => [cnv.width / 2 + x * U, cnv.height / 2 - y * U];
      const font = (s) => `${Math.round(s * U * 0.024)}px "DejaVu Sans Mono", Consolas, monospace`;
      const text = (s, x, y, size, colour, align = "center") => {
        ctx.font = font(size); ctx.fillStyle = colour; ctx.textAlign = align;
        ctx.textBaseline = "middle";
        s.split("\n").forEach((line, i) => {
          const [px, py] = P(x, y);
          ctx.fillText(line, px, py + i * size * U * 0.03);
        });
      };
      ctx.clearRect(0, 0, cnv.width, cnv.height);
      ctx.fillStyle = "rgba(5,8,15,0.93)";
      const [x0, y0] = P(-(W + .1) / 2, (H + .22) / 2 + .02);
      ctx.fillRect(x0, y0, (W + .1) * U, (H + .22) * U);
      text("SURVEY CHART - KESSAR-4", 0, H / 2 + .1, 1.2, "rgb(179,230,255)");
      text(`PAUSED  -  press TAB to resume      MOON SEED ${m.seed}`, 0, H / 2 + .06, .75,
           "rgb(255,204,128)");
      text("scroll: arrow keys / WASD or drag with the mouse      C: centre on you",
           0, H / 2 + .025, .65, "rgba(255,255,255,0.7)");
      text("lines = gates (white open, red sealed, amber locked, brown rockfall); lines at the " +
           "edges wrap round the moon\nyellow = sunlit   red ring = sealed   amber ring = vault" +
           "   purple = transporter\nlattice links appear once both cores are found",
           0, -H / 2 - .045, .65, "rgba(255,255,255,0.6)");
      const pos = (s) => {
        const [lat, lon] = PO.mapLatLon(s.id, this.yaw, this.pitch);
        return [lon / 180 * W / 2, lat / 90 * H / 2];
      };
      const line = (a, b, colour, thick) => {
        ctx.strokeStyle = colour; ctx.lineWidth = Math.max(1, thick * U);
        ctx.beginPath(); ctx.moveTo(...P(...a)); ctx.lineTo(...P(...b)); ctx.stroke();
      };
      const dot = (p, r, colour) => {
        ctx.fillStyle = colour; ctx.beginPath();
        const [px, py] = P(...p); ctx.arc(px, py, r * U, 0, Math.PI * 2); ctx.fill();
      };
      const edgeColour = (a, b) => {
        const st = new Set([m.gateState(a, b), m.gateState(b, a)]);
        if (st.has("rubble")) return ["rgba(191,115,64,0.7)", .005];
        if (st.has("locked")) return ["rgba(255,166,38,0.8)", .005];
        if (st.has("sealed")) return ["rgba(255,64,51,0.6)", .005];
        return ["rgba(255,255,255,0.18)", .003];
      };
      const wrapped = (a, b, colour, thick) => {
        if (Math.abs(a[0] - b[0]) < W / 2) { line(a, b, colour, thick); return; }
        const shift = a[0] < b[0] ? W : -W;
        for (const [p, q] of [[a, [b[0] - shift, b[1]]], [b, [a[0] + shift, a[1]]]]) {
          const edge = q[0] > p[0] ? W / 2 : -W / 2;
          const t = (edge - p[0]) / (q[0] - p[0]);
          line(p, [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], colour, thick);
        }
      };
      for (const s of m.sectors) {
        for (const n of s.neighbours) {
          if (n > s.id) { const [c, t] = edgeColour(s.id, n); wrapped(pos(s), pos(m.sectors[n]), c, t); }
        }
      }
      const corePos = {};
      for (const s of m.sectors) {
        const cs = m.coresIn(s.id);
        cs.forEach((c, k) => {
          const ang = 2 * Math.PI * k / Math.max(1, cs.length) + .6;
          const p = pos(s);
          corePos[c.id] = [p[0] + Math.cos(ang) * .045, p[1] + Math.sin(ang) * .045];
        });
      }
      m.lattices.forEach((lat, li) => {
        for (let i = 0; i + 1 < lat.length; i++) {
          const ca = m.cores[lat[i]], cb = m.cores[lat[i + 1]];
          if (ca.discovered && cb.discovered) {
            const pa = corePos[ca.id], pb = corePos[cb.id];
            if (Math.abs(pa[0] - pb[0]) < W / 2) {
              line(pa, pb, rgbCss(LATTICE_COLOURS[li], ca.alive && cb.alive ? .9 : .25), .004);
            }
          }
        }
      });
      for (const t of m.teleporters) {
        if (t.puzzle !== null && m.sectors[t.sector].visited) {
          wrapped(pos(m.sectors[t.sector]), pos(m.sectors[t.dest]),
                  `rgba(217,153,255,${t.active ? .8 : .3})`, .003);
        }
      }
      for (const s of m.sectors) {
        const p = pos(s);
        if (m.vaults.has(s.id)) dot(p, .029, "rgb(255,166,38)");
        if (m.sealed.has(s.id)) dot(p, .029, "rgb(255,77,64)");
        if (s.id === this.game.sectorId) dot(p, .03, "#fff");
        const c = [lerp(.15, 1, s.sunlight), lerp(.2, .85, s.sunlight), lerp(.45, .3, s.sunlight)];
        dot(p, .0225, rgbCss(s.visited ? c : scaleRgb(c, .5)));
        text(s.name, p[0], p[1] - .035, .55, `rgba(255,255,255,${s.visited ? .9 : .45})`);
      }
      if (m.drone.enabled && m.drone.active && m.drone.alive) {
        const dp = pos(m.sectors[m.drone.sector]);
        ctx.save();
        const [px, py] = P(dp[0], dp[1] + .04);
        ctx.translate(px, py); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = "rgb(255,51,38)";
        ctx.fillRect(-.011 * U, -.011 * U, .022 * U, .022 * U);
        ctx.restore();
        text("DRONE", dp[0], dp[1] + .065, .5, "rgb(255,102,89)");
      }
      for (const c of m.cores) {
        if (c.discovered) dot(corePos[c.id], c.alive ? .009 : .006,
                              rgbCss(LATTICE_COLOURS[c.lattice], c.alive ? 1 : .3));
      }
      let k = 0;
      m.lattices.forEach((_, i) => {
        const locked = m.lockedEnds(i);
        if (!locked.length) return;
        const names = { sealed: "a sealed sector", vault: "a vault" };
        const txt = `lattice end${locked.length > 1 ? "s" : ""} locked in ` +
          locked.map((x) => names[x]).join(" and ") + (locked.length > 1 ? "  - needs two puzzles" : "");
        const y = -H / 2 + .02 + k * .03;
        ctx.fillStyle = rgbCss(LATTICE_COLOURS[i]);
        const [sx, sy] = P(-W / 2 + .011, y + .009);
        ctx.fillRect(sx, sy, .018 * U, .018 * U);
        text(txt, -W / 2 + .04, y, .6, "rgb(255,204,128)", "left");
        k++;
      });
    }
    destroy() { this.canvas.remove(); }
  }

  // ------------------------------------------------------------------------
  // The game
  // ------------------------------------------------------------------------
  class Game {
    constructor(renderer, seed) {
      this.renderer = renderer;
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0, 0, 0);
      this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight,
                                                0.05, 3000);
      this.camera.rotation.order = "YXZ";
      this.scene.add(this.camera);
      this.keyLight = new THREE.DirectionalLight(0xffffff, Math.PI);
      this.scene.add(this.keyLight, this.keyLight.target);
      this.ambient = new THREE.HemisphereLight(0xffffff, 0x444444, Math.PI);
      this.scene.add(this.ambient);
      this.ray = new THREE.Raycaster();
      this.sfx = new SoundBoard();
      this.tweens = [];
      this.keys = new Set();
      this.mouseDown = false;
      this.hunter = false;
      this.gameLength = Moon.FULL_CHARGE_TIME;   // title-screen option (seconds at full power)
      this.active = false;
      this.pausedByPointer = false;
      this.overlay = null;
      this.world = null; this.worldFx = null; this.sky = null;
      this.hud = null; this.map = null;
      this.sensitivity = 0.12;
      this.shake = new THREE.Vector3();
      this.eyeDrop = 0;      // how far the camera has sunk (when the player falls)
      this.roll = 0;         // camera roll in degrees (when the player falls)
      this._buildGun();
      this.newGame(seed);
    }

    // ---- lifecycle -------------------------------------------------------
    newGame(seed = null, moon = null) {
      for (const g of [this.world, this.worldFx, this.sky]) {
        if (g) { this.scene.remove(g); disposeTree(g); }
      }
      if (this.hud) this.hud.destroy();
      if (this.map) this.map.destroy();
      this.closeOverlay();
      this.moon = moon || new Moon({ seed, hunter: this.hunter, fullChargeTime: this.gameLength });
      this.droneView = null;
      this.player = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vy: 0, grounded: true,
                      safe: { x: 0, y: 0, z: 0 }, thrusting: false };
      this.world = new THREE.Group(); this.scene.add(this.world);
      this.worldFx = new THREE.Group(); this.scene.add(this.worldFx);
      this.hud = new HUD(this);
      this.map = new MapScreen(this);
      this.shotTimer = 0; this.beepTimer = 0;
      this.eyeDrop = 0; this.roll = 0; this.finale = false;
      this.gun.visible = true;
      this.camera.fov = 75; this.camera.updateProjectionMatrix();
      if (moon) {
        const extra = moon.saveExtra || {};
        this.loadSector(moon.playerSector);
        if (extra.pos) {
          [this.player.x, this.player.y, this.player.z] = extra.pos;
          this.player.yaw = extra.yaw || 0;
          this.player.safe = { x: this.player.x, y: this.player.y, z: this.player.z };
        }
        this.begin(true);
      } else {
        this.loadSector(this.moon.startSector);
        this.showTitle();
      }
    }

    saveGame() {
      if (this.moon.state !== "playing") return;
      const p = this.player;
      const data = this.moon.saveState({ pos: [p.x, p.y, p.z], yaw: p.yaw });
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
        this.hud.say("Game saved (in this browser)", [.6, 1, .7], 3);
        this.sfx.play("pickup", .5);
      } catch (e) {
        this.hud.say(`Could not save: ${e.message}`, [1, .4, .3]);
      }
    }

    readSave() {
      try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); } catch (e) { return null; }
    }

    loadGame() {
      const data = this.readSave();
      if (!data) { if (this.hud) this.hud.say("No saved game found.", [1, .5, .4], 3); return false; }
      let moon;
      try { moon = Moon.fromSave(data); } catch (e) {
        this.hud.say(`Could not load the save: ${e.message}`, [1, .4, .3]);
        return false;
      }
      this.hunter = moon.drone.enabled;
      this.gameLength = moon.fullChargeTime;
      this.newGame(null, moon);
      this.hud.say("Game loaded", [.6, 1, .7], 3);
      return true;
    }

    seedText() {
      const s = this.moon.seed;
      const page = (location.pathname.split("/").pop() || "index.html");
      return `MOON SEED ${s}\nreplay this layout: open ${page}?seed=${s}, or press S on the title screen`;
    }

    overlayBox(cls) {
      this.closeOverlay();
      this.overlay = el("div", "overlay " + (cls || ""), document.getElementById("ui"));
      return this.overlay;
    }
    closeOverlay() { if (this.overlay) { this.overlay.remove(); this.overlay = null; } }

    showTitle() {
      this.active = false;
      if (document.pointerLockElement) document.exitPointerLock();
      const o = this.overlayBox("title");
      el("div", "title-text", o, "PALE ORBIT");
      el("div", "seed", o, this.seedText());
      el("pre", "story", o, STORY);
      el("pre", "controls", o, CONTROLS);
      this.optionText = el("div", "option", o);
      this.lengthText = el("div", "option", o);
      this.refreshOptions();
      if (this.readSave()) el("div", "continue", o, "[L] CONTINUE SAVED GAME");
      el("div", "begin", o, "click or press ENTER to begin");
    }

    refreshOptions() {
      if (!this.optionText) return;
      const on = this.hunter;
      this.optionText.textContent = `[D] HUNTER DRONE: ${on ? "ON " : "OFF"}   ` +
        (on ? "(it hunts you once a core falls)" : "(press D to turn on)");
      this.optionText.style.color = on ? "rgb(255,102,89)" : "rgba(255,255,255,0.6)";
      if (this.lengthText) {
        const len = this.gameLength;
        const mins = len === 1023 ? "17" : String(Math.round(len / 60));
        this.lengthText.textContent = `[T] GAME LENGTH: ${mins} MIN   ` +
          `(the Lance's charge time at full power${len === 1023 ? "; standard" : ""})`;
        this.lengthText.style.color = "rgb(255,204,128)";
      }
    }

    begin(resumed = false) {
      this.closeOverlay();
      this.active = true;
      this.pausedByPointer = false;
      this.lockPointer();
      if (!resumed) this.hud.say("Find the end of each lattice. Work inwards.", [.7, .9, 1]);
    }

    lockPointer() {
      try {
        const r = this.renderer.domElement.requestPointerLock();
        if (r && r.catch) r.catch(() => {});
      } catch (e) { /* not available (e.g. headless) */ }
    }

    showPause() {
      this.active = false;
      this.pausedByPointer = true;
      const o = this.overlayBox("pause");
      el("div", "title-text small", o, "PAUSED");
      el("div", "seed", o, this.seedText());
      el("div", "begin", o, "click or press ENTER to resume");
      el("div", "pause-option", o, "F5  save the game");
      el("div", "pause-option", o, "Q   quit to the title screen");
      this.pauseNote = el("div", "pause-note", o, "");
    }

    quitToTitle() {
      this.pausedByPointer = false;
      this.newGame();
    }

    // ---- the Lance fires: destruction of Halcyon ------------------------
    /** Shield gone: the player collapses, then watches the Lance fire. */
    playerDeath() {
      this.active = false;
      this.finale = true;
      this.finaleStart = performance.now();
      this.finaleReason = "shield";
      this.mouseDown = false;
      if (document.pointerLockElement) document.exitPointerLock();
      if (this.map.enabled) this.map.enabled = false;
      this.hud.root.style.display = "none";
      this.gun.visible = false;
      this.sfx.play("explosion", .9, .7);
      this.sfx.play("hit", 1, .5);
      const red = el("div", "deathred", document.getElementById("ui"));
      setTimeout(() => red.classList.add("on"), 20);
      setTimeout(() => red.classList.remove("on"), 1700);
      setTimeout(() => red.remove(), 3500);
      const p = this.player, pitch0 = p.pitch;
      this.tween(1.3, (t) => {
        const e = 1 - (1 - t) * (1 - t);
        this.eyeDrop = 2.2 * e;                  // down onto the ground
        this.roll = -32 * e;                     // tipped onto one side
        p.pitch = pitch0 + (25 - pitch0) * e;
        this.shake.set(rand(-1, 1) * .08 * (1 - t), rand(-1, 1) * .08 * (1 - t), 0);
      }, () => this.shake.set(0, 0, 0));
      this.later(2.0, () => { if (this.finale) this.lanceFinale("shield"); });
    }

    lanceFinale(reason = "lance") {
      this.active = false;
      if (!this.finale) this.finaleStart = performance.now();
      this.finale = true;
      this.finaleReason = reason;
      if (document.pointerLockElement) document.exitPointerLock();
      this.hud.root.style.display = "none";          // a clear view for the finale
      this.gun.visible = false;
      if (this.map.enabled) this.map.enabled = false;
      const sun = toLocal(this.sectorId, this.moon.sunDirection);
      // put Halcyon somewhere you can see it (it may be below the horizon)
      let pl = toLocal(this.sectorId, PLANET_DIRECTION);
      if (pl[1] < 0.2) {
        const h = Math.hypot(pl[0], pl[2]) || 1;
        pl = PO.norm([pl[0] / h, 0.45, pl[2] / h]);
      }
      const planetPos = V(pl[0] * 1400, pl[1] * 1400, pl[2] * 1400);
      if (!this.planet) {
        const g = shadedSphereGeometry(sun, [.35, .6, 1], [.03, .05, .12]);
        this.planet = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
        this.planet.scale.setScalar(380);
        this.sky.add(this.planet);
      }
      this.planetTimer = 1e9;        // stop the lighting code replacing it
      const planet = this.planet;
      planet.position.copy(planetPos);
      planet.visible = true;
      const additive = (c, a) => new THREE.MeshBasicMaterial({
        color: new THREE.Color(...c), transparent: true, opacity: a, depthWrite: false,
        blending: THREE.AdditiveBlending });

      // 1. the camera swings round to Halcyon, the ground rumbles
      const p = this.player;
      const eye = V(p.x, p.y + EYE_HEIGHT - this.eyeDrop, p.z);
      const to = planetPos.clone().sub(eye);
      const yaw1 = Math.atan2(to.x, -to.z) / DEG;
      const pitch1 = -Math.atan2(to.y, Math.hypot(to.x, to.z)) / DEG + 6;
      const yaw0 = p.yaw, pitch0 = p.pitch, roll0 = this.roll;
      const roll1 = reason === "shield" ? -12 : 0;   // still lying on the ground
      const dyaw = ((yaw1 - yaw0) % 360 + 540) % 360 - 180;
      this.tween(reason === "shield" ? 2.2 : 1.4, (t) => {
        const e = t * t * (3 - 2 * t);
        p.yaw = yaw0 + dyaw * e;
        p.pitch = pitch0 + (pitch1 - pitch0) * e;
        this.roll = roll0 + (roll1 - roll0) * e;
      });
      this.tween(7.5, (t) => {
        const k = t < .45 ? .05 + t * .2 : Math.max(0, .35 * (1 - (t - .45) * 2));
        this.shake.set(rand(-1, 1) * k, rand(-1, 1) * k, 0);
      }, () => this.shake.set(0, 0, 0));
      this.sfx.play("lance_fire", 1, .9);

      // 2. the Lance's tip flares and the beam reaches across the sky
      const tip = this.lanceTip;
      tip.material.blending = THREE.AdditiveBlending;
      this.tween(1.3, (t) => tip.scale.setScalar(100 + 500 * t));
      const start = this.lanceTop.clone();
      const dir = planetPos.clone().sub(start);
      const beams = [additive([1, .35, .25], .9), additive([1, .95, .85], 1)].map((mat, i) => {
        const b = new THREE.Mesh(GEO.box, mat);
        b.scale.set(i ? 4 : 12, i ? 4 : 12, 0.001);
        b.visible = false;
        this.sky.add(b);
        return b;
      });
      this.tween(0.6, (t) => {
        for (const b of beams) {
          b.visible = true;
          b.scale.z = Math.max(0.001, dir.length() * t);
          b.position.copy(start).addScaledVector(dir, t / 2);
          b.lookAt(planetPos);
        }
      }, null, 1.3);

      // 3. Halcyon heats up under the beam
      const heat = glowSprite(this.sky, [1, .55, .25], 0, 400);
      heat.material.blending = THREE.AdditiveBlending;
      heat.position.copy(planetPos);
      this.tween(2.0, (t) => {
        heat.material.opacity = t;
        heat.scale.setScalar(420 + 700 * t * t);
        tip.scale.setScalar(600 + Math.sin(t * 40) * 60);
      }, null, 1.9);

      // 4. it bursts: flash, shockwave rings, debris, white-out
      this.later(3.9, () => {
        planet.visible = false;
        this.sfx.play("explosion", 1, .45);
        this.sfx.play("lance_fire", .7, .6);
        this.tween(.8, (t) => { for (const b of beams) b.material.opacity = (1 - t) * .9; });
        this.tween(1.0, (t) => {
          tip.scale.setScalar(600 * (1 - t) + 60);
          heat.material.opacity = 1 - t;
        });
        const flash = glowSprite(this.sky, [1, 1, .95], 1, 600);
        flash.material.blending = THREE.AdditiveBlending;
        flash.position.copy(planetPos);
        this.tween(1.8, (t) => {
          flash.scale.setScalar(600 + 5200 * (1 - Math.pow(1 - t, 3)));
          flash.material.opacity = 1 - t;
        });
        const camPos = this.camera.getWorldPosition(new THREE.Vector3());
        for (const [k, c, tilt] of [[0, [1, .7, .4], 0], [1, [.6, .8, 1], .9], [2, [1, .9, .8], -.5]]) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(.9, 1, 128), additive(c, .9));
          ring.material.side = THREE.DoubleSide;
          ring.position.copy(planetPos);
          ring.lookAt(camPos);
          ring.rotateX(tilt);
          this.sky.add(ring);
          this.tween(4.5 + k, (t) => {
            ring.scale.setScalar(200 + (3200 + k * 600) * (1 - Math.pow(1 - t, 2)));
            ring.material.opacity = .9 * (1 - t);
          }, null, k * .15);
        }
        const cols = [[1, .85, .5], [1, .5, .2], [.9, .9, 1], [.5, .55, .7], [1, .3, .15]];
        for (let i = 0; i < 220; i++) {
          const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize()
            .multiplyScalar(rand(120, 650));
          const chunk = new THREE.Mesh(GEO.box, additive(cols[i % cols.length], 1));
          const size = rand(6, 26);
          chunk.scale.set(size, size * rand(.4, 1), size * rand(.4, 1));
          chunk.position.copy(planetPos);
          const spin = new THREE.Vector3(rand(-3, 3), rand(-3, 3), rand(-3, 3));
          this.sky.add(chunk);
          const life = rand(3.5, 6);
          this.tween(life, (t) => {
            const time = t * life;
            chunk.position.copy(planetPos).addScaledVector(v, time * (1 - t * .35));
            chunk.rotation.set(spin.x * time, spin.y * time, spin.z * time);
            chunk.material.opacity = 1 - t;
          });
        }
        const white = el("div", "whiteout", document.getElementById("ui"));
        setTimeout(() => white.classList.add("fade"), 60);
        setTimeout(() => white.remove(), 2600);
      });
      this.later(9.5, () => this.finishFinale());
    }

    /** Ignore skip input for the first few seconds, so the click or key you
     *  were pressing when the game ended doesn't skip the whole sequence. */
    canSkipFinale() {
      return performance.now() - (this.finaleStart || 0) > 4000;
    }

    finishFinale() {
      if (!this.finale) return;
      this.finale = false;
      this.hud.root.style.display = "";
      if (this.finaleReason === "won") this.endScreen(true);
      else this.endScreen(false, this.finaleReason || "lance");
    }

    /** Every core destroyed: the Lance sputters out, breaks up and sinks. */
    victoryFinale() {
      this.active = false;
      this.finale = true;
      this.finaleStart = performance.now();
      this.finaleReason = "won";
      this.mouseDown = false;
      if (document.pointerLockElement) document.exitPointerLock();
      if (this.map.enabled) this.map.enabled = false;
      this.hud.root.style.display = "none";
      this.gun.visible = false;
      const p = this.player;
      const additive = (c, a) => new THREE.MeshBasicMaterial({
        color: new THREE.Color(...c), transparent: true, opacity: a, depthWrite: false,
        blending: THREE.AdditiveBlending });
      const lookAtPoint = (target, duration, extraPitch = 0) => {
        const eye = V(p.x, p.y + EYE_HEIGHT, p.z);
        const to = target.clone().sub(eye);
        const yaw1 = Math.atan2(to.x, -to.z) / DEG;
        const pitch1 = -Math.atan2(to.y, Math.hypot(to.x, to.z)) / DEG + extraPitch;
        const yaw0 = p.yaw, pitch0 = p.pitch;
        const dyaw = ((yaw1 - yaw0) % 360 + 540) % 360 - 180;
        this.tween(duration, (t) => {
          const e = t * t * (3 - 2 * t);
          p.yaw = yaw0 + dyaw * e;
          p.pitch = pitch0 + (pitch1 - pitch0) * e;
        });
      };
      const base = this.lanceBase.clone(), top = this.lanceTop.clone();
      const mid = base.clone().lerp(top, .62);
      // lighten the spire so it stands out against the black sky
      this.lanceSpire.material.color.setRGB(.32, .32, .36);

      // 1. look at the Lance on the horizon, zooming in on it
      lookAtPoint(mid, 1.6, 0);
      const zoom = (to, duration, delay = 0) => {
        let from = null;
        this.tween(duration, (t) => {
          if (from === null) from = this.camera.fov;
          this.camera.fov = from + (to - from) * t * t * (3 - 2 * t);
          this.camera.updateProjectionMatrix();
        }, null, delay);
      };
      zoom(42, 2.0, 0.4);
      this.sfx.play("power_up", .7, .5);

      // 2. its tip sputters and dies, sparking
      const tip = this.lanceTip;
      tip.material.blending = THREE.AdditiveBlending;
      this.tween(2.2, (t) => {
        const flicker = Math.random() < .35 ? 0 : 1;
        tip.scale.setScalar((60 + 120 * Math.sin(t * 30) ** 2) * (1 - t) * flicker + 1);
        tip.material.opacity = (1 - t) * .9;
      }, () => { tip.visible = false; }, 1.0);
      for (let i = 0; i < 6; i++) {
        this.later(1.2 + i * .3, () => {
          const s = glowSprite(this.sky, [.6, .8, 1], .9, 25);
          s.material.blending = THREE.AdditiveBlending;
          s.position.copy(top).add(new THREE.Vector3(rand(-12, 12), rand(-20, 4), rand(-12, 12)));
          this.tween(.35, (t) => { s.material.opacity = .9 * (1 - t); s.scale.setScalar(25 + 40 * t); });
          this.removeLater(s, .4);
          this.sfx.play("deflect", .4, rand(.4, .7));
        });
      }

      // 3. explosions climb the spire, it breaks apart and sinks into dust
      this.later(3.4, () => {
        const spire = this.lanceSpire;
        spire.visible = false;
        const n = 7, h = 230 / n;
        const pieces = [];
        for (let i = 0; i < n; i++) {
          const piece = new THREE.Mesh(GEO.box, litMat([.32, .32, .36]));
          piece.material.emissive = new THREE.Color(0, 0, 0);
          piece.scale.set(14, h * .96, 14);
          piece.position.copy(base).add(new THREE.Vector3(0, h * (i + .5), 0));
          this.sky.add(piece);
          pieces.push(piece);
        }
        pieces.forEach((piece, i) => {
          const delay = i * .22;
          this.later(delay, () => {
            const boom = glowSprite(this.sky, [1, .6, .25], 1, 90);
            boom.material.blending = THREE.AdditiveBlending;
            boom.position.copy(piece.position).add(new THREE.Vector3(0, h / 2, 0));
            this.tween(.8, (t) => { boom.scale.setScalar(90 + 260 * t); boom.material.opacity = 1 - t; });
            this.spark(boom.position.clone(), [1, .7, .3], 10, 4, 60);
            this.removeLater(boom, .75);
            if (i % 2 === 0) this.sfx.play("explosion", .55, rand(.45, .7));
          });
          const tilt = new THREE.Vector3(rand(-.5, .5), 0, rand(-.5, .5)).multiplyScalar(1 + i * .3);
          const drop = h * (i + .5) + 60;
          const start = piece.position.clone();
          const drift = new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)).multiplyScalar(10 + i * 6);
          this.tween(3.2, (t) => {
            const e = t * t;
            piece.material.emissive.setRGB(.55 * Math.min(1, t * 3), .18 * Math.min(1, t * 3), .03);
            piece.position.copy(start).addScaledVector(drift, t).add(new THREE.Vector3(0, -drop * e, 0));
            piece.rotation.set(tilt.x * e, 0, tilt.z * e);
          }, () => { piece.visible = false; }, delay + .3);
        });
        // a rolling dust cloud at the foot of the Lance
        for (let k = 0; k < 12; k++) {
          const d = glowSprite(this.sky, [.6, .57, .55], 0, 90);
          d.position.copy(base).add(new THREE.Vector3(rand(-60, 60), rand(10, 70), rand(-60, 60)));
          this.tween(4.5, (t) => {
            d.material.opacity = Math.sin(Math.PI * t) * .7;
            d.scale.setScalar(90 + 300 * t);
          }, null, 1.0 + k * .12);
        }
        this.tween(3.5, (t) => {
          const k = .12 * Math.sin(Math.PI * t);
          this.shake.set(rand(-1, 1) * k, rand(-1, 1) * k, 0);
        }, () => this.shake.set(0, 0, 0), .5);
      });

      // 4. turn to Halcyon, safe in the sky, and celebrate
      this.later(8.2, () => {
        let pl = toLocal(this.sectorId, PLANET_DIRECTION);
        if (pl[1] < 0.2) {
          const hh = Math.hypot(pl[0], pl[2]) || 1;
          pl = PO.norm([pl[0] / hh, 0.45, pl[2] / hh]);
        }
        const planetPos = V(pl[0] * 1400, pl[1] * 1400, pl[2] * 1400);
        if (!this.planet) {
          const sun = toLocal(this.sectorId, this.moon.sunDirection);
          const g = shadedSphereGeometry(sun, [.35, .6, 1], [.03, .05, .12]);
          this.planet = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
          this.planet.scale.setScalar(380);
          this.sky.add(this.planet);
        }
        this.planetTimer = 1e9;
        this.planet.position.copy(planetPos);
        this.planet.visible = true;
        lookAtPoint(planetPos, 2.0);
        zoom(75, 2.0);
        const halo = glowSprite(this.sky, [.5, .8, 1], 0, 700);
        halo.material.blending = THREE.AdditiveBlending;
        halo.position.copy(planetPos);
        this.tween(2.5, (t) => { halo.material.opacity = .5 * Math.sin(Math.PI * Math.min(1, t * 1.4)); }, null, 1.2);
        this.later(1.2, () => this.sfx.play("fanfare", 1, .8));
        this.later(2.0, () => this.sfx.play("fanfare", .8, 1.0));
      });
      this.later(12.5, () => this.finishFinale());
    }

    endScreen(won, reason = "") {
      this.active = false;
      if (document.pointerLockElement) document.exitPointerLock();
      const o = this.overlayBox("end");
      const t = el("div", "title-text", o, won ? "THE LANCE IS DARK" : "MISSION FAILED");
      t.style.color = won ? "rgb(128,255,153)" : "rgb(255,89,77)";
      el("pre", "body", o, won
        ? `Every lattice destroyed in ${formatTime(this.moon.elapsed)}.\nHalcyon is safe.`
        : (reason === "lance" ? "The Lance has fired. Halcyon is gone."
          : "Your shield collapsed.\nWith no one left to stop it, the Lance fired. Halcyon is gone."));
      el("div", "seed", o, this.seedText());
      el("div", "begin", o, "R  play a new moon\nA  play this moon again\nQ  title screen");
    }

    // ---- colliders & raycasts -------------------------------------------
    collide(mesh, kind, ref, extra) {
      mesh.userData.collider = true;
      // hit tests must work from inside a shape too (three.js only tests
      // the faces a material renders)
      if (mesh.material && mesh !== this.ground) mesh.material.side = THREE.DoubleSide;
      if (kind) mesh.userData.kind = kind;
      if (ref !== undefined) mesh.userData.ref = ref;
      if (extra) Object.assign(mesh.userData, extra);
      this.colliders.push(mesh);
      return mesh;
    }

    raycast(origin, dir, far = Infinity, ignore = null) {
      this.ray.set(origin, dir.clone().normalize());
      this.ray.far = far;
      const list = this.colliders.filter((c) => !c.userData.off);
      const hits = this.ray.intersectObjects(list, false);
      for (const h of hits) {
        if (ignore && ignore.has(h.object)) continue;
        return { hit: true, object: h.object, point: h.point, distance: h.distance };
      }
      return { hit: false };
    }

    blocked(x, y, z, d, dist) {
      return this.raycast(V(x, y, z), V(d[0], d[1], d[2]), dist).hit;
    }

    // ---- tweens ----------------------------------------------------------
    tween(duration, fn, done, delay = 0) {
      this.tweens.push({ t: -delay, duration, fn, done });
    }
    later(delay, fn) { this.tween(0.0001, () => {}, fn, delay); }
    removeLater(obj, delay) {
      this.later(delay, () => { if (obj.parent) obj.parent.remove(obj); disposeTree(obj); });
    }
    _runTweens(dt) {
      const keep = [];
      for (const tw of this.tweens) {
        tw.t += dt;
        if (tw.t < 0) { keep.push(tw); continue; }
        const p = Math.min(1, tw.t / tw.duration);
        tw.fn(p);
        if (p >= 1) { if (tw.done) tw.done(); } else keep.push(tw);
      }
      this.tweens = keep;
    }

    // ---- sector construction --------------------------------------------
    loadSector(sectorId, arriveFrom = null, viaPad = false) {
      for (const g of [this.world, this.worldFx]) {
        for (const c of [...g.children]) { g.remove(c); disposeTree(c); }
      }
      if (this.sky) { this.scene.remove(this.sky); disposeTree(this.sky); }
      this.tweens = [];
      this.colliders = [];
      this.sectorId = sectorId;
      this.pulsers = [];
      this.gateRoots = {};
      this.gateLabels = {};
      this.labelTimer = 0;
      this.bolts = [];
      const m = this.moon, sec = m.sectors[sectorId];
      m.visit(sectorId);
      const rng = new PO.PyRandom(m.seed * 31 + sectorId);
      this.buildLighting(sec);

      // ground and surrounding highlands
      const tint = scaleRgb(hsv(sec.hue, .08, 1), .85);
      const groundMat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(...tint), map: Textures.regolith(m.seed + sectorId) });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMat);
      ground.rotation.x = -Math.PI / 2;
      this.world.add(ground);
      this.ground = this.collide(ground, "ground");
      for (const ch of m.chasmsIn(sectorId)) this.buildChasm(ch, sec);
      for (let k = 0; k < 60; k++) {
        const a = 2 * Math.PI * k / 60 + rng.uniform(-.04, .04);
        const s = rng.uniform(20, 55);
        const r = SECTOR_HALF_SIZE * 1.15 + s * 0.9 + rng.uniform(0, 60);
        const sc = [s * rng.uniform(1, 1.8), s * rng.uniform(.4, .9), s];
        mk(this.world, GEO.ico, litMat(hsv(sec.hue, .06, .62)),
           { x: Math.cos(a) * r, z: Math.sin(a) * r, y: -s * .25, scale: sc,
             rotY: rng.uniform(0, 360) });
      }
      // invisible perimeter
      const H = SECTOR_HALF_SIZE;
      for (const [x, z, w, d] of [[H, 0, 1, 2], [-H, 0, 1, 2], [0, H, 2, 1], [0, -H, 2, 1]]) {
        const wall = mk(this.world, GEO.box, new THREE.MeshBasicMaterial({ visible: false }),
                        { x, z, y: 40, scale: [w === 2 ? w * H : 1, 80, d === 2 ? d * H : 1] });
        this.collide(wall);
      }
      for (const b of sec.buildings) this.buildBuilding(b, sec, rng);
      sec.neighbours.forEach((n, g) => this.buildGate(g, m.sectors[n]));
      this.coreViews = m.coresIn(sectorId).map((c) => this.buildCore(c));
      this.sentryViews = m.sentriesIn(sectorId).filter((s) => s.alive).map((s) => this.buildSentry(s));
      this.breakerViews = m.breakersIn(sectorId).map((b) => this.buildBreaker(b));
      this.packViews = m.packsIn(sectorId).filter((p) => !p.taken).map((p) => this.buildPack(p));
      this.padViews = m.teleportersIn(sectorId).map((t) => this.buildTeleporter(t));
      this.slideViews = m.slidesIn(sectorId).map((pz) => this.buildSlide(pz));
      for (const rp of m.relayPuzzlesIn(sectorId)) this.buildRelayPuzzle(rp);
      for (const silo of m.silosIn(sectorId)) this.buildSilo(silo, sec);
      this.switchViews = [];
      for (const pz of m.puzzlesIn(sectorId)) {
        pz.state.forEach((_, i) => this.switchViews.push(this.buildSwitch(pz, i)));
      }

      // place the player
      const p = this.player;
      const pad = arriveFrom !== null ? m.returnPad(sectorId, arriveFrom) : null;
      if (viaPad && pad) {
        p.x = pad.x + 4; p.y = 0; p.z = pad.z; p.yaw = -90;
      } else if (arriveFrom === null) {
        p.x = 0; p.y = 0; p.z = 0; p.yaw = 0;
      } else {
        const [gx, gz] = gatePosition(sec.neighbours.indexOf(arriveFrom));
        const len = Math.hypot(gx, gz), ix = -gx / len, iz = -gz / len;
        p.x = gx + ix * 7; p.y = 0; p.z = gz + iz * 7;
        p.yaw = Math.atan2(ix, iz) / DEG;
      }
      p.vy = 0;
      p.safe = { x: p.x, y: p.y, z: p.z };
      m.setPlayerSector(sectorId);
      this.droneView = null;
      const d = m.drone;
      if (d.enabled && d.active && d.alive && d.sector === sectorId) this.spawnDroneView(null);
      this.gateCooldown = 1.0;
      this.sealedMsgTimer = 0;
      this.scene.updateMatrixWorld(true);
    }

    buildLighting(sec) {
      this.sky = new THREE.Group();
      this.scene.add(this.sky);
      this.sky.add(starfield());
      this.sunDisc = mk(this.sky, GEO.sphere, unlitMat([1, .97, .85]), { scale: 60 });
      glowSprite(this.sunDisc, [1, .9, .7], .55, 9);
      this.planet = null;
      this.planetTimer = 0;
      this.updateLighting(999);
      const ld = toLocal(sec.id, [0, 1, 0]);
      let lx = ld[0], lz = ld[2];
      const ll = Math.hypot(lx, lz);
      if (ll > .05) { lx /= ll; lz /= ll; } else { lx = 0; lz = 1; }
      this.lanceSpire = mk(this.sky, GEO.box, litMat([.12, .12, .14]),
                           { x: lx * 420, z: lz * 420, scale: [14, 230, 14], bottom: true });
      this.lanceBase = V(lx * 420, 0, lz * 420);
      this.lanceTip = glowSprite(this.sky, [1, .3, .2], .8, 60, { x: lx * 420, y: 236, z: lz * 420 });
      this.lanceTop = V(lx * 420, 236, lz * 420);
    }

    updateLighting(dt) {
      const sid = this.sectorId, m = this.moon;
      const sun = toLocal(sid, m.sunDirection);
      const planet = toLocal(sid, PLANET_DIRECTION);
      let day = clamp(sun[1] / 0.15, 0, 1);
      day = day * day * (3 - 2 * day);
      const strength = sun[1] > 0 ? .7 + .6 * Math.min(1, sun[1] * 2) : .7;
      const nightSrc = planet[1] > 0.05 ? planet : PO.norm([.3, .6, .4]);
      const keyDir = sun[1] > 0.0 ? sun : nightSrc;
      const key = [lerp(.25, strength, day), lerp(.32, strength * .96, day), lerp(.55, strength * .88, day)];
      const amb = [lerp(.1, .36, day), lerp(.12, .36, day), lerp(.2, .42, day)];
      this.keyLight.color.setRGB(...key);
      this.keyLight.position.copy(V(keyDir[0] * 100, keyDir[1] * 100, keyDir[2] * 100));
      this.keyLight.target.position.set(0, 0, 0);
      this.ambient.color.setRGB(...amb);
      this.ambient.groundColor.setRGB(amb[0] * .3, amb[1] * .3, amb[2] * .3);
      this.sunDisc.position.copy(V(sun[0] * 1500, sun[1] * 1500, sun[2] * 1500));
      this.sunDisc.visible = sun[1] > -0.08;
      this.planetTimer -= dt;
      if (this.planetTimer <= 0) {
        this.planetTimer = 15;
        if (this.planet) { this.sky.remove(this.planet); this.planet.geometry.dispose(); this.planet = null; }
        if (planet[1] > -0.15) {
          const g = shadedSphereGeometry([sun[0], sun[1], sun[2]], [.35, .6, 1], [.03, .05, .12]);
          this.planet = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
          this.planet.position.copy(V(planet[0] * 1400, planet[1] * 1400, planet[2] * 1400));
          this.planet.scale.setScalar(380);
          this.sky.add(this.planet);
        }
      }
    }

    buildBuilding(b, sec, rng) {
      const hull = hsv(sec.hue, .05, rng.uniform(.62, .8));
      const accent = hsv((sec.hue + 180) % 360, .55, .85);
      const windows = [1, .82, .45];
      const root = group(this.world, b.x, 0, b.z, b.rot);
      if (b.style === "rock") {
        const rot = [rng.uniform(0, 30), rng.uniform(0, 360), rng.uniform(0, 30)];
        this.collide(mk(root, GEO.ico, litMat(hsv(sec.hue, .05, .5)),
                        { y: b.h * .3, scale: [b.w, b.h, b.d], rot }));
        return;
      }
      if (b.style === "dome") {
        this.collide(mk(root, GEO.sphere, litMat(hull), { scale: [b.w, b.h * 2, b.d] }));
        mk(root, GEO.box, litMat(scaleRgb(hull, .8)), { y: .4, scale: [b.w * 1.05, .8, b.d * 1.05] });
        mk(root, GEO.box, unlitMat(windows), { y: .9, z: b.d / 2 - .1, scale: [2.2, 1.8, .5] });
        return;
      }
      this.collide(mk(root, GEO.box, litMat(hull, {
        map: Textures.panel([Math.max(1, b.w / 4), Math.max(1, b.h / 3)]) }),
        { bottom: true, scale: [b.w, b.h, b.d] }));
      mk(root, GEO.box, litMat(scaleRgb(hull, .75)), { y: b.h, scale: [b.w + .4, .35, b.d + .4] });
      mk(root, GEO.box, litMat(accent), { y: b.h * .25, scale: [b.w + .05, .3, b.d + .05] });
      const rows = Math.max(1, Math.floor(b.h / 3));
      for (let r = 0; r < rows; r++) {
        if (b.style === "hangar" && r === 0) continue;
        const y = 1.6 + r * 3;
        if (y > b.h - .6) break;
        for (const side of [1, -1]) {
          mk(root, GEO.box, unlitMat(windows), { y, z: side * (b.d / 2 + .02), scale: [b.w * .7, .35, .05] });
        }
      }
      if (b.style === "hangar") {
        mk(root, GEO.box, litMat(scaleRgb(hull, .55)),
           { bottom: true, z: b.d / 2 + .05, scale: [b.w * .6, b.h * .7, .1] });
      }
      if (b.style === "tower") {
        mk(root, GEO.box, litMat([.3, .3, .3]), { bottom: true, y: b.h, scale: [.15, 5, .15] });
        const beacon = mk(root, GEO.sphere, unlitMat([1, .1, .1]), { y: b.h + 5, scale: .5 });
        this.pulsers.push([beacon.material, [1, .1, .1, 1], [.25, 0, 0, 1], 1.2]);
      }
    }

    buildChasm(ch, sec) {
      const [ux, uz] = ch.axis;
      const root = group(this.world, ux * ch.d, 0, uz * ch.d, Math.atan2(ux, uz) / DEG);
      const length = 220, depth = 45, w = ch.width;
      const cover = new THREE.Mesh(GEO.quad, unlitMat([.01, .01, .02]));
      cover.rotation.x = -Math.PI / 2;
      cover.scale.set(length, w, 1);
      cover.position.y = .03;
      root.add(cover);
      const rock = hsv(sec.hue, .06, .45);
      for (const side of [-1, 1]) {
        mk(root, GEO.box, litMat(rock), { y: -depth / 2, z: side * (w / 2 + .5), scale: [length, depth, 1] });
        mk(root, GEO.box, litMat(scaleRgb(rock, 1.2)), { y: .15, z: side * (w / 2 + .5), scale: [length, .3, 1] });
        for (let k = -9; k <= 9; k++) {
          mk(root, GEO.box, unlitMat([1, .55, .1]), { x: k * 7.5, y: .55, z: side * (w / 2 + .5), scale: [.25, .5, .25] });
        }
      }
      mk(root, GEO.box, litMat(scaleRgb(rock, .5)), { y: -depth, scale: [length, 1, w + 2] });
    }

    fellInChasm() {
      this.moon.player.damage(20);
      this.sfx.play("hit", 1, .7);
      this.hud.say("You fell into a chasm! Use the jetpack (SPACE) to cross.", [1, .55, .2]);
      Object.assign(this.player, this.player.safe);
      this.player.vy = 0;
    }

    buildGate(g, dest) {
      const state = this.moon.gateState(this.sectorId, dest.id);
      const [gx, gz] = gatePosition(g);
      const root = group(this.world, gx, 0, gz, Math.atan2(-gx, -gz) / DEG);
      this.gateRoots[g] = root;
      const frame = [.35, .36, .4];
      for (const side of [-1, 1]) {
        this.collide(mk(root, GEO.box, litMat(frame), { bottom: true, x: side * 3.2, scale: [1, 7, 1.4] }));
      }
      mk(root, GEO.box, litMat(frame), { y: 7.2, scale: [7.6, 1, 1.6] });
      let label, textCol;
      if (state === "rubble") {
        const rng = new PO.PyRandom(this.sectorId * 7 + g);
        for (let k = 0; k < 9; k++) {
          const x = rng.uniform(-2.2, 2.2), y = rng.uniform(.6, 4.5), z = rng.uniform(-1, 1);
          const s = rng.uniform(1.8, 3);
          const rot = [rng.uniform(0, 90), rng.uniform(0, 360), 0];
          this.collide(mk(root, GEO.ico, litMat(hsv(this.moon.sectors[this.sectorId].hue, .05, .45)),
                          { x, y, z, scale: s, rot }));
        }
        label = "BLOCKED - ROCKFALL"; textCol = [.75, .7, .65];
      } else {
        mk(root, GEO.circle, unlitMat([.4, .9, 1], .5), { y: .05, scale: 5, flat: true });
        const fc = { open: [.4, .85, 1], sealed: [1, .25, .2], locked: [1, .65, .15] }[state];
        const barred = state !== "open";
        const field = mk(root, GEO.quad, unlitMat(fc, .28, { side: THREE.DoubleSide }),
                         { y: 3.4, scale: [5.4, 6.6, 1] });
        if (barred) this.collide(field);
        this.pulsers.push([field.material, [...fc, barred ? .45 : .3], [...fc, .1], 2.0]);
        if (barred) {
          for (let k = 0; k < 5; k++) {
            mk(root, GEO.box, unlitMat(fc), { y: .8 + k * 1.3, scale: [5.4, .12, .12] });
          }
        }
        const pz = this.moon.controlWallFor(dest.id);
        const remote = pz && pz.sector !== this.sectorId;
        label = { open: this.sunLabel(dest.id), sealed: "SEALED",
                  locked: remote ? `LOCKED - control in\n${this.moon.sectors[pz.sector].name.toUpperCase()}`
                    : "LOCKED" }[state];
        textCol = [.7, .95, 1];
      }
      const text = textSprite(root, `> ${dest.name.toUpperCase()}\n${label}`,
                              { y: 9.2, scale: 18, color: textCol });
      if (state === "open") this.gateLabels[g] = [text, dest.id];
    }

    lockedMessage(vault) {
      const name = this.moon.sectors[vault].name;
      const pz = this.moon.controlWallFor(vault);
      if (!pz || pz.sector === this.sectorId) {
        return `The gate to ${name} is locked. Find its control wall nearby.`;
      }
      return `This bulkhead into ${name} is locked. Its control wall is in ${this.moon.sectors[pz.sector].name}.`;
    }

    sunLabel(sectorId) {
      const m = this.moon, light = m.sectors[sectorId].sunlight, trend = m.sunlightTrend(sectorId);
      const arrow = trend > .005 ? " RISING" : trend < -.005 ? " SETTING" : "";
      if (light <= .005) return "NIGHT" + (trend > 0 ? " - DAWN SOON" : "");
      return `SUN ${(light * 100).toFixed(0)}%${arrow}`;
    }

    rebuildGate(other) {
      const sec = this.moon.sectors[this.sectorId];
      const g = sec.neighbours.indexOf(other);
      if (g < 0) return;
      const old = this.gateRoots[g];
      if (old) {
        this.colliders = this.colliders.filter((c) => { let o = c; while (o) { if (o === old) return false; o = o.parent; } return true; });
        this.world.remove(old);
        disposeTree(old);
      }
      delete this.gateLabels[g];
      this.buildGate(g, this.moon.sectors[other]);
      this.scene.updateMatrixWorld(true);
    }

    buildCore(core) {
      const col = LATTICE_COLOURS[core.lattice];
      const root = group(this.world, core.x, 0, core.z);
      const h = core.height;
      [[2.2, 0.08], [1.0, 0.92]].forEach(([w, frac], i) => {
        const y0 = i === 0 ? 0 : h * 0.08;
        this.collide(mk(root, GEO.box, litMat([.55, .56, .6], {
          map: Textures.panel([1, Math.max(1, h * frac / 3)]) }),
          { bottom: true, y: y0, scale: [w, h * frac, w] }));
      });
      for (let k = 0; k < Math.floor(h / 4); k++) {
        mk(root, GEO.box, unlitMat(col), { y: 2 + k * 4, scale: [1.08, 0.18, 1.08] });
      }
      mk(root, GEO.box, litMat([.4, .41, .45]), { y: h, scale: [2.6, 0.35, 2.6] });
      const gem = mk(root, GEO.octa, new THREE.MeshBasicMaterial({
        color: new THREE.Color(...col), vertexColors: true, side: THREE.DoubleSide }),
        { y: h + 2.0, scale: 1.6 });
      this.collide(gem, "core", core.id);
      const halo = glowSprite(gem, col, .55, 4.5);
      const beam = mk(root, GEO.box, unlitMat(col, .22), { bottom: true, y: h + 2, scale: [.12, 90, .12] });
      const stump = mk(root, GEO.box, litMat([.15, .15, .17]), { y: h + .6, scale: [.9, .5, .9] });
      if (core.relayLocked) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(GEO.box),
                                             new THREE.LineBasicMaterial({ color: new THREE.Color(...col) }));
        edges.position.y = h + 2; edges.scale.setScalar(3.4);
        root.add(edges);
        mk(root, GEO.box, unlitMat(col, .12, { side: THREE.DoubleSide }), { y: h + 2, scale: 3.33 });
        textSprite(root, "REFRACTOR SHIELD\nrelay beam only", { y: h + 5, scale: 12, color: col });
      }
      let ward = null;
      if (core.warded) {
        ward = mk(root, GEO.sphere, unlitMat([.7, .9, 1], .22, { side: THREE.DoubleSide }),
                  { y: h + 2, scale: 5.2 });
        this.collide(ward, "ward", core.id);
      }
      const view = { core, root, gem, halo, beam, stump, ward, t: Math.random() * 10 };
      this.syncCore(view);
      return view;
    }

    syncCore(v) {
      const c = v.core;
      const regen = !c.alive && c.regenTimer > 0;
      v.gem.visible = c.alive || regen;
      v.gem.userData.off = !c.alive;
      v.beam.visible = c.alive;
      v.stump.visible = !c.alive;
      if (regen) v.gem.scale.setScalar(0.3 + 1.3 * (c.regenTimer / Moon.REGEN_DELAY));
      else if (c.alive) v.gem.scale.setScalar(1.6);
      if (v.ward) { v.ward.visible = c.warded; v.ward.userData.off = !c.warded; }
    }

    buildSentry(data) {
      const root = group(this.world, data.x, 0, data.z);
      const parts = new Set();
      parts.add(this.collide(mk(root, GEO.box, litMat([.3, .3, .33]), { bottom: true, scale: [2.6, 1, 2.6] })));
      parts.add(this.collide(mk(root, GEO.box, litMat([.38, .38, .42]), { bottom: true, y: 1, scale: [1, 1.8, 1] })));
      const head = new THREE.Group();
      head.position.y = 3.3;
      root.add(head);
      const body = mk(head, GEO.sphere, litMat([.5, .2, .18]), { scale: 1.8 });
      parts.add(this.collide(body, "sentry", data.id));
      // modelled facing +z (three) so lookAt() points the barrel at the player
      const barrel = mk(head, GEO.box, litMat([.2, .2, .22]), { scale: [.25, .25, 1.6] });
      barrel.position.z = 1.3;
      const eye = mk(head, GEO.sphere, unlitMat([1, .15, .1]), { y: .25, scale: .45 });
      eye.position.z = .85;
      return { data, root, head, body, eye, parts, cooldown: rand(0.5, SENTRY_COOLDOWN) };
    }

    updateSentry(s, dt) {
      if (!this.active || !s.data.alive) return;
      const p = this.player;
      const target = V(p.x, p.y + EYE_HEIGHT * 0.8, p.z);
      const origin = s.head.getWorldPosition(new THREE.Vector3());
      const to = target.clone().sub(origin);
      const dist = to.length();
      if (dist > SENTRY_RANGE) { s.eye.material.color.setRGB(.5, .1, .08); return; }
      const dir = to.clone().normalize();
      const hit = this.raycast(origin.clone().addScaledVector(dir, 1.3), dir, dist - 1.3, s.parts);
      if (hit.hit) { s.eye.material.color.setRGB(.6, .3, .05); return; }
      s.eye.material.color.setRGB(1, .15, .1);
      s.head.lookAt(target);
      s.cooldown -= dt;
      if (s.cooldown <= 0) {
        s.cooldown = SENTRY_COOLDOWN;
        this.spawnBolt(origin.clone().addScaledVector(dir, 2.2), dir);
        this.sfx.play("sentry_shot", .7 * (1 - dist / SENTRY_RANGE) + .15, rand(.9, 1.1));
      }
    }

    spawnDroneView(cameFrom) {
      const sec = this.moon.sectors[this.sectorId];
      let pos;
      if (cameFrom !== null && sec.neighbours.includes(cameFrom)) {
        const [gx, gz] = gatePosition(sec.neighbours.indexOf(cameFrom));
        pos = { x: gx, y: 10, z: gz };
      } else {
        const a = rand(0, 2 * Math.PI);
        pos = { x: Math.cos(a) * 45, y: 12, z: Math.sin(a) * 45 };
      }
      if (this.droneView) this.removeDroneView();
      const root = new THREE.Group();
      this.world.add(root);
      const parts = new Set();
      const body = mk(root, GEO.sphere, litMat([.35, .12, .12]), { scale: [1.8, 1.1, 1.8] });
      parts.add(this.collide(body, "drone", 0));
      const rotors = [];
      for (let k = 0; k < 4; k++) {
        const a = 2 * Math.PI * k / 4 + Math.PI / 4;
        mk(root, GEO.box, litMat([.25, .25, .28]),
           { x: Math.cos(a) * 1.2, z: Math.sin(a) * 1.2, scale: [1.4, .15, .25], rotY: -a / DEG });
        rotors.push(mk(root, GEO.circle, unlitMat([.8, .8, .9], .35, { side: THREE.DoubleSide }),
                       { y: .25, x: Math.cos(a) * 1.9, z: Math.sin(a) * 1.9, scale: 1.4, flat: true }));
      }
      const eye = mk(root, GEO.sphere, unlitMat([1, .1, .1]), { y: -.2, scale: .5 });
      eye.position.z = .8;   // faces +z for lookAt()
      glowSprite(eye, [1, .15, .1], .6, 5);
      this.droneView = { root, parts, rotors, pos, cooldown: 2.0, orbit: rand(0, 2 * Math.PI) };
      this.scene.updateMatrixWorld(true);
    }

    removeDroneView() {
      const dv = this.droneView;
      if (!dv) return;
      this.colliders = this.colliders.filter((c) => !dv.parts.has(c));
      this.world.remove(dv.root);
      disposeTree(dv.root);
      this.droneView = null;
    }

    updateDrone(dt) {
      const dv = this.droneView;
      if (!dv || !this.active) return;
      for (const r of dv.rotors) r.rotation.z += 15 * dt;
      const p = this.player;
      const px = p.x, py = p.y + EYE_HEIGHT, pz = p.z;
      dv.orbit += .35 * dt;
      const lim = SECTOR_HALF_SIZE - 3;
      const goal = [clamp(px + Math.cos(dv.orbit) * 16, -lim, lim), py + 9 + Math.sin(dv.orbit * 2) * 2,
                    clamp(pz + Math.sin(dv.orbit) * 16, -lim, lim)];
      const tg = [goal[0] - dv.pos.x, goal[1] - dv.pos.y, goal[2] - dv.pos.z];
      const tl = Math.hypot(...tg);
      if (tl > .2) {
        const step = Math.min(9.0 * dt, tl);
        dv.pos.x += tg[0] / tl * step; dv.pos.y += tg[1] / tl * step; dv.pos.z += tg[2] / tl * step;
      }
      dv.root.position.copy(V(dv.pos.x, dv.pos.y, dv.pos.z));
      dv.root.lookAt(V(px, dv.pos.y, pz));
      dv.root.updateMatrixWorld(true);
      const origin = dv.root.position.clone();
      const to = V(px, py, pz).sub(origin);
      const dist = to.length();
      dv.cooldown -= dt;
      if (dv.cooldown <= 0 && dist < 60) {
        const dir = to.clone().normalize();
        const hit = this.raycast(origin.clone().addScaledVector(dir, 1.6), dir, dist - 1.6, dv.parts);
        if (!hit.hit) {
          dv.cooldown = 1.3;
          this.spawnBolt(origin.clone().addScaledVector(dir, 1.8), dir);
          this.sfx.play("sentry_shot", .8, 1.25);
        }
      }
    }

    spawnBolt(pos, dir) {
      const mesh = new THREE.Mesh(GEO.box, unlitMat([1, .4, .15]));
      mesh.scale.set(.18, .18, 1.2);
      mesh.position.copy(pos);
      mesh.lookAt(pos.clone().add(dir));
      this.worldFx.add(mesh);
      const glow = glowSprite(this.worldFx, [1, .45, .15], .6, 5);
      glow.position.copy(pos);
      this.bolts.push({ mesh, glow, dir: dir.clone(), life: 3.0 });
    }

    updateBolts(dt) {
      if (!this.active) return;
      const p = this.player;
      const centre = V(p.x, p.y + EYE_HEIGHT * .55, p.z);
      const keep = [];
      for (const b of this.bolts) {
        const step = BOLT_SPEED * dt;
        const hit = this.raycast(b.mesh.position, b.dir, step);
        b.mesh.position.addScaledVector(b.dir, step);
        b.glow.position.copy(b.mesh.position);
        b.life -= dt;
        let gone = false;
        if (b.mesh.position.distanceTo(centre) < 1.5) { this.playerHit(); gone = true; }
        else if (hit.hit || b.life <= 0) {
          this.spark(b.mesh.position.clone(), [1, .5, .2], 5, .15);
          gone = true;
        }
        if (gone) {
          this.worldFx.remove(b.mesh, b.glow);
          b.mesh.material.dispose(); b.glow.material.dispose();
        } else keep.push(b);
      }
      this.bolts = keep;
    }

    buildSilo(silo, sec) {
      const S = silo.size, H = PO.Silo.HATCH, h = silo.height, t = .6;
      const hull = hsv(sec.hue, .07, .7);
      const root = group(this.world, silo.x, 0, silo.z);
      for (const [sx, sz, w, d] of [[0, S / 2, S, t], [0, -S / 2, S, t], [S / 2, 0, t, S], [-S / 2, 0, t, S]]) {
        this.collide(mk(root, GEO.box, litMat(hull, { map: Textures.panel([Math.max(1, Math.max(w, d) / 4), h / 3]) }),
                        { bottom: true, x: sx, z: sz, scale: [w, h, d] }));
      }
      const k = (S - H) / 2;
      for (const [sx, sz, w, d] of [[0, H / 2 + k / 2, S, k], [0, -H / 2 - k / 2, S, k],
                                    [H / 2 + k / 2, 0, k, H], [-H / 2 - k / 2, 0, k, H]]) {
        this.collide(mk(root, GEO.box, litMat(scaleRgb(hull, .8)), { x: sx, z: sz, y: h, scale: [w, .5, d] }));
      }
      for (const [sx, sz, w, d] of [[0, H / 2, H, .25], [0, -H / 2, H, .25], [H / 2, 0, .25, H], [-H / 2, 0, .25, H]]) {
        mk(root, GEO.box, unlitMat([1, .65, .15]), { x: sx, z: sz, y: h + .3, scale: [w, .12, d] });
      }
      mk(root, GEO.box, litMat([1, .65, .15]), { y: h * .45, scale: [S + .05, .4, S + .05] });
      for (const [sx, sz, w, d] of [[0, S / 2 - .35, S * .7, .05], [0, -S / 2 + .35, S * .7, .05]]) {
        mk(root, GEO.box, unlitMat([1, .9, .7]), { x: sx, z: sz, y: h - 1.2, scale: [w, .2, d] });
      }
      mk(root, GEO.box, litMat([.25, .25, .28]), { y: .03, scale: [S - 1, .05, S - 1] });
      textSprite(root, "SILO\nroof hatch only", { y: h + 2.4, scale: 12, color: [1, .75, .35] });
    }

    buildRelayPuzzle(rp) {
      const bh = PO.BEAM_HEIGHT;
      const em = group(this.world, rp.ex, 0, rp.ez, rp.efacing * 45);
      for (let k = 0; k < 3; k++) {
        const a = 2 * Math.PI * k / 3;
        mk(em, GEO.box, litMat([.35, .35, .4]),
           { x: Math.cos(a) * .9, z: Math.sin(a) * .9, y: 1.2, scale: [.2, 2.6, .2],
             rot: [Math.cos(a) * 15, 0, -Math.sin(a) * 15] });
      }
      this.collide(mk(em, GEO.box, litMat([.3, .5, .6]), { y: bh, scale: [1.2, 1.2, 2.2] }), "emitter", rp.id);
      const lens = mk(em, GEO.sphere, unlitMat([.6, 1, 1]), { y: bh, z: 1.2, scale: .8 });
      glowSprite(lens, [.5, 1, 1], .5, 4);
      textSprite(em, "RELAY EMITTER\nshoot to fire", { y: bh + 2.2, scale: 12, color: [.6, 1, 1] });
      for (const rid of rp.relays) {
        const r = this.moon.relays[rid];
        const root = group(this.world, r.x, 0, r.z);
        mk(root, GEO.box, litMat([.3, .3, .34]), { bottom: true, scale: [1.4, .4, 1.4] });
        mk(root, GEO.box, litMat([.4, .4, .45]), { bottom: true, scale: [.4, bh - .5, .4] });
        const head = group(root, 0, bh, 0, r.facing * 45);
        const hub = mk(head, GEO.box, litMat([.55, .5, .35]), { scale: [1.3, 1, 1.3] });
        this.collide(hub, "relay", r.id, { head });
        mk(head, GEO.box, litMat([.25, .25, .28]), { z: 1.1, scale: [.35, .35, 1.3] });
        mk(head, GEO.quad, unlitMat([.8, .95, 1], 1, { side: THREE.DoubleSide }), { z: -.66, scale: [1.1, .8, 1] });
        mk(head, GEO.sphere, unlitMat([1, .75, .3]), { z: 1.8, scale: .35 });
        textSprite(root, "RELAY\nshoot to turn", { y: bh + 1.8, scale: 9, color: [1, .8, .45] });
      }
    }

    fireRelayBeam(pid) {
      const bh = PO.BEAM_HEIGHT;
      const [points, result] = this.moon.fireEmitter(pid);
      this.sfx.play("power_up", .5, 2.2);
      for (let i = 0; i + 1 < points.length; i++) {
        const pa = V(points[i][0], bh, points[i][1]), pb = V(points[i + 1][0], bh, points[i + 1][1]);
        const d = pb.clone().sub(pa);
        if (d.length() < .01) continue;
        const beam = new THREE.Mesh(GEO.box, unlitMat([.6, 1, 1], .999));
        beam.scale.set(.18, .18, d.length());
        beam.position.copy(pa.clone().addScaledVector(d, .5));
        beam.lookAt(pb);
        this.worldFx.add(beam);
        this.tween(.4, (p) => { beam.material.opacity = 1 - p; }, null, .5);
        this.removeLater(beam, 1);
      }
      const end = points[points.length - 1];
      const rp = this.moon.relayPuzzles[pid];
      if (result === "core") {
        const core = this.moon.cores[rp.core];
        this.explode(V(core.x, core.height + 2, core.z), LATTICE_COLOURS[core.lattice]);
        this.sfx.play("explosion", .9);
      } else {
        this.spark(V(end[0], bh, end[1]), [.6, 1, 1], 6, .15);
        if (result === "relay_loop") this.hud.say("The beam is going round in circles.", [.6, 1, 1]);
      }
    }

    buildSlide(pz) {
      const out = Math.atan2(pz.x, pz.z) / DEG;
      const root = group(this.world, pz.x, 0, pz.z, out);
      for (const side of [-1, 1]) {
        this.collide(mk(root, GEO.box, litMat([.3, .3, .34]), { bottom: true, x: side * 3.4, scale: [.6, 7.6, .8] }));
      }
      this.collide(mk(root, GEO.box, litMat([.12, .12, .15]), { y: 4.3, scale: [6.4, 6.4, .5] }));
      const lamp = mk(root, GEO.box, unlitMat([1, .2, .15]), { y: 7.9, scale: [1.2, .5, .5] });
      textSprite(root, `GATE CONTROL\n> ${this.moon.sectors[pz.vault].name.toUpperCase()}`,
                 { y: 9.4, scale: 14, color: [1, .75, .35] });
      textPlane(root, "shoot a tile next to the gap to slide it - put 1 to 8 in order",
                { y: .55, z: -.3, height: .32, color: [1, 1, 1], alpha: .8 });
      const tiles = {};
      for (let number = 1; number <= 8; number++) {
        const tile = mk(root, GEO.box, unlitMat([.75, .8, .9], 1, { map: Textures.panel() }),
                        { z: -.4, scale: [1.85, 1.85, .4] });
        this.collide(tile, "slide", [pz.id, number]);
        textPlane(tile, String(number), { height: 1.1 / 1.85, color: [.05, .05, .08], z3: 0.52 });
        tiles[number] = tile;
      }
      const view = { pz, root, lamp, tiles };
      this.syncSlide(view, false);
      return view;
    }

    slideCellPos(cell) {
      const r = Math.floor(cell / 3), c = cell % 3;
      return new THREE.Vector3((c - 1) * 2.0, 6.3 - r * 2.0, 0.4);
    }

    syncSlide(view, animate = true) {
      const pz = view.pz;
      pz.tiles.forEach((number, cell) => {
        if (number === 0) return;
        const tile = view.tiles[number];
        const target = this.slideCellPos(cell);
        if (animate && tile.position.distanceTo(target) > .01) {
          const from = tile.position.clone();
          this.tween(.15, (p) => { tile.position.lerpVectors(from, target, 1 - (1 - p) * (1 - p)); });
        } else tile.position.copy(target);
        const right = PO.SlidePuzzle.SOLVED[cell] === number;
        tile.material.color.setRGB(...(right ? [.55, 1, .6] : [.75, .8, .9]));
      });
      view.lamp.material.color.setRGB(...(pz.solved ? [.3, 1, .4] : [1, .2, .15]));
    }

    buildTeleporter(t) {
      const dest = this.moon.sectors[t.dest];
      const root = group(this.world, t.x, 0, t.z);
      this.collide(mk(root, GEO.box, litMat([.32, .32, .37], { map: Textures.panel() }),
                      { bottom: true, scale: [5.5, .5, 5.5] }));
      for (let k = 0; k < 6; k++) {
        const a = 2 * Math.PI * k / 6;
        this.collide(mk(root, GEO.box, litMat([.4, .4, .45]),
                        { bottom: true, x: Math.cos(a) * 3.4, z: Math.sin(a) * 3.4, scale: [.35, 4.5, .35] }));
      }
      const ring = mk(root, GEO.circle, unlitMat([.4, .4, .45], .6), { y: .53, scale: 4.6, flat: true });
      const column = mk(root, GEO.box, unlitMat([.75, .45, 1], .18), { bottom: true, y: .5, scale: [3.6, 6, 3.6] });
      textSprite(root, `${t.puzzle === null ? "RETURN" : "TRANSPORTER"}\n> ${dest.name.toUpperCase()}`,
                 { y: 6.6, scale: 18, color: [.85, .7, 1] });
      const lamps = [];
      if (t.puzzle !== null) {
        const pz = this.moon.puzzles[t.puzzle];
        this.collide(mk(root, GEO.box, litMat([.3, .3, .34]), { bottom: true, x: -4.8, scale: [1.2, 2.2, 2.6] }));
        const n = pz.state.length;
        for (let i = 0; i < n; i++) {
          // the panel faces -x; seen from there the lamps read 1..n left to right
          const lz = -(i - (n - 1) / 2) * .5;
          lamps.push(mk(root, GEO.box, unlitMat([1, .2, .15]), { x: -5.45, y: 1.7, z: lz, scale: [.1, .35, .35] }));
          textPlane(root, String(i + 1), { x: -5.52, y: 2.15, z: lz, height: .3, rotY3: -Math.PI / 2 });
        }
        textSprite(root, "SWITCHES", { x: -4.8, y: 3.0, scale: 10, color: [1, 1, 1], alpha: .8 });
      }
      const view = { tp: t, ring, column, lamps };
      this.syncTeleporter(view);
      return view;
    }

    syncTeleporter(v) {
      const t = v.tp;
      v.column.visible = t.active;
      v.ring.material.color.setRGB(...(t.active ? [.75, .45, 1] : [.4, .4, .45]));
      v.ring.material.opacity = t.active ? .8 : .6;
      if (t.puzzle !== null) {
        const pz = this.moon.puzzles[t.puzzle];
        v.lamps.forEach((lamp, i) => lamp.material.color.setRGB(...(pz.state[i] ? [.3, 1, .4] : [1, .2, .15])));
      }
    }

    buildSwitch(pz, i) {
      const [x, z] = pz.positions[i];
      const root = group(this.world, x, 0, z);
      mk(root, GEO.box, litMat([.28, .28, .32]), { bottom: true, scale: [1.6, .4, 1.6] });
      this.collide(mk(root, GEO.box, litMat([.38, .38, .43]), { bottom: true, scale: [.6, 2.6, .6] }));
      const lamp = mk(root, GEO.box, unlitMat([1, .2, .15]), { y: 3.1, scale: 1 });
      this.collide(lamp, "switch", [pz.id, i]);
      const glow = glowSprite(lamp, [1, .2, .15], .5, 3.5);
      textSprite(root, `SWITCH ${i + 1}\nalso flips ${pz.links[i].map((j) => j + 1).join(", ")}`,
                 { y: 4.6, scale: 12, color: [1, 1, 1], alpha: .85 });
      const view = { pz, index: i, lamp, glow };
      this.syncSwitch(view);
      return view;
    }

    syncSwitch(v) {
      const c = v.pz.state[v.index] ? [.3, 1, .4] : [1, .2, .15];
      v.lamp.material.color.setRGB(...c);
      v.glow.material.color.setRGB(...c);
    }

    buildBreaker(b) {
      const root = group(this.world, b.x, 0, b.z);
      this.collide(mk(root, GEO.box, litMat([.3, .3, .34]), { bottom: true, scale: [1.4, 2.4, 1.4] }));
      mk(root, GEO.box, unlitMat(LATTICE_COLOURS[this.moon.cores[b.core].lattice]), { y: 1.4, scale: [1.5, .2, 1.5] });
      const button = mk(root, GEO.box, unlitMat(b.tripped ? [.3, 1, .4] : [1, .2, .15]), { y: 2.8, scale: .9 });
      this.collide(button, "breaker", b.id);
      glowSprite(button, [1, .3, .2], .5, 4);
      return button;
    }

    buildPack(p) {
      const c = { shield: [.35, .7, 1], fuel: [1, .6, .2], combo: [.4, 1, .5] }[p.kind];
      const root = group(this.world, p.x, 0, p.z);
      mk(root, GEO.circle, unlitMat(c, .35), { y: .04, scale: 2.4, flat: true });
      const box = mk(root, GEO.box, litMat(c, { map: Textures.panel() }), { y: 1.2, scale: .8 });
      glowSprite(box, c, .6, 3.5);
      return { pack: p, root, box };
    }

    // ---- effects ---------------------------------------------------------
    spark(pos, colour, n = 14, size = .3, speed = 8.0) {
      for (let i = 0; i < n; i++) {
        const e = new THREE.Mesh(GEO.box, unlitMat(colour));
        e.scale.setScalar(size);
        e.position.copy(pos);
        this.worldFx.add(e);
        const v = new THREE.Vector3(rand(-1, 1), rand(-.2, 1.2), rand(-1, 1));
        const to = pos.clone().addScaledVector(v, speed * rand(.3, 1));
        const from = pos.clone();
        this.tween(.7, (p) => { e.position.lerpVectors(from, to, 1 - Math.pow(2, -10 * p)); });
        this.tween(.8, (p) => { e.scale.setScalar(Math.max(0.001, size * (1 - p))); });
        this.removeLater(e, .85);
      }
    }

    explode(pos, colour) {
      this.spark(pos, colour, 26, .45, 9);
      const flash = glowSprite(this.worldFx, colour, .9, 2);
      flash.position.copy(pos);
      this.tween(.35, (p) => { const s = 2 + 14 * (1 - Math.pow(2, -10 * p)); flash.scale.set(s, s, 1); });
      this.tween(.4, (p) => { flash.material.opacity = .9 * (1 - p); });
      this.removeLater(flash, .45);
    }

    laser(end) {
      const start = this.muzzle.getWorldPosition(new THREE.Vector3());
      const d = end.clone().sub(start);
      const beam = new THREE.Mesh(GEO.box, unlitMat([.6, 1, .9], .999));
      beam.scale.set(.06, .06, d.length());
      beam.position.copy(start.clone().addScaledVector(d, .5));
      beam.lookAt(end);
      this.worldFx.add(beam);
      this.tween(.12, (p) => { beam.material.opacity = 1 - p; });
      this.removeLater(beam, .15);
    }

    _buildGun() {
      this.gun = new THREE.Mesh(GEO.box, litMat([.35, .37, .42]));
      this.gun.scale.set(0.018, 0.018, 0.2);
      this.gun.position.set(0.2, -0.16, -0.5);
      this.camera.add(this.gun);
      const grip = new THREE.Mesh(GEO.box, litMat([.2, .21, .24]));
      grip.scale.set(1.3, 0.5, 0.25);
      grip.position.set(0, -0.6, 0.3);
      this.gun.add(grip);
      this.muzzle = new THREE.Object3D();
      this.muzzle.position.set(0, 0, -0.55);
      this.gun.add(this.muzzle);
    }

    // ---- actions ---------------------------------------------------------
    fire() {
      if (this.shotTimer > 0) return;
      this.shotTimer = SHOT_COOLDOWN;
      const origin = this.camera.getWorldPosition(new THREE.Vector3());
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      const hit = this.raycast(origin, dir, 400);
      const end = hit.hit ? hit.point.clone() : origin.clone().addScaledVector(dir, 400);
      this.laser(end);
      this.sfx.play("laser", .45, rand(.94, 1.06));
      if (!hit.hit) return;
      const ud = hit.object.userData, kind = ud.kind, m = this.moon;
      if (kind === "core") {
        const core = m.cores[ud.ref];
        const result = m.shootCore(core.id);
        if (result === "destroyed") {
          this.explode(hit.object.getWorldPosition(new THREE.Vector3()), LATTICE_COLOURS[core.lattice]);
          this.sfx.play("explosion", .9, rand(.9, 1.1));
        } else if (result === "refracted") {
          this.spark(end, [.8, .9, 1], 8, .2);
          this.sfx.play("deflect", .6, .8);
          this.hud.say("Refracted! Only a beam from the relay emitter can reach this core.", [.8, .9, 1]);
        }
      } else if (kind === "relay") {
        m.rotateRelay(ud.ref);
        const head = ud.head, from = head.rotation.y, to = from - 45 * DEG;
        this.tween(.2, (p) => { head.rotation.y = lerp(from, to, 1 - (1 - p) * (1 - p)); });
        this.sfx.play("switch", .6, .9);
      } else if (kind === "emitter") {
        this.fireRelayBeam(ud.ref);
      } else if (kind === "ward") {
        this.sfx.play("deflect", .6);
        this.hud.say("Shot deflected by a ward. Find its breaker.", [.7, .9, 1]);
        this.spark(end, [.7, .9, 1], 8, .2);
      } else if (kind === "breaker") {
        if (m.tripBreaker(ud.ref)) {
          hit.object.material.color.setRGB(.3, 1, .4);
          this.spark(end, [.3, 1, .4]);
          this.sfx.play("switch", .8, .8);
        }
      } else if (kind === "switch") {
        const [pid, idx] = ud.ref;
        if (m.puzzles[pid].solved) {
          this.hud.say("This transporter is already powered.", [.85, .7, 1]);
        } else {
          m.pressSwitch(pid, idx);
          this.spark(end, [.85, .7, 1], 8, .18);
          this.sfx.play("switch", .8);
        }
        this.switchViews.forEach((v) => this.syncSwitch(v));
        this.padViews.forEach((v) => this.syncTeleporter(v));
      } else if (kind === "slide") {
        const [pid, number] = ud.ref;
        const pz = m.slides[pid];
        if (!pz.solved) {
          if (m.slideTile(pid, pz.tiles.indexOf(number))) this.sfx.play("switch", .6, 1.2);
          else this.sfx.play("deflect", .3, .6);
        }
        this.slideViews.forEach((v) => this.syncSlide(v));
      } else if (kind === "drone") {
        this.spark(end, [1, .4, .3], 8, .2);
        if (m.damageDrone() && this.droneView) {
          this.explode(this.droneView.root.position.clone(), [1, .4, .2]);
          this.sfx.play("explosion", 1, .8);
          this.removeDroneView();
        } else this.sfx.play("hit", .5, 1.6);
      } else if (kind === "sentry") {
        m.killSentry(ud.ref);
        for (const s of this.sentryViews) {
          if (s.data.id === ud.ref) {
            this.explode(s.head.getWorldPosition(new THREE.Vector3()), [1, .5, .2]);
            s.head.visible = false;
            s.body.userData.off = true;
          }
        }
        this.sfx.play("explosion", .8, 1.3);
        this.hud.say("Sentry destroyed.", [1, .7, .4]);
      } else {
        this.spark(end, [.6, 1, .9], 4, .12, 3);
      }
    }

    playerHit() {
      this.moon.player.damage(BOLT_DAMAGE);
      this.sfx.play("hit", .9);
      this.tween(.15, () => { this.shake.set(rand(-.15, .15), rand(-.15, .15), 0); },
                 () => this.shake.set(0, 0, 0));
      if (this.moon.player.shield < 30) {
        this.hud.say("SHIELD LOW - find a power pack or take cover", [1, .3, .25], 2);
      }
      const f = el("div", "hitflash", document.getElementById("ui"));
      setTimeout(() => f.classList.add("fade"), 20);
      setTimeout(() => f.remove(), 400);
    }

    handleEvents() {
      const m = this.moon;
      for (const ev of m.popEvents()) {
        const kind = ev[0];
        if (["linked", "rebuilt", "severed", "ward_down"].includes(kind)) {
          const core = m.cores[ev[1]];
          const c = LATTICE_COLOURS[core.lattice];
          if (kind === "linked") {
            const names = m.neighbours(core).map((n) => m.sectors[n.sector].name).join(" & ");
            this.hud.say(`Core destroyed, but it is still linked to ${names}.`, c);
          } else if (kind === "rebuilt") {
            if (core.sector === this.sectorId) {
              this.hud.say("The core has rebuilt itself.", c);
              this.sfx.play("rebuild", .7);
            }
          } else if (kind === "severed") {
            this.hud.say(`Core severed for good. Output x${core.output.toFixed(1)} lost.`, c);
          } else {
            this.hud.say("Ward down! The core is exposed.", c);
            this.sfx.play("power_up", .6, 1.3);
          }
        } else if (kind === "gate_unlocked") {
          const [, here, vault] = ev;
          this.hud.say(`GATE UNLOCKED - the way to ${m.sectors[vault].name} is open`, [1, .75, .35], 6);
          this.sfx.play("power_up", .9, .9);
          if (this.sectorId === here) this.rebuildGate(vault);
        } else if (kind === "drone_alert") {
          this.hud.say("A HUNTER DRONE has been launched. It is tracking you.", [1, .35, .3], 6);
          this.sfx.play("beep", .6, .6);
        } else if (kind === "drone_moved") {
          if (ev[1] === this.sectorId) {
            this.spawnDroneView(ev[2]);
            this.hud.say("The hunter drone has entered this sector!", [1, .3, .25]);
            this.sfx.play("denied", .7, 1.4);
          }
        } else if (kind === "drone_down") {
          this.hud.say("Hunter drone destroyed. It will be back.", [.6, 1, .7]);
        } else if (kind === "lattice_down") {
          this.hud.say("LATTICE DESTROYED", LATTICE_COLOURS[ev[1]], 6);
          this.sfx.play("fanfare", .7);
        } else if (kind === "transporter_on") {
          this.hud.say(`TRANSPORTER POWERED - route open to ${m.sectors[m.teleporters[ev[1]].dest].name}`, [.85, .7, 1], 6);
          this.sfx.play("power_up", .8);
        } else if (kind === "pack") {
          this.hud.say({ shield: "+ shield", fuel: "+ jetpack fuel", combo: "+ shield & fuel" }[ev[1]], [.6, 1, .7]);
          this.sfx.play("pickup", .7);
        } else if (kind === "won") {
          this.victoryFinale();
        } else if (kind === "lost") {
          if (ev[1] === "lance") {
            this.lanceFinale();
          } else {
            this.playerDeath();
          }
        }
      }
    }

    // ---- player ----------------------------------------------------------
    updatePlayer(dt) {
      const p = this.player, k = this.keys;
      const yaw = p.yaw * DEG;
      const fwd = [Math.sin(yaw), 0, Math.cos(yaw)], right = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const f = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
      const r = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
      let dx = fwd[0] * f + right[0] * r, dz = fwd[2] * f + right[2] * r;
      const dl = Math.hypot(dx, dz);
      if (dl > 0) {
        dx /= dl; dz /= dl;
        const speed = WALK_SPEED * (k.has("ShiftLeft") || k.has("ShiftRight") ? 1.6 : 1.0);
        for (const axis of [[dx * speed * dt, 0], [0, dz * speed * dt]]) {
          const len = Math.abs(axis[0]) + Math.abs(axis[1]);
          if (len === 0) continue;
          const d = [Math.sign(axis[0]), 0, Math.sign(axis[1])];
          const hit = [0.7, 1.4, EYE_HEIGHT].some((h) => this.blocked(p.x, p.y + h, p.z, d, len + 0.6));
          if (!hit) { p.x += axis[0]; p.z += axis[1]; }
        }
      }
      const lim = SECTOR_HALF_SIZE - 1;
      p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);

      // jetpack + gravity
      p.thrusting = this.moon.player.update(dt, k.has("Space"), p.grounded);
      p.vy -= GRAVITY * dt;
      if (p.thrusting) { p.vy = Math.min(MAX_RISE, p.vy + THRUST * dt); p.grounded = false; }
      if (p.vy > 0 && (p.y > CEILING || this.blocked(p.x, p.y + EYE_HEIGHT, p.z, [0, 1, 0], p.vy * dt + 0.3))) {
        p.vy = 0;
      }
      const ray = this.raycast(V(p.x, p.y + 1.0, p.z), new THREE.Vector3(0, -1, 0));
      let groundY = ray.hit ? ray.point.y : 0.0;
      const overChasm = this.moon.overChasm(this.sectorId, p.x, p.z);
      if (overChasm && (!ray.hit || ray.object === this.ground)) groundY = -1000;
      const newY = p.y + p.vy * dt;
      if (p.vy <= 0 && newY <= groundY + 0.01) {
        p.y = groundY; p.vy = 0; p.grounded = true;
      } else {
        p.y = newY;
        p.grounded = p.y <= groundY + 0.05;
      }
      if (!overChasm) {
        p.y = Math.max(p.y, 0);
        if (p.grounded) p.safe = { x: p.x, y: p.y, z: p.z };
      } else if (p.y < -12) {
        this.fellInChasm();
      }
    }

    placeCamera() {
      const p = this.player;
      this.camera.position.copy(V(p.x, p.y + EYE_HEIGHT - this.eyeDrop, p.z)).add(this.shake);
      this.camera.rotation.set(-p.pitch * DEG, -p.yaw * DEG, this.roll * DEG);
    }

    // ---- loop ------------------------------------------------------------
    update(dt) {
      this._runTweens(dt);
      if (this.map && this.map.enabled) {
        const k = this.keys, speed = 90 * dt;
        const dx = (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0);
        const dy = (k.has("ArrowUp") || k.has("KeyW") ? 1 : 0) - (k.has("ArrowDown") || k.has("KeyS") ? 1 : 0);
        if (dx || dy) this.map.scroll(dx * speed, dy * speed);
      }
      this.placeCamera();
      this.scene.updateMatrixWorld();
      if (this.hud) this.hud.update();
      for (const v of this.coreViews) {
        v.t += dt;
        v.gem.rotation.y -= 60 * DEG * dt;
        v.gem.position.y = v.core.height + 2.0 + Math.sin(v.t * 2) * 0.25;
        if (v.ward) v.ward.rotation.y += 20 * DEG * dt;
        this.syncCore(v);
      }
      if (!this.active) { this.sfx.setLoops(0, 0, lanceStage(this.moon.charge)); return; }
      this.updateLighting(dt);
      const charge = this.moon.charge;
      // the Lance's hum grows louder as it charges, and throbs faster with a
      // deeper bass each time the topmost black rectangle turns red
      this.sfx.setLoops(this.player.thrusting ? .5 : 0, .25 + .35 * charge, lanceStage(charge));
      if (this.moon.timeToFire < 120) {
        this.beepTimer -= dt;
        if (this.beepTimer <= 0) {
          const final = this.moon.timeToFire < 30;
          this.beepTimer = final ? 1.0 : 2.0;
          this.sfx.play("beep", final ? .1 : .06);
        }
      }
      this.shotTimer = Math.max(0, this.shotTimer - dt);
      this.moon.update(dt);
      this.updatePlayer(dt);
      this.placeCamera();
      this.camera.updateMatrixWorld();
      if (this.mouseDown) this.fire();
      for (const s of this.sentryViews) this.updateSentry(s, dt);
      this.updateDrone(dt);
      this.updateBolts(dt);
      if (!this.active) return;            // a hit may have ended the game
      const p = this.player;
      for (const pv of [...this.packViews]) {
        pv.box.rotation.y -= 90 * DEG * dt;
        pv.box.position.y = 1.2 + Math.sin(this.moon.elapsed * 3 + pv.pack.x) * .2;
        if (Math.hypot(pv.pack.x - p.x, pv.pack.z - p.z) < 2.0 && p.y < 3) {
          this.moon.collectPack(pv.pack.id);
          this.spark(pv.box.getWorldPosition(new THREE.Vector3()), [.6, 1, .7], 10, .2);
          this.packViews.splice(this.packViews.indexOf(pv), 1);
          this.world.remove(pv.root);
          disposeTree(pv.root);
        }
      }
      // gates and transporter pads
      this.gateCooldown -= dt;
      this.sealedMsgTimer -= dt;
      if (this.gateCooldown <= 0) {
        const sec = this.moon.sectors[this.sectorId];
        for (let g = 0; g < 3; g++) {
          const n = sec.neighbours[g];
          const [gx, gz] = gatePosition(g);
          const dd = Math.hypot(p.x - gx, p.z - gz);
          if (dd < 4.5 && p.y < 8) {
            const state = this.moon.gateState(this.sectorId, n);
            if (state !== "open") {
              if (this.sealedMsgTimer <= 0) {
                this.sealedMsgTimer = 5;
                this.sfx.play("denied", .6);
                const name = this.moon.sectors[n].name;
                const msg = { sealed: `${name} is sealed. There must be another way in.`,
                              rubble: "This gate is blocked by rockfall.",
                              locked: this.lockedMessage(n) }[state];
                this.hud.say(msg, [1, .5, .4]);
              }
            } else if (dd < 2.6 && p.y < 5) {
              this.sfx.play("whoosh", .7);
              this.loadSector(n, this.sectorId);
              this.hud.say(this.moon.sectors[n].name.toUpperCase(), [.7, .95, 1]);
              this.handleEvents();
              return;
            }
          }
        }
        for (const pv of this.padViews) {
          const t = pv.tp;
          if (Math.hypot(p.x - t.x, p.z - t.z) < 2.0 && p.y < 2) {
            if (t.active) {
              const origin = this.sectorId;
              this.sfx.play("whoosh", .8, .7);
              this.loadSector(t.dest, origin, true);
              this.hud.say(`TRANSPORTED TO ${this.moon.sectors[t.dest].name.toUpperCase()}`, [.85, .7, 1]);
              this.handleEvents();
              return;
            } else if (this.sealedMsgTimer <= 0) {
              this.sealedMsgTimer = 5;
              this.sfx.play("denied", .6);
              this.hud.say("Transporter unpowered. Set every switch in this sector to green.", [.85, .7, 1]);
            }
          }
        }
      }
      for (const [mat, ca, cb, period] of this.pulsers) {
        const t = .5 + .5 * Math.sin(this.moon.elapsed * 2 * Math.PI / period);
        mat.color.setRGB(lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t));
        if (mat.transparent) mat.opacity = lerp(ca[3], cb[3], t);
      }
      this.labelTimer -= dt;
      if (this.labelTimer <= 0) {
        this.labelTimer = 1.0;
        for (const [text, dest] of Object.values(this.gateLabels)) {
          setSpriteText(text, `> ${this.moon.sectors[dest].name.toUpperCase()}\n${this.sunLabel(dest)}`);
        }
      }
      if (this.lanceTip) {
        const pulse = .6 + .4 * Math.sin(this.moon.elapsed * (2 + 10 * this.moon.charge));
        const s = 40 + 60 * this.moon.charge + 10 * pulse;
        this.lanceTip.scale.set(s, s, 1);
      }
      this.handleEvents();
    }

    // ---- input -----------------------------------------------------------
    onKey(code) {
      this.sfx.start();
      if (this.finale) {                 // skip the sequence (Enter, after a moment)
        if (code === "Enter" && this.canSkipFinale()) this.finishFinale();
        return;
      }
      if (this.overlay && !this.active) {
        if (this.pausedByPointer) {
          if (code === "Enter") this.begin(true);
          else if (code === "KeyQ") this.quitToTitle();
          else if (code === "F5") {
            this.saveGame();
            if (this.pauseNote) this.pauseNote.textContent = "Game saved.";
          }
          return;
        }
        const playing = this.moon.state === "playing";
        if (playing && code === "Enter") this.begin();
        else if (code === "KeyL") this.loadGame();
        else if (playing && code === "KeyD") {
          this.hunter = !this.hunter;
          this.moon.drone.enabled = this.hunter;
          this.refreshOptions();
        } else if (playing && code === "KeyT") {
          const L = Moon.GAME_LENGTHS;
          this.gameLength = L[(L.indexOf(this.gameLength) + 1) % L.length] || Moon.FULL_CHARGE_TIME;
          this.moon.fullChargeTime = this.gameLength;
          this.moon._fireCache = null;
          this.refreshOptions();
        } else if (playing && code === "KeyS") {
          const v = window.prompt("Moon seed (a whole number):", String(this.moon.seed));
          if (v !== null && /^\s*\d+\s*$/.test(v)) this.newGame(parseInt(v, 10));
        } else if (!playing && code === "KeyR") this.newGame();
        else if (!playing && code === "KeyA") { this.newGame(this.moon.seed); this.begin(); }
        else if (!playing && code === "KeyQ") this.newGame();
        return;
      }
      if (code === "Tab") {
        this.map.enabled = !this.map.enabled;
        this.active = !this.map.enabled;
        return;
      }
      if (this.map.enabled) {
        if (code === "KeyC") { this.map.centre(); this.map.draw(); }
        return;     // the game is paused: ignore save/load etc. while the map is up
      }
      if (code === "F5") this.saveGame();
      if (code === "F9") { this.loadGame(); return; }
      if (code === "KeyM") {
        const muted = this.sfx.toggleMute();
        this.hud.say(muted ? "Sound off" : "Sound on", [1, 1, 1], 1.5);
      }
    }

    onClick() {
      this.sfx.start();
      if (this.finale) { if (this.canSkipFinale()) this.finishFinale(); return; }
      if (this.overlay && !this.active) {
        if (this.pausedByPointer) this.begin(true);
        else if (this.moon.state === "playing") this.begin();
        return;
      }
      if (!document.pointerLockElement) this.lockPointer();
    }

    onPointerLockChange() {
      const locked = document.pointerLockElement === this.renderer.domElement;
      if (!locked && this.active && !this.map.enabled && this.moon.state === "playing") this.showPause();
    }

    onMouseMove(e) {
      if (this.map && this.map.enabled && (e.buttons & 1)) {
        // drag the map: the moon turns under the mouse
        this.map.scroll(-e.movementX * 0.25, e.movementY * 0.25);
        return;
      }
      if (!this.active || document.pointerLockElement !== this.renderer.domElement) return;
      const p = this.player;
      p.yaw += e.movementX * this.sensitivity;
      p.pitch = clamp(p.pitch + e.movementY * this.sensitivity, -89, 89);
    }
  }

  // ------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------
  function boot() {
    THREE.ColorManagement.enabled = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById("view").appendChild(renderer.domElement);
    const params = new URLSearchParams(location.search);
    const seed = params.has("seed") && /^\d+$/.test(params.get("seed"))
      ? parseInt(params.get("seed"), 10) : null;
    const game = new Game(renderer, seed);
    root.PALE_ORBIT = game;    // handy for debugging from the console

    const block = new Set(["Tab", "F5", "F9", "Space", "ArrowUp", "ArrowDown", "ArrowLeft",
                           "ArrowRight"]);
    window.addEventListener("keydown", (e) => {
      if (block.has(e.code)) e.preventDefault();
      if (!e.repeat) game.onKey(e.code);
      game.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => game.keys.delete(e.code));
    window.addEventListener("blur", () => { game.keys.clear(); game.mouseDown = false; });
    renderer.domElement.addEventListener("mousedown", (e) => {
      if (game.map.enabled) return;            // dragging the map
      if (e.button === 0) {
        if (game.active && document.pointerLockElement) game.mouseDown = true;
        else game.onClick();
      }
    });
    document.getElementById("ui").addEventListener("mousedown", (e) => {
      if (e.button === 0) game.onClick();
    });
    window.addEventListener("mouseup", (e) => { if (e.button === 0) game.mouseDown = false; });
    document.addEventListener("mousemove", (e) => game.onMouseMove(e));
    document.addEventListener("pointerlockchange", () => game.onPointerLockChange());
    window.addEventListener("resize", () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      game.camera.aspect = window.innerWidth / window.innerHeight;
      game.camera.updateProjectionMatrix();
      if (game.map.enabled) game.map.draw();
    });
    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      game.update(dt);
      renderer.render(game.scene, game.camera);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  root.PO = Object.assign(root.PO || {}, { Game, boot, binaryCounter, lanceStage });
})(typeof globalThis !== "undefined" ? globalThis : this);
