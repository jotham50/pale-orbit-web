// Render a tour of the game to PNGs with headless Chromium (Playwright).
//   node tools/screenshots.js OUT_DIR [seed]
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const out = process.argv[2] || "screenshots";
const seed = process.argv[3] || "2026";
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
           "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
  const url = "file://" + path.resolve(__dirname, "..", "index.html") + "?seed=" + seed;
  await page.goto(url);
  await page.waitForTimeout(2000);

  // helpers inside the page
  await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon, PO = window.PO;
    const V = (x, y, z) => new THREE.Vector3(x, y, -z);
    window.tour = {
      aim(pos, target, yawOffset = 0) {
        const p = g.player;
        Object.assign(p, { x: pos[0], y: pos[1], z: pos[2], vy: 0 });
        const dx = target[0] - pos[0], dy = target[1] - (pos[1] + 2.7), dz = target[2] - pos[2];
        p.yaw = Math.atan2(dx, dz) * 180 / Math.PI + yawOffset;
        p.pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
        g.placeCamera(); g.scene.updateMatrixWorld(true);
      },
      clearView(target, ok, dists = [26, 32, 38, 20]) {
        for (const d of dists) {
          for (let k = 0; k < 36; k++) {
            const a = k * 10 * Math.PI / 180;
            const pos = [target[0] + Math.cos(a) * d, 0, target[2] + Math.sin(a) * d];
            if (Math.max(Math.abs(pos[0]), Math.abs(pos[2])) > 60) continue;
            const eye = V(pos[0], 2.7, pos[2]);
            const to = V(...target).sub(eye);
            const hit = g.raycast(eye, to.clone(), to.length() + 1);
            const near = g.raycast(eye, V(Math.cos(a), 0, Math.sin(a)), 8);
            if (hit.hit && ok(hit.object.userData) && !near.hit) return pos;
          }
        }
        return [0, 0, 0];
      },
      core(sector, prefer) {
        const cs = m.coresIn(sector).sort((a, b) => (prefer ? (a.warded - b.warded) || (a.relayLocked - b.relayLocked) : 0) || b.height - a.height);
        return cs[0];
      },
    };
  });

  const shots = [];
  async function shot(name, setup, wait = 700) {
    if (setup) await page.evaluate(setup);
    await page.waitForTimeout(wait);
    const file = path.join(out, name + ".png");
    await page.screenshot({ path: file });
    shots.push(file);
  }

  await shot("01_title");
  await shot("02_start", () => PALE_ORBIT.begin(), 900);
  await shot("03_dayside_core", () => {
    const g = PALE_ORBIT, m = g.moon;
    const s = [...Array(20).keys()].sort((a, b) => (m.sectors[b].sunlight - m.sectors[a].sunlight) || (m.coresIn(b).length - m.coresIn(a).length))[0];
    g.loadSector(s);
    const c = tour.core(s);
    const pos = tour.clearView([c.x, c.height + 2, c.z], (u) => u.kind === "core" || u.kind === "ward");
    tour.aim(pos, [c.x, c.height * .55, c.z], -10);
  });
  await shot("04_nightside", () => {
    const g = PALE_ORBIT, m = g.moon;
    const s = [...Array(20).keys()].filter((i) => m.sectors[i].sunlight === 0)
      .sort((a, b) => m.coresIn(b).length - m.coresIn(a).length)[0];
    g.loadSector(s);
    const c = tour.core(s);
    const pos = tour.clearView([c.x, c.height + 2, c.z], (u) => u.kind === "core" || u.kind === "ward");
    tour.aim(pos, [c.x, c.height * .55, c.z], -10);
  });
  await shot("05_sentry_and_cover", () => {
    const g = PALE_ORBIT, m = g.moon;
    const s = [...Array(20).keys()].sort((a, b) => (m.sentriesIn(b).length - m.sentriesIn(a).length) || (m.sectors[b].sunlight - m.sectors[a].sunlight))[0];
    g.loadSector(s);
    const st = m.sentriesIn(s)[0];
    const pos = tour.clearView([st.x, 3.3, st.z], (u) => u.kind === "sentry", [18, 24, 30]);
    tour.aim(pos, [st.x, 2.5, st.z], 8);
    g.moon.player.shield = 100;
  }, 500);
  await shot("06_sealed_gate", () => {
    const g = PALE_ORBIT, m = g.moon;
    const sec = [...m.sealed].sort((a, b) => a - b)[0];
    const nb = m.sectors[sec].neighbours[0];
    g.loadSector(nb);
    const [gx, gz] = PO.gatePosition(m.sectors[nb].neighbours.indexOf(sec));
    tour.aim([gx * .8, 0, gz * .8], [gx, 3.5, gz]);
  });
  await shot("07_transporter_and_switches", () => {
    const g = PALE_ORBIT, m = g.moon;
    const pz = m.puzzles[0], tp = m.teleporters[pz.teleporter];
    g.loadSector(pz.sector);
    tour.aim([tp.x - 9, 0, tp.z], [tp.x - 5.45, 1.9, tp.z]);
  });
  await shot("08_switch", () => {
    const g = PALE_ORBIT, m = g.moon, pz = m.puzzles[0];
    const i = pz.positions.findIndex(([x, z]) => !m.silos.some((s) => s.contains(x, z)));
    const [x, z] = pz.positions[i];
    const pos = tour.clearView([x, 3, z], (u) => u.kind === "switch", [9, 12, 15]);
    tour.aim(pos, [x, 3, z]);
  });
  await shot("09_slide_puzzle", () => {
    const g = PALE_ORBIT, m = g.moon, pz = m.slides[0];
    g.loadSector(pz.sector);
    const l = Math.hypot(pz.x, pz.z);
    tour.aim([pz.x - pz.x / l * 11, 0, pz.z - pz.z / l * 11], [pz.x, 4.3, pz.z]);
  });
  await shot("10_relay_puzzle", () => {
    const g = PALE_ORBIT, m = g.moon, rp = m.relayPuzzles[0];
    g.loadSector(rp.sector);
    const core = m.cores[rp.core];
    const xs = [rp.ex, core.x, ...rp.relays.slice(0, -1).map((i) => m.relays[i].x)];
    const zs = [rp.ez, core.z, ...rp.relays.slice(0, -1).map((i) => m.relays[i].z)];
    const cx = xs.reduce((a, b) => a + b) / xs.length, cz = zs.reduce((a, b) => a + b) / zs.length;
    const dx = rp.ex - cx, dz = rp.ez - cz, r = Math.max(1, Math.hypot(dx, dz));
    tour.aim([cx + dx / r * (r + 14), 12, cz + dz / r * (r + 14)], [cx, 2, cz]);
    for (const rid of rp.relays) { const rel = m.relays[rid]; if (rel.solution !== null) rel.facing = rel.solution; }
    g.loadSector(rp.sector);
    tour.aim([cx + dx / r * (r + 14), 12, cz + dz / r * (r + 14)], [cx, 2, cz]);
    g.fireRelayBeam(rp.id);
  }, 250);
  await shot("11_chasm", () => {
    const g = PALE_ORBIT, m = g.moon, ch = m.chasms[0];
    g.loadSector(ch.sector);
    const [ux, uz] = ch.axis, near = ch.d - ch.width / 2 - 6;
    tour.aim([ux * near, 0, uz * near], [ux * (ch.d + 20), 0, uz * (ch.d + 20)]);
  });
  await shot("12_silo", () => {
    const g = PALE_ORBIT, m = g.moon, silo = m.silos[0];
    g.loadSector(silo.sector);
    const l = Math.max(1, Math.hypot(silo.x, silo.z));
    tour.aim([silo.x - silo.x / l * 7, silo.height + 5, silo.z - silo.z / l * 7], [silo.x, 0, silo.z]);
  });
  await shot("13_hunter_drone", () => {
    const g = PALE_ORBIT, m = g.moon;
    Object.assign(m.drone, { enabled: true, active: true, alive: true, sector: g.sectorId });
    tour.aim([0, 0, 0], [0, 4, 30]);
    g.spawnDroneView(null);
    const p = g.player, yaw = p.yaw * Math.PI / 180;
    g.droneView.pos = { x: Math.sin(yaw) * 14, y: 8, z: Math.cos(yaw) * 14 };
  }, 120);
  await shot("14_map", () => { PALE_ORBIT.onKey("Tab"); }, 400);
  await shot("15_end", () => { PALE_ORBIT.onKey("Tab"); PALE_ORBIT.endScreen(false, "lance"); }, 400);
  console.log(shots.map((s) => path.basename(s)).join(" "));
  console.log(problems.length ? problems.join("\n") : "no page errors");
  await browser.close();
})();
