// Rules tests (a port of the Python version's tests/test_logic.py).
// Run with:  node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/logic.js");
const { Moon } = L;

function kill(moon, core) {
  if (core.warded) moon.tripBreaker(core.breaker);
  return moon.shootCore(core.id, core.relayLocked);
}
const range = (n) => [...Array(n).keys()];

test("twenty sectors, three neighbours each, symmetric", () => {
  const adj = L.icosahedronAdjacency();
  assert.equal(adj.length, 20);
  adj.forEach((n, i) => {
    assert.equal(n.length, 3);
    for (const j of n) assert.ok(adj[j].includes(i));
  });
});

test("generation is deterministic", () => {
  assert.deepEqual(L.worldSnapshot(new Moon({ seed: 1234 })),
                   L.worldSnapshot(new Moon({ seed: 1234 })));
});

test("consecutive cores sit in adjacent sectors", () => {
  const m = new Moon({ seed: 1234 });
  for (const lat of m.lattices) {
    assert.ok(lat.length >= 4);
    for (let i = 0; i + 1 < lat.length; i++) {
      assert.ok(m.sectors[m.cores[lat[i]].sector].neighbours.includes(m.cores[lat[i + 1]].sector));
    }
  }
});

test("interior core rebuilds, terminus never does, working inwards clears a lattice", () => {
  let m = new Moon({ seed: 1234 });
  const mid = m.cores[m.lattices[0][1]];
  assert.equal(kill(m, mid), "destroyed");
  m.update(Moon.REGEN_DELAY + 0.01);
  assert.ok(mid.alive);
  m = new Moon({ seed: 1234 });
  const end = m.cores[m.lattices[0][0]];
  kill(m, end);
  m.update(60);
  assert.ok(!end.alive);
  m = new Moon({ seed: 1234 });
  for (const cid of m.lattices[0]) { kill(m, m.cores[cid]); m.update(5); }
  assert.equal(m.latticeAlive(0), 0);
});

test("ward blocks until its breaker is tripped", () => {
  const m = new Moon({ seed: 1234 });
  const c = m.cores.find((x) => x.warded);
  assert.ok(m.isTerminus(c));
  assert.equal(m.shootCore(c.id), "warded");
  assert.equal(m.breakers[c.breaker].sector, c.sector);
  m.tripBreaker(c.breaker);
  assert.equal(m.shootCore(c.id, c.relayLocked), "destroyed");
});

test("win when every core is destroyed", () => {
  const m = new Moon({ seed: 1234 });
  for (const lat of m.lattices) for (const cid of lat) kill(m, m.cores[cid]);
  assert.equal(m.state, "won");
});

test("lance fires and shield loss ends the game", () => {
  let m = new Moon({ seed: 7 });
  for (let i = 0; i < Moon.FULL_CHARGE_TIME * 3 && m.state === "playing"; i++) m.update(1);
  assert.equal(m.state, "lost");
  m = new Moon({ seed: 7 });
  m.player.damage(500);
  m.update(0.1);
  assert.equal(m.state, "lost");
});

test("shield only comes back from power packs", () => {
  const m = new Moon({ seed: 1 });
  m.player.damage(50);
  for (let i = 0; i < 600; i++) { m.update(1); m.charge = 0; }
  assert.equal(m.player.shield, 50);
  const pack = m.packs.find((p) => p.kind === "shield");
  m.collectPack(pack.id);
  assert.equal(m.player.shield, 90);
  assert.equal(m.collectPack(pack.id), false);
});

test("clock counts down in real time as the sun moves, and jumps when a core falls", () => {
  const m = new Moon({ seed: 12 });
  kill(m, m.cores[m.lattices[0][0]]);
  let last = m.timeToFire;
  for (let i = 0; i < 300 && m.state === "playing"; i++) {
    m.update(2.0);
    const now = m.timeToFire;
    assert.ok(Math.abs(last - now - 2.0) < 0.6);
    last = now;
  }
  const m2 = new Moon({ seed: 12 });
  const before = m2.timeToFire;
  kill(m2, m2.cores[m2.lattices[1][0]]);
  assert.ok(m2.timeToFire > before);
});

test("the sun moves and outputs follow; bright cores charge faster", () => {
  const m = new Moon({ seed: 11 });
  const before = m.sectors.map((s) => s.sunlight);
  m.update(L.DAY_LENGTH / 4);
  assert.notDeepEqual(before, m.sectors.map((s) => s.sunlight));
  for (const c of m.cores) assert.equal(c.output, L.outputFor(m.sectors[c.sector].sunlight));
  const a = new Moon({ seed: 99 }), b = new Moon({ seed: 99 });
  const bright = a.cores.reduce((p, c) => (c.output > p.output ? c : p));
  const dark = a.cores.reduce((p, c) => (c.output < p.output ? c : p));
  a.cores[bright.id].alive = false;
  b.cores[dark.id].alive = false;
  assert.ok(a.chargeRate < b.chargeRate);
});

test("sealed sectors only reachable by transporter; puzzles solvable", () => {
  for (const seed of range(25)) {
    const m = new Moon({ seed });
    const walk = m.walkableFrom(m.startSector);
    const expected = range(20).filter((s) => !m.sealed.has(s) && !m.vaults.has(s));
    assert.deepEqual([...walk].sort((x, y) => x - y), expected);
    for (const sec of m.sealed) {
      assert.ok(m.coresIn(sec).length);
      for (const n of m.sectors[sec].neighbours) {
        assert.equal(m.gateOpen(n, sec), false);
        assert.ok(m.gateOpen(sec, n));
      }
      const wayIn = m.teleporters.filter((t) => t.dest === sec && t.puzzle !== null);
      assert.equal(wayIn.length, 1);
      assert.ok(walk.has(wayIn[0].sector));
    }
  }
  const m = new Moon({ seed: 3 });
  for (const pz of m.puzzles) {
    const n = pz.state.length;
    let solution = null;
    for (let mask = 0; mask < 1 << n && !solution; mask++) {
      const st = pz.state.slice();
      for (let i = 0; i < n; i++) if (mask >> i & 1) for (const j of [i, ...pz.links[i]]) st[j] = !st[j];
      if (st.every(Boolean)) solution = mask;
    }
    assert.notEqual(solution, null);
    for (let i = 0; i < n; i++) if (solution >> i & 1) m.pressSwitch(pz.id, i);
    assert.ok(pz.solved);
    assert.ok(m.teleporters[pz.teleporter].active);
  }
});

test("vaults open from their sliding-tile wall; rockfall total is two per vault", () => {
  for (const seed of range(20)) {
    const m = new Moon({ seed });
    assert.equal(m.rubble.size, 2 * m.vaults.size);
    for (const vault of m.vaults) {
      const states = m.sectors[vault].neighbours.map((n) => m.gateState(n, vault));
      const locked = states.filter((s) => s === "locked").length;
      assert.ok(locked === 1 || locked === 2);
      const pz = m.controlWallFor(vault);
      for (let i = pz.scramble.length - 1; i >= 0 && !pz.solved; i--) {
        assert.ok(m.slideTile(pz.id, pz.scramble[i]));
      }
      assert.ok(pz.solved);
      assert.ok(m.walkableFrom(m.startSector).has(vault));
    }
  }
});

test("every locked area holds a lattice end; one lattice needs two puzzles", () => {
  for (const seed of range(30)) {
    const m = new Moon({ seed });
    const ends = new Set(m.lattices.flatMap((lat) => [m.cores[lat[0]].sector,
                                                      m.cores[lat[lat.length - 1]].sector]));
    for (const s of [...m.sealed, ...m.vaults]) assert.ok(ends.has(s));
    assert.ok(m.doubleLocked);
    assert.deepEqual(m.lockedEnds(m.doubleLocked[0]).sort(), ["sealed", "vault"]);
  }
});

test("relay puzzles start unsolved and have a solution", () => {
  for (const seed of range(20)) {
    const m = new Moon({ seed });
    for (const pz of m.relayPuzzles) {
      const core = m.cores[pz.core];
      assert.notEqual(m.traceBeam(pz.id)[1], "core");
      assert.equal(m.shootCore(core.id), "refracted");
      for (const rid of pz.relays) {
        const r = m.relays[rid];
        if (r.solution !== null) while (r.facing !== r.solution) m.rotateRelay(r.id);
      }
      assert.equal(m.fireEmitter(pz.id)[1], "core");
      assert.ok(!core.alive);
    }
  }
});

test("hunter drone hunts, never spawns where it can't reach, and respawns", () => {
  for (const seed of range(25)) {
    const m = new Moon({ seed, hunter: true });
    kill(m, m.cores[m.lattices[0][0]]);
    assert.ok(!m.vaults.has(m.drone.sector) && !m.sealed.has(m.drone.sector));
    assert.ok(m.droneDistance() < 99);
  }
  const m = new Moon({ seed: 4, hunter: true });
  kill(m, m.cores[m.lattices[0][0]]);
  const start = m.droneDistance();
  for (let i = 0; i < L.DRONE.STEP_TIME * start + 5; i++) { m.update(1); m.charge = 0; }
  assert.equal(m.droneDistance(), 0);
  for (let i = 0; i < L.DRONE.MAX_HP - 1; i++) assert.equal(m.damageDrone(), false);
  assert.ok(m.damageDrone());
  m.update(L.DRONE.RESPAWN_TIME + 1);
  assert.ok(m.drone.alive);
});

test("silos hold breakers and switches", () => {
  let inside = 0;
  for (const seed of range(20)) {
    const m = new Moon({ seed });
    for (const silo of m.silos) {
      const n = m.breakersIn(silo.sector).filter((b) => silo.contains(b.x, b.z)).length
        + m.puzzlesIn(silo.sector).flatMap((p) => p.positions)
          .filter(([x, z]) => silo.contains(x, z)).length;
      assert.ok(n > 0);
      inside += n;
    }
  }
  assert.ok(inside > 10);
});

test("chasms avoid the centre, gates and objects", () => {
  for (const seed of range(15)) {
    const m = new Moon({ seed });
    for (const ch of m.chasms) {
      assert.ok(!ch.contains(0, 0, 2));
      for (let g = 0; g < 3; g++) if (g !== ch.gate) assert.ok(!ch.contains(...L.gatePosition(g), 4));
      for (const c of m.coresIn(ch.sector)) assert.ok(!ch.contains(c.x, c.z));
      for (const p of m.packsIn(ch.sector)) assert.ok(!ch.contains(p.x, p.z));
    }
  }
});

test("save and load round trip, and old versions are refused", () => {
  const m = new Moon({ seed: 21, hunter: true });
  kill(m, m.cores[m.lattices[0][0]]);
  m.update(42);
  m.pressSwitch(0, 0);
  m.slideTile(0, m.slides[0].neighboursOf(m.slides[0].tiles.indexOf(0))[0]);
  m.rotateRelay(0);
  m.collectPack(0);
  m.player.damage(30);
  const before = JSON.parse(JSON.stringify(m.saveState({ pos: [1, 2, 3] })));
  const loaded = Moon.fromSave(before);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.saveState({ pos: [1, 2, 3] }))), before);
  assert.throws(() => Moon.fromSave(Object.assign({}, before, { version: 1 })));
});

test("format time", () => {
  assert.equal(L.formatTime(754), "12:34");
  assert.equal(L.formatTime(Infinity), "--:--");
});
