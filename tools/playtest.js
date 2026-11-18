// Scripted play test in headless Chromium: drives the real game loop.
//   node tools/playtest.js [index.html|pale-orbit.html]
const path = require("path");
const { chromium } = require("playwright");
const page_ = process.argv[2] || "index.html";

(async () => {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  await page.goto("file://" + path.resolve(__dirname, "..", page_) + "?seed=2026");
  await page.waitForTimeout(1500);
  const step = (ms) => page.waitForTimeout(ms);
  // wait for a span of *game* time (the headless software renderer is slow)
  const gameWait = async (seconds) => {
    const start = await page.evaluate(() => PALE_ORBIT.moon.elapsed);
    for (let i = 0; i < 400; i++) {
      await page.waitForTimeout(50);
      const t = await page.evaluate(() => PALE_ORBIT.moon.elapsed);
      if (t - start >= seconds) return;
    }
  };
  const results = [];
  const check = (name, ok, info = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name} ${info}`);

  await page.evaluate(() => PALE_ORBIT.begin());
  await step(300);

  // 1. walk through an open gate using the keyboard
  const gateInfo = await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon, sec = m.sectors[g.sectorId];
    const gi = [0, 1, 2].find((i) => m.gateState(g.sectorId, sec.neighbours[i]) === "open");
    const [gx, gz] = PO.gatePosition(gi);
    const l = Math.hypot(gx, gz);
    Object.assign(g.player, { x: gx - gx / l * 6, z: gz - gz / l * 6, y: 0,
                              yaw: Math.atan2(gx, gz) * 180 / Math.PI, pitch: 0 });
    return { from: g.sectorId, to: sec.neighbours[gi] };
  });
  await page.keyboard.down("KeyW");
  await gameWait(1.2);
  await page.keyboard.up("KeyW");
  const now = await page.evaluate(() => PALE_ORBIT.sectorId);
  check("walk through a gate into the next sector", now === gateInfo.to, `(${gateInfo.from} -> ${now})`);

  // 2. jetpack lifts the player and burns fuel
  const before = await page.evaluate(() => ({ y: PALE_ORBIT.player.y, fuel: PALE_ORBIT.moon.player.fuel }));
  await page.keyboard.down("Space");
  await gameWait(1.0);
  const during = await page.evaluate(() => ({ y: PALE_ORBIT.player.y, fuel: PALE_ORBIT.moon.player.fuel }));
  await page.keyboard.up("Space");
  check("jetpack climbs and uses fuel", during.y > before.y + 2 && during.fuel < before.fuel - 15,
        `(y ${before.y.toFixed(1)} -> ${during.y.toFixed(1)}, fuel ${before.fuel.toFixed(0)} -> ${during.fuel.toFixed(0)})`);
  await gameWait(4.0);
  const landed = await page.evaluate(() => PALE_ORBIT.player.y);
  check("gravity brings the player back down", landed < 0.5, `(y ${landed.toFixed(2)})`);

  // 3. aim at a plain core and shoot it with the mouse
  const shot = await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon;
    let c = m.cores.find((x) => !x.warded && !x.relayLocked && !m.sealed.has(x.sector) && !m.vaults.has(x.sector));
    g.loadSector(c.sector);
    const v = g.coreViews.find((cv) => cv.core === c);
    // stand 14 units away with a clear line, aim at the gem
    for (let k = 0; k < 36; k++) {
      const a = k * Math.PI / 18, px = c.x + Math.cos(a) * 14, pz = c.z + Math.sin(a) * 14;
      if (Math.abs(px) > 60 || Math.abs(pz) > 60) continue;
      const eye = new THREE.Vector3(px, 2.7, -pz);
      const gem = v.gem.getWorldPosition(new THREE.Vector3());
      const hit = g.raycast(eye, gem.clone().sub(eye));
      if (hit.hit && hit.object === v.gem) {
        const dx = c.x - px, dy = gem.y - 2.7, dz = -gem.z - pz;
        Object.assign(g.player, { x: px, z: pz, y: 0, yaw: Math.atan2(dx, dz) * 180 / Math.PI,
                                  pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI });
        return { id: c.id };
      }
    }
    return null;
  });
  // the gem bobs, so re-aim each frame while firing
  await page.evaluate(() => {
    window.__aim = setInterval(() => {
      const g = PALE_ORBIT, v = g.coreViews.find((cv) => cv.core.alive);
      if (!v) return;
      const gem = v.gem.getWorldPosition(new THREE.Vector3()), p = g.player;
      const dx = gem.x - p.x, dy = gem.y - (p.y + 2.7), dz = -gem.z - p.z;
      p.yaw = Math.atan2(dx, dz) * 180 / Math.PI;
      p.pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
    }, 16);
    PALE_ORBIT.mouseDown = true;
  });
  await step(700);
  await page.evaluate(() => { PALE_ORBIT.mouseDown = false; clearInterval(window.__aim); });
  const destroyed = shot && await page.evaluate((id) => !PALE_ORBIT.moon.cores[id].alive, shot.id);
  check("shooting a core destroys it", !!destroyed);

  // 4. a turret bolt hurts, and running out of shield ends the game
  const hurt = await page.evaluate(() => {
    const g = PALE_ORBIT, p = g.player;
    const before = g.moon.player.shield;
    const target = new THREE.Vector3(p.x, p.y + 1.5, -p.z);
    g.spawnBolt(target.clone().add(new THREE.Vector3(6, 0, 0)), new THREE.Vector3(-1, 0, 0));
    return before;
  });
  await gameWait(0.6);
  const after = await page.evaluate(() => PALE_ORBIT.moon.player.shield);
  check("a turret bolt costs 14 shield", Math.abs(hurt - after - 14) < 1e-6, `(${hurt} -> ${after})`);

  // 5. save, change things, load
  const saved = await page.evaluate(() => {
    const g = PALE_ORBIT;
    g.saveGame();
    const s = { sector: g.sectorId, shield: g.moon.player.shield, alive: g.moon.liveCores };
    g.moon.player.shield = 1;
    g.loadGame();
    return { s, now: { sector: g.sectorId, shield: g.moon.player.shield, alive: g.moon.liveCores } };
  });
  check("save and load restore the game", JSON.stringify(saved.s) === JSON.stringify(saved.now),
        JSON.stringify(saved));

  await page.evaluate(() => { PALE_ORBIT.moon.player.shield = 5; });
  await page.evaluate(() => {
    const g = PALE_ORBIT, p = g.player;
    g.spawnBolt(new THREE.Vector3(p.x + 6, p.y + 1.5, -p.z), new THREE.Vector3(-1, 0, 0));
  });
  await step(800);
  const state = await page.evaluate(() => [PALE_ORBIT.moon.state, !!document.querySelector(".overlay.end")]);
  check("shield at zero ends the game with the end screen", state[0] === "lost" && state[1], JSON.stringify(state));

  // 6. map pauses the clock
  await page.evaluate(() => PALE_ORBIT.newGame(2026));
  await page.evaluate(() => PALE_ORBIT.begin());
  await step(200);
  await page.keyboard.press("Tab");
  const t0 = await page.evaluate(() => PALE_ORBIT.moon.elapsed);
  await step(800);
  const t1 = await page.evaluate(() => PALE_ORBIT.moon.elapsed);
  await page.keyboard.press("Tab");
  await step(400);
  const t2 = await page.evaluate(() => PALE_ORBIT.moon.elapsed);
  check("Tab map pauses the game", t1 === t0 && t2 > t1, `(${t0.toFixed(2)}, ${t1.toFixed(2)}, ${t2.toFixed(2)})`);

  // 7. puzzles, by shooting the real objects
  await page.evaluate(() => {
    window.shootAt = (mesh) => {
      const g = PALE_ORBIT, p = g.player;
      const t = mesh.getWorldPosition(new THREE.Vector3());
      const dx = t.x - p.x, dy = t.y - (p.y + 2.7), dz = -t.z - p.z;
      p.yaw = Math.atan2(dx, dz) * 180 / Math.PI;
      p.pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
      g.placeCamera(); g.scene.updateMatrixWorld(true);
      g.shotTimer = 0;
      g.fire();
    };
    window.standNear = (x, z, d = 7) => {
      const g = PALE_ORBIT;
      for (let k = 0; k < 24; k++) {
        const a = k * Math.PI / 12, px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        if (Math.abs(px) < 62 && Math.abs(pz) < 62 && !g.moon.overChasm(g.sectorId, px, pz)) {
          Object.assign(g.player, { x: px, z: pz, y: 0, vy: 0 });
          return;
        }
      }
    };
  });
  const sw = await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon;
    const pz = m.puzzles.find((q) => q.positions.every(([x, z]) => !m.silos.some((s) => s.contains(x, z))));
    g.loadSector(pz.sector); g.begin(true);
    const before = pz.state.slice();
    const v = g.switchViews.find((sv) => sv.pz === pz && sv.index === 0);
    standNear(...pz.positions[0], 6);
    shootAt(v.lamp);
    const flipped = [0, ...pz.links[0]];
    return pz.state.every((st, i) => st === (flipped.includes(i) ? !before[i] : before[i]));
  });
  check("shooting a switch flips it and its linked switches", sw);
  const slid = await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon, pz = m.slides[0];
    g.loadSector(pz.sector); g.begin(true);
    const gap = pz.tiles.indexOf(0), cell = pz.neighboursOf(gap)[0], number = pz.tiles[cell];
    const l = Math.hypot(pz.x, pz.z);
    Object.assign(g.player, { x: pz.x - pz.x / l * 9, z: pz.z - pz.z / l * 9, y: 0 });
    shootAt(g.slideViews[0].tiles[number]);
    return pz.tiles[gap] === number && pz.tiles[cell] === 0;
  });
  check("shooting a tile next to the gap slides it", slid);
  const relay = await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon, rp = m.relayPuzzles[0];
    g.loadSector(rp.sector); g.begin(true);
    const r = m.relays[rp.relays[0]];
    const hub = g.colliders.find((c) => c.userData.kind === "relay" && c.userData.ref === r.id);
    standNear(r.x, r.z, 6);
    const before = r.facing;
    shootAt(hub);
    const turned = r.facing === (before + 1) % 8;
    for (const rid of rp.relays) { const x = m.relays[rid]; if (x.solution !== null) x.facing = x.solution; }
    const em = g.colliders.find((c) => c.userData.kind === "emitter" && c.userData.ref === rp.id);
    standNear(rp.ex, rp.ez, 6);
    shootAt(em);
    return { turned, coreDown: !m.cores[rp.core].alive };
  });
  check("shooting a relay turns it 45 degrees", relay.turned);
  check("firing the emitter with the relays lined up destroys the shielded core", relay.coreDown);
  const tp = await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon;
    const t = m.teleporters.find((x) => x.puzzle !== null);
    m.puzzles[t.puzzle].solved = true; t.active = true;
    g.loadSector(t.sector); g.begin(true);
    Object.assign(g.player, { x: t.x, z: t.z, y: 0.5 });
    g.gateCooldown = 0;
    return t.dest;
  });
  await gameWait(0.3);
  const arrived = await page.evaluate(() => PALE_ORBIT.sectorId);
  check("a powered transporter takes you to the sealed sector", arrived === tp, `(${arrived} vs ${tp})`);
  // walk onto a powered transporter pad with the keyboard (it has a raised base)
  const walk = await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon;
    const t = m.teleporters.find((x) => x.puzzle !== null);
    t.active = true;
    g.loadSector(t.sector); g.begin(true);
    // approach between two of the six posts (they stand at 0, 60, 120... degrees)
    const a = 30 * Math.PI / 180;
    Object.assign(g.player, { x: t.x + Math.cos(a) * 7, z: t.z + Math.sin(a) * 7, y: 0, vy: 0,
                              yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) * 180 / Math.PI,
                              pitch: 0 });
    window.__padStart = { x: g.player.x, z: g.player.z };
    g.gateCooldown = 0;
    return t.dest;
  });
  await page.keyboard.down("KeyW");
  await gameWait(1.5);
  await page.keyboard.up("KeyW");
  const walked = await page.evaluate(() => PALE_ORBIT.sectorId);
  if (walked !== walk) console.log("pad walk ended at", await page.evaluate(() => JSON.stringify(PALE_ORBIT.player)));
  check("walking onto a powered transporter pad uses it", walked === walk, `(${walked} vs ${walk})`);

  const fall = await page.evaluate(() => {
    const g = PALE_ORBIT, m = g.moon, ch = m.chasms[0];
    g.loadSector(ch.sector); g.begin(true);
    m.player.shield = 100;
    const [ux, uz] = ch.axis;
    Object.assign(g.player, { x: ux * ch.d, z: uz * ch.d, y: 0, vy: 0 });
    return ch.sector;
  });
  await gameWait(3.5);
  const fell = await page.evaluate(() => ({ shield: PALE_ORBIT.moon.player.shield, y: PALE_ORBIT.player.y }));
  check("falling into a chasm costs 20 shield and puts you back on the edge",
        fell.shield === 80 && fell.y > -1, JSON.stringify(fell));

  const fps = await page.evaluate(() => new Promise((res) => {
    let n = 0; const t = performance.now();
    function f() { if (++n === 60) res(60000 / (performance.now() - t)); else requestAnimationFrame(f); }
    requestAnimationFrame(f);
  }));
  console.log(results.join("\n"));
  console.log(`frame rate (software renderer): ${fps.toFixed(0)} fps`);
  console.log(problems.length ? "page errors:\n" + problems.join("\n") : "no page errors");
  await browser.close();
  process.exit(results.some((r) => r.startsWith("FAIL")) || problems.length ? 1 : 0);
})();
