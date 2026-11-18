/*
 * Procedural textures drawn on canvases (the Python version used PIL).
 */
(function (root) {
  "use strict";
  const { PyRandom } = root.PO;
  const cache = new Map();

  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  function noiseFill(ctx, w, h, base, spread, rng) {
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      // sum of uniforms ~ gaussian, like PIL's effect_noise
      const g = (rng() + rng() + rng() - 1.5) * 2;
      const v = Math.max(0, Math.min(255, base + g * spread));
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function texture(cnv, repeat) {
    const tex = new THREE.CanvasTexture(cnv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    if (repeat) tex.repeat.set(repeat[0], repeat[1]);
    return tex;
  }

  /** Grey lunar ground with baked craters and a faint survey grid. */
  function regolithCanvas(seed, size = 1024) {
    const key = "ground:" + seed;
    if (cache.has(key)) return cache.get(key);
    const rng = new PyRandom(seed);
    const cnv = canvas(size, size), ctx = cnv.getContext("2d");
    noiseFill(ctx, size, size, 150, 28 * 0.35, Math.random);
    for (let k = 0; k < 140; k++) {
      const r = Math.floor(rng.expovariate(1 / 14)) + 4;
      const x = rng.randrange(size), y = rng.randrange(size);
      const ell = (cx, cy, rx, ry, fill) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(.5, rx), Math.max(.5, ry), 0, 0, Math.PI * 2);
        ctx.fill();
      };
      ell(x, y, r + 2, r + 2, "rgba(205,205,210,0.27)");
      ell(x, y, r, r, "rgba(80,80,88,0.47)");
      ell(x + r * 0.075, y + r * 0.075, r * 0.775, r * 0.775, "rgba(60,60,66,0.35)");
    }
    // soften, then draw the survey grid on top
    const soft = canvas(size, size), sctx = soft.getContext("2d");
    sctx.filter = "blur(1.2px)";
    sctx.drawImage(cnv, 0, 0);
    sctx.filter = "none";
    const step = Math.floor(size / 24);
    sctx.strokeStyle = "rgba(255,255,255,0.063)";
    sctx.lineWidth = 1;
    for (let i = 0; i < size; i += step) {
      sctx.beginPath(); sctx.moveTo(i + .5, 0); sctx.lineTo(i + .5, size); sctx.stroke();
      sctx.beginPath(); sctx.moveTo(0, i + .5); sctx.lineTo(size, i + .5); sctx.stroke();
    }
    cache.set(key, soft);
    return soft;
  }

  /** Tileable hull plating for buildings. */
  function panelCanvas() {
    if (cache.has("panel")) return cache.get("panel");
    const cnv = canvas(128, 128), ctx = cnv.getContext("2d");
    ctx.fillStyle = "rgb(205,205,210)";
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = "rgb(150,150,158)"; ctx.lineWidth = 2;
    for (let y = 0; y < 128; y += 32) { ctx.beginPath(); ctx.moveTo(0, y + 1); ctx.lineTo(128, y + 1); ctx.stroke(); }
    ctx.strokeStyle = "rgb(165,165,172)"; ctx.lineWidth = 1;
    for (let x = 0; x < 128; x += 64) { ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, 128); ctx.stroke(); }
    ctx.fillStyle = "rgb(140,140,148)";
    for (const [x, y] of [[6, 6], [58, 6], [6, 38], [58, 38], [6, 70], [58, 70], [6, 102], [58, 102]]) {
      ctx.beginPath(); ctx.arc(x + 1.5, y + 1.5, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    const img = ctx.getImageData(0, 0, 128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 40;
      for (let c = 0; c < 3; c++) img.data[i + c] = img.data[i + c] * 0.88 + n * 0.12;
    }
    ctx.putImageData(img, 0, 0);
    cache.set("panel", cnv);
    return cnv;
  }

  function glowCanvas() {
    if (cache.has("glow")) return cache.get("glow");
    const s = 128, cnv = canvas(s, s), ctx = cnv.getContext("2d");
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const d = Math.hypot(x - s / 2, y - s / 2) / (s / 2);
        const a = Math.max(0, 1 - d) ** 2.2;
        const i = (y * s + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.floor(255 * a);
      }
    }
    ctx.putImageData(img, 0, 0);
    cache.set("glow", cnv);
    return cnv;
  }

  const texCache = new Map();
  function cachedTexture(key, makeCanvas, repeat) {
    const k = key + ":" + (repeat ? repeat.map((v) => v.toFixed(2)).join("x") : "1");
    if (!texCache.has(k)) texCache.set(k, texture(makeCanvas(), repeat));
    return texCache.get(k);
  }

  root.PO = Object.assign(root.PO || {}, {
    Textures: {
      regolith: (seed) => cachedTexture("ground" + seed, () => regolithCanvas(seed), [8, 8]),
      panel: (repeat) => cachedTexture("panel", panelCanvas, repeat),
      glow: () => cachedTexture("glow", glowCanvas),
    },
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
