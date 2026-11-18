/*
 * Pale Orbit: game rules and world generation (no graphics).
 *
 * A line-for-line port of logic.py from the Python version. Together with
 * rng.js (a Python-compatible random number generator) it builds exactly the
 * same moon from the same seed, so layouts can be shared between versions.
 *
 * See the Python docstring for the full design notes; in short:
 *  - 20 sectors, one per icosahedron face, three gates each.
 *  - Prism cores linked in lattices; a destroyed core rebuilds if both of
 *    its neighbours are alive, so work inwards from the ends.
 *  - The sun circles the moon; sunlit cores charge the Lance fastest.
 *  - Wards + breakers, sealed sectors + transporters + switch puzzles,
 *    vaults + sliding-tile walls, scattered rockfall, silos, mirror relays,
 *    chasms, sentries, power packs and an optional hunter drone.
 */
(function (root) {
  "use strict";
  const { PyRandom } = (typeof module !== "undefined" && module.exports)
    ? require("./rng.js") : root.PO;

  // ------------------------------------------------------------------------
  // Geometry of the moon
  // ------------------------------------------------------------------------
  const _T = (1 + Math.sqrt(5)) / 2;
  const ICO_VERTICES = [
    [-1, _T, 0], [1, _T, 0], [-1, -_T, 0], [1, -_T, 0],
    [0, -1, _T], [0, 1, _T], [0, -1, -_T], [0, 1, -_T],
    [_T, 0, -1], [_T, 0, 1], [-_T, 0, -1], [-_T, 0, 1],
  ];
  const ICO_FACES = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const SECTOR_NAMES = [
    "Ashfall Basin", "Cinder Flats", "Halo Ridge", "Quiet Mare", "Glass Plain",
    "Shiver Rift", "Lantern Crater", "Iron Steppe", "Hollow Reach", "Pale Terrace",
    "Ember Shelf", "Vesper Gorge", "Slate Expanse", "Frost Hollow", "Signal Peak",
    "Dust Sea", "Obsidian Fold", "Beacon Mesa", "Silent Arc", "Tether Point",
  ];
  const LATTICE_COLOURS = [
    [0.20, 0.90, 1.00], [1.00, 0.35, 0.80], [1.00, 0.80, 0.15], [0.40, 1.00, 0.35],
    [0.65, 0.45, 1.00], [1.00, 0.45, 0.25], [0.95, 0.95, 0.95], [0.30, 0.55, 1.00],
  ];

  const SUN_DIRECTION = [0.78, 0.42, 0.46];
  const DAY_LENGTH = 12 * 60.0;
  const MIN_OUTPUT = 0.3;
  const MAX_OUTPUT = 2.0;
  const SECTOR_HALF_SIZE = 70.0;
  const GATE_RADIUS = 56.0;
  const SPAWN_CLEAR_RADIUS = 8.0;
  const TAU = 2 * Math.PI;
  const DEG2RAD = Math.PI / 180.0;   // CPython math.radians
  const RAD2DEG = 180.0 / Math.PI;   // CPython math.degrees

  const hypot = (x, y) => Math.hypot(x, y);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const sumArr = (arr) => { let s = 0; for (const v of arr) s += v; return s; };
  const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const edgeEnds = (key) => key.split("-").map(Number);

  function icosahedronAdjacency() {
    return ICO_FACES.map((face, i) => {
      const s = new Set(face);
      const out = [];
      ICO_FACES.forEach((other, j) => {
        if (j !== i && other.filter((v) => s.has(v)).length === 2) out.push(j);
      });
      return out;
    });
  }

  function faceCentre(faceIndex) {
    const pts = ICO_FACES[faceIndex].map((v) => ICO_VERTICES[v]);
    return [0, 1, 2].map((k) => (0 + pts[0][k] + pts[1][k] + pts[2][k]) / 3);
  }

  function faceLatLon(faceIndex) {
    const [x, y, z] = faceCentre(faceIndex);
    const r = Math.sqrt(x * x + y * y + z * z);
    return [Math.asin(y / r) * RAD2DEG, Math.atan2(z, x) * RAD2DEG];
  }

  /**
   * Latitude/longitude (degrees) of a sector on the survey map after the
   * map has been turned: yaw spins the moon east-west, pitch tilts it
   * north-south. Turning the whole sphere (rather than sliding a flat
   * picture) lets the map scroll and wrap in every direction.
   */
  function mapLatLon(faceIndex, yawDeg = 0, pitchDeg = 0) {
    let [x, y, z] = norm(faceCentre(faceIndex));
    const a = yawDeg * DEG2RAD, b = pitchDeg * DEG2RAD;
    [x, z] = [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];
    [x, y] = [x * Math.cos(b) + y * Math.sin(b), -x * Math.sin(b) + y * Math.cos(b)];
    return [Math.asin(Math.max(-1, Math.min(1, y))) * RAD2DEG, Math.atan2(z, x) * RAD2DEG];
  }

  function norm(v) {
    const r = Math.sqrt(sumArr(v.map((c) => c * c)));
    return v.map((c) => c / r);
  }
  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  const _faceNormals = ICO_FACES.map((_, i) => norm(faceCentre(i)));
  function faceNormal(i) { return _faceNormals[i]; }

  function localFrame(faceIndex) {
    const up = faceNormal(faceIndex);
    const ref = Math.abs(up[1]) < 0.95 ? [0.0, 1.0, 0.0] : [1.0, 0.0, 0.0];
    const east = norm(cross(ref, up));
    const north = cross(up, east);
    return [east, up, north];
  }

  function toLocal(faceIndex, v) {
    const [east, up, north] = localFrame(faceIndex);
    return [dot(v, east), dot(v, up), dot(v, north)];
  }

  const SUN_NORM = norm(SUN_DIRECTION);
  function sunDirectionAt(t) {
    const [x, y, z] = SUN_NORM;
    const a = TAU * t / DAY_LENGTH;
    return [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
  }

  function sectorSunlight(faceIndex, sun) {
    return Math.max(0.0, dot(faceNormal(faceIndex), sun || SUN_NORM));
  }

  function outputFor(sunlight) { return MIN_OUTPUT + (MAX_OUTPUT - MIN_OUTPUT) * sunlight; }

  function gatePosition(g) {
    const a = (90 + 120 * g) * DEG2RAD;
    return [GATE_RADIUS * Math.cos(a), GATE_RADIUS * Math.sin(a)];
  }

  function facingVector(facing) {
    const a = (facing * 45) * DEG2RAD;
    return [Math.sin(a), Math.cos(a)];
  }

  // ------------------------------------------------------------------------
  // Small state classes (only the ones with behaviour)
  // ------------------------------------------------------------------------
  class Silo {
    constructor(sector, x, z, height = 10.0) {
      Object.assign(this, { sector, x, z, size: 11.0, height });
    }
    innerSpot(corner) {
      const d = this.size / 2 - 2.0;
      const [sx, sz] = [[1, 1], [-1, -1], [1, -1], [-1, 1]][corner % 4];
      return [this.x + sx * d, this.z + sz * d];
    }
    contains(x, z, margin = 0.0) {
      const h = this.size / 2 + margin;
      return Math.abs(x - this.x) < h && Math.abs(z - this.z) < h;
    }
  }
  Silo.HATCH = 4.5;

  class SwitchPuzzle {
    constructor(id, sector, positions, links, state, teleporter) {
      Object.assign(this, { id, sector, positions, links, state, teleporter, solved: false });
    }
    press(i) {
      for (const j of [i, ...this.links[i]]) this.state[j] = !this.state[j];
      if (this.state.every(Boolean)) this.solved = true;
    }
  }

  class SlidePuzzle {
    constructor(id, sector, vault, x, z, tiles) {
      Object.assign(this, { id, sector, vault, x, z, tiles, solved: false, scramble: [] });
    }
    neighboursOf(cell) {
      const r = Math.floor(cell / 3), c = cell % 3;
      const out = [];
      for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (rr >= 0 && rr < 3 && cc >= 0 && cc < 3) out.push(rr * 3 + cc);
      }
      return out;
    }
    canMove(cell) {
      return this.tiles[cell] !== 0 && this.neighboursOf(cell).includes(this.tiles.indexOf(0));
    }
    move(cell) {
      if (this.solved || !this.canMove(cell)) return false;
      const gap = this.tiles.indexOf(0);
      this.tiles[gap] = this.tiles[cell];
      this.tiles[cell] = 0;
      this.solved = this.tiles.every((v, i) => v === SlidePuzzle.SOLVED[i]);
      return true;
    }
  }
  SlidePuzzle.SOLVED = [1, 2, 3, 4, 5, 6, 7, 8, 0];

  class Chasm {
    constructor(sector, gate, d, width) { Object.assign(this, { sector, gate, d, width }); }
    get axis() {
      const [gx, gz] = gatePosition(this.gate);
      const r = hypot(gx, gz);
      return [gx / r, gz / r];
    }
    contains(x, z, margin = 0.0) {
      const [ux, uz] = this.axis;
      return Math.abs(x * ux + z * uz - this.d) < this.width / 2 + margin;
    }
  }

  const RELAY_RADIUS = 1.3;
  const BEAM_HEIGHT = 3.0;

  const DRONE = { MAX_HP: 4, STEP_TIME: 20.0, RESPAWN_TIME: 75.0 };

  const PACK_AMOUNTS = { shield: [40.0, 0.0], fuel: [0.0, 100.0], combo: [30.0, 60.0] };

  class PlayerState {
    constructor() { this.shield = 100.0; this.fuel = 100.0; this.sinceHit = 99.0; }
    update(dt, thrusting, grounded) {
      // the shield never recharges by itself: only power packs restore it
      this.sinceHit += dt;
      const thrust = thrusting && this.fuel > 0;
      if (thrust) this.fuel = Math.max(0.0, this.fuel - PlayerState.FUEL_BURN * dt);
      else if (grounded) this.fuel = Math.min(PlayerState.MAX_FUEL,
                                              this.fuel + PlayerState.FUEL_RECHARGE * dt);
      return thrust;
    }
    heal(shield, fuel) {
      this.shield = Math.min(PlayerState.MAX_SHIELD, this.shield + shield);
      this.fuel = Math.min(PlayerState.MAX_FUEL, this.fuel + fuel);
    }
    damage(amount) { this.shield = Math.max(0.0, this.shield - amount); this.sinceHit = 0.0; }
  }
  Object.assign(PlayerState, { MAX_SHIELD: 100.0, MAX_FUEL: 100.0, FUEL_BURN: 22.0,
                               FUEL_RECHARGE: 2.5 });

  // set helpers mirroring Python set algebra
  const setOf = (it) => new Set(it);
  const setEq = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));
  const sortedNums = (it) => [...it].sort((x, y) => x - y);

  // ------------------------------------------------------------------------
  // The moon
  // ------------------------------------------------------------------------
  class Moon {
    constructor(opts = {}) {
      const o = Object.assign({
        seed: null, latticeCount: 6, minLen: 4, maxLen: 7, wardedFraction: 0.5,
        sealedCount: 3, chasmCount: 7, hunter: false, vaultCount: 2, relayCount: 3,
        siloChance: 0.5,
      }, opts);
      this.seed = o.seed != null ? o.seed : Moon.randomSeed();
      this.siloChance = o.siloChance;
      this.rng = new PyRandom(this.seed);
      this.state = "playing";
      this.charge = 0.0;
      this.elapsed = 0.0;
      this.player = new PlayerState();
      this.events = [];

      const adj = icosahedronAdjacency();
      this.sectors = [];
      for (let i = 0; i < 20; i++) {
        const [lat, lon] = faceLatLon(i);
        this.sectors.push({
          id: i, name: SECTOR_NAMES[i], neighbours: adj[i], lat, lon,
          hue: this.rng.uniform(0, 360), sunlight: sectorSunlight(i),
          buildings: [], visited: false,
        });
      }
      this.cores = []; this.lattices = []; this.breakers = []; this.sentries = [];
      this.packs = []; this.teleporters = []; this.puzzles = [];
      this.sealed = new Set(); this.vaults = new Set();
      this.rubble = new Set();          // edge keys "a-b"
      this.locks = new Map();           // edge key -> slide puzzle id
      this.slides = []; this.relays = []; this.silos = []; this.relayPuzzles = [];
      this.chasms = [];
      this.drone = { enabled: !!o.hunter, active: false, sector: 0, hp: 4, alive: true,
                     travelTimer: 0.0, respawnTimer: 0.0 };
      this.playerSector = 0;
      this._placed = {};
      for (let i = 0; i < 20; i++) {
        this._placed[i] = [];
        for (let g = 0; g < 3; g++) {
          const [gx, gz] = gatePosition(g);
          this._placed[i].push([gx, gz, 7.0]);
        }
        this._placed[i].push([0.0, 0.0, SPAWN_CLEAR_RADIUS]);
      }

      this._buildLattices(o.latticeCount, o.minLen, o.maxLen);
      this.startSector = this._chooseStart();
      this.doubleLocked = (o.sealedCount && o.vaultCount) ? this._chooseDoubleLocked() : null;
      this._buildSealed(o.sealedCount);
      this._buildVaults(o.vaultCount);
      this._buildWards(o.wardedFraction);
      this._buildRelays(o.relayCount);
      this._buildChasms(o.chasmCount);
      this._buildSentries();
      this._buildBuildings();
      this._buildPacks();
      this.playerSector = this.startSector;
      let total = 0;
      for (let k = 0; k < 48; k++) {
        let s = 0;
        for (const c of this.cores) {
          s += outputFor(sectorSunlight(c.sector, sunDirectionAt(DAY_LENGTH * k / 48)));
        }
        total += s;
      }
      this.refOutput = total / 48;
      this._updateSunlight();
    }

    static randomSeed() { return Math.floor(Math.random() * (1 << 30)); }

    // ---- generation ------------------------------------------------------
    _freeSpot(sector, radius, margin = 10.0, tries = 200) {
      const lim = SECTOR_HALF_SIZE - margin;
      let best = null;
      for (let t = 0; t < tries; t++) {
        const x = this.rng.uniform(-lim, lim), z = this.rng.uniform(-lim, lim);
        if (this._placed[sector].every(([px, pz, pr]) => hypot(x - px, z - pz) > radius + pr)
            && !this.chasmsIn(sector).some((c) => c.contains(x, z, radius + 1.5))) {
          best = [x, z];
          break;
        }
      }
      if (best === null) best = [this.rng.uniform(-lim, lim), this.rng.uniform(-lim, lim)];
      this._placed[sector].push([best[0], best[1], radius]);
      return best;
    }

    _buildLattices(count, minLen, maxLen) {
      const coresInSector = new Array(20).fill(0);
      for (let latId = 0; latId < count; latId++) {
        let path = [];
        for (let attempt = 0; attempt < 100; attempt++) {
          const length = this.rng.randint(minLen, maxLen);
          // min(range(20), key=(cores_in_sector[s], rng.random()))
          let start = -1, bestKey = null;
          for (let s = 0; s < 20; s++) {
            const key = [coresInSector[s], this.rng.random()];
            if (bestKey === null || key[0] < bestKey[0]
                || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
              bestKey = key; start = s;
            }
          }
          path = [start];
          while (path.length < length) {
            const options = this.sectors[path[path.length - 1]].neighbours
              .filter((n) => !path.includes(n) && coresInSector[n] < 3);
            if (!options.length) break;
            path.push(this.rng.choice(options));
          }
          if (path.length >= minLen) break;
        }
        const ids = [];
        path.forEach((sec, idx) => {
          const [x, z] = this._freeSpot(sec, 4.0);
          const end = idx === 0 || idx === path.length - 1;
          const h = end ? this.rng.uniform(14, 22) : this.rng.uniform(6, 15);
          const light = this.sectors[sec].sunlight;
          const core = {
            id: this.cores.length, lattice: latId, index: idx, sector: sec, x, z, height: h,
            alive: true, regenTimer: 0.0, warded: false, breaker: null, discovered: false,
            output: outputFor(light), relayLocked: false,
          };
          this.cores.push(core);
          ids.push(core.id);
          coresInSector[sec] += 1;
        });
        this.lattices.push(ids);
      }
    }

    _endSectorSet() {
      const s = new Set();
      for (const lat of this.lattices) {
        s.add(this.cores[lat[0]].sector);
        s.add(this.cores[lat[lat.length - 1]].sector);
      }
      return s;
    }

    _chooseStart() {
      const ends = this._endSectorSet();
      let best = 0, bestKey = null;
      for (let i = 0; i < 20; i++) {
        const key = [ends.has(i) ? 0 : 1, Math.abs(this.sectors[i].sunlight - 0.5)];
        if (bestKey === null || key[0] < bestKey[0]
            || (key[0] === bestKey[0] && key[1] < bestKey[1])) { bestKey = key; best = i; }
      }
      return best;
    }

    walkableFrom(start) {
      const seen = new Set([start]), todo = [start];
      while (todo.length) {
        const cur = todo.pop();
        for (const n of this.sectors[cur].neighbours) {
          if (!seen.has(n) && this.gateOpen(cur, n)) { seen.add(n); todo.push(n); }
        }
      }
      return seen;
    }

    _sectorDistance(a, b) {
      let d = 0, frontier = new Set([a]);
      const seen = new Set([a]);
      while (!frontier.has(b)) {
        const next = new Set();
        for (const f of frontier) for (const n of this.sectors[f].neighbours) {
          if (!seen.has(n)) next.add(n);
        }
        frontier = next;
        for (const n of frontier) seen.add(n);
        d += 1;
      }
      return d;
    }

    _endSectors() {
      const out = [];
      for (const lat of this.lattices) {
        for (const cid of [lat[0], lat[lat.length - 1]]) {
          const s = this.cores[cid].sector;
          if (!out.includes(s)) out.push(s);
        }
      }
      return out;
    }

    _connectedWithout(blocked) {
      const start = this.startSector;
      const seen = new Set([start]), todo = [start];
      while (todo.length) {
        const cur = todo.pop();
        for (const n of this.sectors[cur].neighbours) {
          if (!seen.has(n) && !blocked.has(n)) { seen.add(n); todo.push(n); }
        }
      }
      return seen.size === 20 - blocked.size;
    }

    _chooseDoubleLocked() {
      const start = this.startSector;
      const nearStart = new Set([...this.sectors[start].neighbours, start]);
      const order = this.rng.shuffle([...Array(this.lattices.length).keys()]);
      for (const latId of order) {
        const lat = this.lattices[latId];
        const a = this.cores[lat[0]].sector, b = this.cores[lat[lat.length - 1]].sector;
        for (const [sealed, vault] of [[a, b], [b, a]]) {
          if (sealed === vault || nearStart.has(sealed) || nearStart.has(vault)) continue;
          if (this.sectors[sealed].neighbours.includes(vault)) continue;
          if (this._connectedWithout(new Set([sealed, vault]))) return [latId, sealed, vault];
        }
      }
      return null;
    }

    _buildSealed(count) {
      if (count <= 0) return;
      const reservedVault = this.doubleLocked ? this.doubleLocked[2] : null;
      const avoid = reservedVault !== null
        ? new Set([reservedVault, ...this.sectors[reservedVault].neighbours]) : new Set();
      let candidates = this._endSectors().filter((s) => s !== this.startSector && !avoid.has(s)
        && !this.sectors[this.startSector].neighbours.includes(s));
      this.rng.shuffle(candidates);
      if (this.doubleLocked) {
        const forced = this.doubleLocked[1];
        candidates = [forced, ...candidates.filter((c) => c !== forced)];
      }
      for (const sec of candidates) {
        if (this.sealed.size >= count) break;
        if (this.sectors[sec].neighbours.some((n) => this.sealed.has(n))) continue;
        this.sealed.add(sec);
        const blocked = new Set(this.sealed);
        if (reservedVault !== null) blocked.add(reservedVault);
        if (!this._connectedWithout(blocked)) this.sealed.delete(sec);
      }
      const walk = this.walkableFrom(this.startSector);
      const openSectors = sortedNums([...walk].filter((s) => !avoid.has(s)));
      const usedSources = new Set();
      for (const sec of sortedNums(this.sealed)) {
        const far = openSectors.filter((s) => !usedSources.has(s)
                                        && this._sectorDistance(s, sec) >= 2);
        const source = this.rng.choice(far.length ? far
                                        : openSectors.filter((s) => !usedSources.has(s)));
        usedSources.add(source);
        const [tx, tz] = this._freeSpot(source, 6.0);
        const tp = { id: this.teleporters.length, sector: source, x: tx, z: tz, dest: sec,
                     puzzle: null, active: false };
        this.teleporters.push(tp);
        const [rx, rz] = this._freeSpot(sec, 6.0);
        this.teleporters.push({ id: this.teleporters.length, sector: sec, x: rx, z: rz,
                                dest: source, puzzle: null, active: true });
        tp.puzzle = this._makePuzzle(source, tp.id);
      }
    }

    _buildVaults(count) {
      const ends = new Set(this._endSectors());
      const nearSealed = new Set();
      for (const s of this.sealed) for (const n of this.sectors[s].neighbours) nearSealed.add(n);
      const ok = [];
      for (let s = 0; s < 20; s++) {
        if (s !== this.startSector && !this.sealed.has(s) && !nearSealed.has(s)
            && !this.sectors[this.startSector].neighbours.includes(s)
            && this.coresIn(s).length && !this.teleportersIn(s).length) ok.push(s);
      }
      this.rng.shuffle(ok);
      let candidates = ok.filter((s) => ends.has(s));
      if (this.doubleLocked && candidates.includes(this.doubleLocked[2])) {
        const forced = this.doubleLocked[2];
        candidates = [forced, ...candidates.filter((c) => c !== forced)];
      }
      for (const vault of candidates) {
        if (this.vaults.size >= count) break;
        if (this.sectors[vault].neighbours.some((n) => this.vaults.has(n))) continue;
        const entries = this.sectors[vault].neighbours.filter((n) => !this.sealed.has(n));
        const entry = this.rng.choice(entries);
        const others = this.sectors[vault].neighbours.filter((n) => n !== entry);
        this.rng.shuffle(others);
        const rock = edgeKey(vault, others[0]), bulkhead = edgeKey(vault, others[1]);
        const entrance = edgeKey(vault, entry);
        this.vaults.add(vault);
        this.rubble.add(rock);
        this.locks.set(entrance, -1);
        this.locks.set(bulkhead, -1);
        const expected = new Set([...Array(20).keys()].filter(
          (s) => !this.sealed.has(s) && !this.vaults.has(s)));
        if (!setEq(this.walkableFrom(this.startSector), expected)) {
          this.vaults.delete(vault);
          this.rubble.delete(rock);
          this.locks.delete(entrance);
          this.locks.delete(bulkhead);
          continue;
        }
        const pid = this._makeSlide(entry, vault);
        this.locks.set(entrance, pid);
        this.locks.set(bulkhead, pid);
      }
      const missing = this._scatterRubble(2 * this.vaults.size - this.rubble.size);
      const bulkheads = [...this.locks.keys()].filter((e) => !this._isEntrance(e));
      for (const edge of bulkheads.slice(0, Math.max(0, missing))) {
        this.locks.delete(edge);
        this.rubble.add(edge);
      }
    }

    _isEntrance(edge) {
      const pz = this.slides[this.locks.get(edge)];
      return edge === edgeKey(pz.sector, pz.vault);
    }

    _scatterRubble(count) {
      const avoid = new Set([...this.sealed, ...this.vaults]);
      let edges = [];
      for (let a = 0; a < 20; a++) {
        for (const b of this.sectors[a].neighbours) {
          if (a < b && !avoid.has(a) && !avoid.has(b)) edges.push(edgeKey(a, b));
        }
      }
      edges = edges.filter((e) => !this.rubble.has(e) && !this.locks.has(e));
      this.rng.shuffle(edges);
      const expected = new Set([...Array(20).keys()].filter((s) => !avoid.has(s)));
      let placed = 0;
      for (const strict of [true, false]) {
        for (const e of edges) {
          if (placed >= count) return 0;
          if (this.rubble.has(e)) continue;
          if (strict && edgeEnds(e).some((x) => this.sectors[x].neighbours
              .filter((n) => this.gateOpen(x, n)).length <= 2)) continue;
          this.rubble.add(e);
          if (!setEq(this.walkableFrom(this.startSector), expected)) {
            this.rubble.delete(e);
            continue;
          }
          placed += 1;
        }
      }
      return Math.max(0, count - placed);
    }

    _makeSlide(sector, vault) {
      const g = this.sectors[sector].neighbours.indexOf(vault);
      const [gx, gz] = gatePosition(g);
      const ux = gx / GATE_RADIUS, uz = gz / GATE_RADIUS;
      const side = this.rng.choice([-1, 1]);
      const x = ux * 40 + uz * 9 * side, z = uz * 40 - ux * 9 * side;
      this._placed[sector].push([x, z, 5.0]);
      const pz = new SlidePuzzle(this.slides.length, sector, vault, x, z,
                                 SlidePuzzle.SOLVED.slice());
      let last = null;
      const isSolved = () => pz.tiles.every((v, i) => v === SlidePuzzle.SOLVED[i]);
      while (isSolved() || pz.scramble.length < 40) {
        const gap = pz.tiles.indexOf(0);
        const options = pz.neighboursOf(gap).filter((c) => c !== last);
        const cell = this.rng.choice(options);
        pz.move(cell);
        pz.solved = false;
        pz.scramble.push(gap);
        last = gap;
      }
      this.slides.push(pz);
      return pz.id;
    }

    _newSilo(sector) {
      const [x, z] = this._freeSpot(sector, 8.5, 14.0);
      const silo = new Silo(sector, x, z, this.rng.uniform(9, 12));
      this.silos.push(silo);
      return silo;
    }

    silosIn(sector) { return this.silos.filter((s) => s.sector === sector); }

    _makePuzzle(sector, teleporter) {
      const n = this.rng.randint(3, 5);
      const positions = [];
      for (let i = 0; i < n; i++) positions.push(this._freeSpot(sector, 3.0));
      if (this.rng.random() < this.siloChance) {
        const silo = this._newSilo(sector);
        const picks = this.rng.sample([...Array(n).keys()], this.rng.choice([1, 2]));
        picks.forEach((i, k) => { positions[i] = silo.innerSpot(k); });
      }
      const links = [];
      for (let i = 0; i < n; i++) {
        const others = [...Array(n).keys()].filter((j) => j !== i);
        links.push(this.rng.sample(others, this.rng.randint(1, Math.min(2, n - 1)))
          .sort((a, b) => a - b));
      }
      const state = new Array(n).fill(true);
      const puzzle = new SwitchPuzzle(this.puzzles.length, sector, positions, links, state,
                                      teleporter);
      while (puzzle.state.every(Boolean)) {
        for (let i = 0; i < n; i++) if (this.rng.random() < 0.5) puzzle.press(i);
      }
      puzzle.solved = false;
      this.puzzles.push(puzzle);
      return puzzle.id;
    }

    _buildWards(fraction) {
      for (const lat of this.lattices) {
        if (this.rng.random() < fraction) {
          const endCore = this.cores[this.rng.choice([lat[0], lat[lat.length - 1]])];
          let x, z;
          if (this.rng.random() < this.siloChance) {
            const silo = this._newSilo(endCore.sector);
            [x, z] = silo.innerSpot(this.rng.randrange(4));
          } else {
            [x, z] = this._freeSpot(endCore.sector, 3.0);
          }
          const b = { id: this.breakers.length, sector: endCore.sector, x, z,
                      core: endCore.id, tripped: false };
          this.breakers.push(b);
          endCore.warded = true;
          endCore.breaker = b.id;
        }
      }
    }

    _corridorClear(sector, a, b, ignoreEnd = false) {
      const length = dist(a, b);
      const steps = Math.max(1, Math.floor(length / 2));
      const lim = SECTOR_HALF_SIZE - 8;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        if (Math.abs(x) > lim || Math.abs(z) > lim) return false;
        if (ignoreEnd && dist([x, z], b) < 5) continue;
        if (this._placed[sector].some(([px, pz, pr]) => hypot(x - px, z - pz) < pr + 1.8)) {
          return false;
        }
      }
      return true;
    }

    _buildRelays(count) {
      const used = new Set([...this.vaults, ...this.sealed]);
      const candidates = this.cores.filter((c) => !c.warded && !used.has(c.sector));
      this.rng.shuffle(candidates);
      for (const core of candidates) {
        if (this.relayPuzzles.length >= count) break;
        if (this.relayPuzzles.some((p) => p.sector === core.sector)) continue;
        const route = this._planRelayRoute(core);
        if (route === null) continue;
        const [[ex, ez, efacing], stops] = route;
        const pid = this.relayPuzzles.length;
        const ids = [];
        for (const [x, z, sol] of stops) {
          const wrong = [0, 1, 2, 3, 4, 5, 6, 7].filter((f) => f !== sol);
          const r = { id: this.relays.length, puzzle: pid, x, z,
                      facing: this.rng.choice(wrong), solution: sol };
          this.relays.push(r);
          ids.push(r.id);
        }
        const [dx, dz] = this._freeSpot(core.sector, 2.5);
        const decoy = { id: this.relays.length, puzzle: pid, x: dx, z: dz,
                        facing: this.rng.randrange(8), solution: null };
        this.relays.push(decoy);
        ids.push(decoy.id);
        this.relayPuzzles.push({ id: pid, sector: core.sector, core: core.id, ex, ez, efacing,
                                 relays: ids });
        core.relayLocked = true;
        core.height = 1.0;
        while (this.traceBeam(pid)[1] === "core") {
          for (const rid of ids) this.relays[rid].facing = this.rng.randrange(8);
        }
      }
    }

    _planRelayRoute(core) {
      const sec = core.sector;
      for (let attempt = 0; attempt < 60; attempt++) {
        const nRelays = this.rng.choice([2, 2, 3]);
        let point = [core.x, core.z];
        let facing = this.rng.choice([0, 2, 4, 6]);
        const stops = [];
        let ok = true, emitter = null;
        for (let k = 0; k <= nRelays; k++) {
          const length = this.rng.uniform(12, 20);
          const [vx, vz] = facingVector(facing);
          const prev = [point[0] - vx * length, point[1] - vz * length];
          if (!this._corridorClear(sec, prev, point, k === 0)) { ok = false; break; }
          if (k < nRelays) {
            stops.push([prev[0], prev[1], facing]);
            facing = (facing + this.rng.choice([2, 6])) % 8;
          } else {
            emitter = [prev[0], prev[1], facing];
          }
          point = prev;
        }
        if (!ok) continue;
        const pts = [...stops.map(([x, z]) => [x, z]), [emitter[0], emitter[1]]];
        let tooClose = false;
        for (let i = 0; i < pts.length && !tooClose; i++) {
          for (let j = i + 1; j < pts.length; j++) if (dist(pts[i], pts[j]) < 6) tooClose = true;
        }
        if (tooClose) continue;
        for (const [x, z] of pts) this._placed[sec].push([x, z, 2.5]);
        const path = [[core.x, core.z], ...pts];
        for (let p = 0; p + 1 < path.length; p++) {
          const a = path[p], b = path[p + 1];
          const steps = Math.max(1, Math.floor(dist(a, b) / 3));
          for (let i = 1; i < steps; i++) {
            const t = i / steps;
            this._placed[sec].push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 1.5]);
          }
        }
        return [emitter, stops.slice().reverse()];
      }
      return null;
    }

    _buildSentries() {
      for (let sec = 0; sec < 20; sec++) {
        const n = this.rng.choice([0, 1, 1, 2]);
        for (let i = 0; i < n; i++) {
          const [x, z] = this._freeSpot(sec, 4.0, 14.0);
          this.sentries.push({ id: this.sentries.length, sector: sec, x, z, alive: true });
        }
      }
    }

    _addBuilding(sec, x, z, style) {
      const r = (a, b) => this.rng.uniform(a, b);
      let b;
      if (style === "bunker") {
        b = { x, z, w: r(6, 11), d: r(4, 7), h: r(3, 4.5), rot: r(0, 90), style };
      } else if (style === "tower") {
        const s = r(3.5, 5.5);
        b = { x, z, w: s, d: s, h: r(9, 16), rot: r(0, 90), style };
      } else if (style === "dome") {
        const s = r(7, 12);
        b = { x, z, w: s, d: s, h: s * 0.5, rot: 0, style };
      } else if (style === "hangar") {
        b = { x, z, w: r(12, 18), d: r(8, 11), h: r(5, 7), rot: r(0, 90), style };
      } else {
        b = { x, z, w: r(2, 6), d: r(2, 6), h: r(1.2, 3.5), rot: r(0, 90), style };
      }
      sec.buildings.push(b);
    }

    _buildBuildings() {
      const styles = ["bunker", "bunker", "tower", "dome", "hangar"];
      for (const sec of this.sectors) {
        for (const sentry of this.sentriesIn(sec.id)) {
          for (let k = 0; k < 2; k++) {
            for (let t = 0; t < 40; t++) {
              const a = this.rng.uniform(0, TAU);
              const d = this.rng.uniform(12, 22);
              const x = sentry.x + Math.cos(a) * d, z = sentry.z + Math.sin(a) * d;
              const lim = SECTOR_HALF_SIZE - 10;
              if (Math.abs(x) < lim && Math.abs(z) < lim
                  && this._placed[sec.id].every(([px, pz, pr]) => hypot(x - px, z - pz) > 6 + pr)
                  && !this.chasmsIn(sec.id).some((ch) => ch.contains(x, z, 8))) {
                this._placed[sec.id].push([x, z, 6.0]);
                this._addBuilding(sec, x, z, this.rng.choice(["bunker", "hangar"]));
                break;
              }
            }
          }
        }
        const nb = this.rng.randint(6, 10);
        for (let i = 0; i < nb; i++) {
          const [x, z] = this._freeSpot(sec.id, 7.0);
          this._addBuilding(sec, x, z, this.rng.choice(styles));
        }
        const nr = this.rng.randint(8, 14);
        for (let i = 0; i < nr; i++) {
          const [x, z] = this._freeSpot(sec.id, 3.0, 6.0);
          this._addBuilding(sec, x, z, "rock");
        }
      }
    }

    _buildChasms(count) {
      const candidates = [...Array(20).keys()].filter((s) => s !== this.startSector);
      this.rng.shuffle(candidates);
      const lim = SECTOR_HALF_SIZE;
      for (const sec of candidates) {
        if (this.chasms.length >= count) break;
        const gates = this.rng.shuffle([0, 1, 2]);
        let placed = false;
        for (const g of gates) {
          for (let t = 0; t < 40; t++) {
            const w = this.rng.uniform(8, 15);
            const lo = SPAWN_CLEAR_RADIUS + 4 + w / 2, hi = GATE_RADIUS - 10 - w / 2;
            if (lo >= hi) continue;
            const ch = new Chasm(sec, g, this.rng.uniform(lo, hi), w);
            if (this._placed[sec].every(([px, pz, pr]) =>
                !(Math.abs(px) < lim && Math.abs(pz) < lim) || !ch.contains(px, pz, pr + 1.0))) {
              this.chasms.push(ch);
              placed = true;
              break;
            }
          }
          if (placed) break;
        }
      }
    }

    _buildPacks() {
      const kinds = ["shield", "shield", "fuel", "combo"];
      for (let sec = 0; sec < 20; sec++) {
        const n = this.rng.randint(2, 4);
        for (let i = 0; i < n; i++) {
          const [x, z] = this._freeSpot(sec, 2.0);
          this.packs.push({ id: this.packs.length, sector: sec, x, z,
                            kind: this.rng.choice(kinds), taken: false });
        }
      }
    }

    // ---- queries ---------------------------------------------------------
    get totalCores() { return this.cores.length; }
    get liveCores() { return this.cores.filter((c) => c.alive).length; }
    get sunDirection() { return sunDirectionAt(this.elapsed); }

    sunlightTrend(sector, ahead = 30.0) {
      return sectorSunlight(sector, sunDirectionAt(this.elapsed + ahead))
        - this.sectors[sector].sunlight;
    }

    _updateSunlight() {
      const sun = this.sunDirection;
      for (const sec of this.sectors) sec.sunlight = sectorSunlight(sec.id, sun);
      for (const c of this.cores) c.output = outputFor(this.sectors[c.sector].sunlight);
    }

    get power() {
      let live = 0;
      for (const c of this.cores) if (c.alive) live += c.output;
      return this.refOutput ? live / this.refOutput : 0.0;
    }

    get chargeRate() { return this.power / Moon.FULL_CHARGE_TIME; }

    _powerAt(t, liveBySector) {
      const sun = sunDirectionAt(t);
      let out = 0;
      liveBySector.forEach((n, s) => { if (n) out += n * outputFor(sectorSunlight(s, sun)); });
      return this.refOutput ? out / this.refOutput : 0.0;
    }

    _predictFireTime() {
      const live = new Array(20).fill(0);
      for (const c of this.cores) if (c.alive) live[c.sector] += 1;
      if (!live.some(Boolean)) return Infinity;
      let t = this.elapsed, charge = this.charge;
      const step = Moon.PREDICT_STEP;
      while (charge < 1.0) {
        const gain = this._powerAt(t + step / 2, live) / Moon.FULL_CHARGE_TIME * step;
        if (gain <= 0) return Infinity;
        if (charge + gain >= 1.0) return t + step * (1.0 - charge) / gain;
        charge += gain;
        t += step;
        if (t - this.elapsed > Moon.PREDICT_HORIZON) return Infinity;
      }
      return t;
    }

    /** Seconds until the Lance fires if no more cores change (follows the sun). */
    get timeToFire() {
      const key = this.cores.map((c) => (c.alive ? 1 : 0)).join("");
      let cache = this._fireCache;
      if (!cache || cache[0] !== key || this.elapsed - cache[1] > 10.0
          || this.elapsed < cache[1]) {
        cache = [key, this.elapsed, this._predictFireTime()];
        this._fireCache = cache;
      }
      return Math.max(0.0, cache[2] - this.elapsed);
    }

    neighbours(core) {
      const lat = this.lattices[core.lattice];
      return [core.index - 1, core.index + 1].filter((i) => i >= 0 && i < lat.length)
        .map((i) => this.cores[lat[i]]);
    }
    isTerminus(core) {
      return core.index === 0 || core.index === this.lattices[core.lattice].length - 1;
    }
    willRegenerate(core) {
      const n = this.neighbours(core);
      return n.length === 2 && n.every((c) => c.alive);
    }
    latticeAlive(lattice) {
      return this.lattices[lattice].filter((i) => this.cores[i].alive).length;
    }
    coresIn(s) { return this.cores.filter((c) => c.sector === s); }
    breakersIn(s) { return this.breakers.filter((b) => b.sector === s); }
    sentriesIn(s) { return this.sentries.filter((x) => x.sector === s); }
    packsIn(s) { return this.packs.filter((p) => p.sector === s); }
    teleportersIn(s) { return this.teleporters.filter((t) => t.sector === s); }
    puzzlesIn(s) { return this.puzzles.filter((p) => p.sector === s); }
    chasmsIn(s) { return this.chasms.filter((c) => c.sector === s); }
    overChasm(sector, x, z) { return this.chasmsIn(sector).some((c) => c.contains(x, z)); }

    gateState(from, to) {
      const edge = edgeKey(from, to);
      if (this.sealed.has(to)) return "sealed";
      if (this.rubble.has(edge)) return "rubble";
      if (this.locks.has(edge)) {
        const pid = this.locks.get(edge);
        if (pid < 0 || !this.slides[pid].solved) return "locked";
      }
      return "open";
    }

    lockedArea(sector) {
      if (this.sealed.has(sector)) {
        const wayIn = this.teleporters.filter((t) => t.dest === sector && t.puzzle !== null);
        if (!wayIn.some((t) => t.active)) return "sealed";
      }
      if (this.vaults.has(sector)) {
        const edge = [...this.locks.keys()].find((e) => edgeEnds(e).includes(sector));
        if (edge !== undefined) {
          const outside = edgeEnds(edge).find((x) => x !== sector);
          if (this.gateState(outside, sector) !== "open") return "vault";
        }
      }
      return null;
    }

    lockedEnds(lattice) {
      const lat = this.lattices[lattice];
      const ids = lat[0] === lat[lat.length - 1] ? [lat[0]] : [lat[0], lat[lat.length - 1]];
      const out = [];
      for (const cid of ids) {
        const c = this.cores[cid];
        const kind = this.lockedArea(c.sector);
        if (c.alive && kind) out.push(kind);
      }
      return out;
    }

    gateOpen(from, to) { return this.gateState(from, to) === "open"; }
    controlWallFor(vault) { return this.slides.find((p) => p.vault === vault) || null; }
    slidesIn(s) { return this.slides.filter((p) => p.sector === s); }

    slideTile(pid, cell) {
      const pz = this.slides[pid];
      const moved = pz.move(cell);
      if (moved && pz.solved) this.events.push(["gate_unlocked", pz.sector, pz.vault]);
      return moved;
    }

    returnPad(sector, cameFrom) {
      return this.teleportersIn(sector).find((t) => t.dest === cameFrom) || null;
    }

    // ---- actions ---------------------------------------------------------
    visit(sector) {
      this.sectors[sector].visited = true;
      for (const c of this.coresIn(sector)) c.discovered = true;
    }

    shootCore(coreId, relayed = false) {
      const core = this.cores[coreId];
      if (this.state !== "playing" || !core.alive) return "dead";
      if (core.warded) return "warded";
      if (core.relayLocked && !relayed) return "refracted";
      core.alive = false;
      core.regenTimer = 0.0;
      this.events.push([this.willRegenerate(core) ? "linked" : "severed", core.id]);
      if (this.drone.enabled && !this.drone.active) {
        this._spawnDrone();
        this.events.push(["drone_alert"]);
      }
      if (this.latticeAlive(core.lattice) === 0) this.events.push(["lattice_down", core.lattice]);
      if (this.liveCores === 0) {
        this.state = "won";
        this.events.push(["won"]);
      }
      return "destroyed";
    }

    tripBreaker(id) {
      const b = this.breakers[id];
      if (b.tripped) return false;
      b.tripped = true;
      this.cores[b.core].warded = false;
      this.events.push(["ward_down", b.core]);
      return true;
    }

    pressSwitch(pid, index) {
      const puzzle = this.puzzles[pid];
      if (puzzle.solved) return false;
      puzzle.press(index);
      if (puzzle.solved) {
        const tp = this.teleporters[puzzle.teleporter];
        tp.active = true;
        this.events.push(["transporter_on", tp.id]);
        return true;
      }
      return false;
    }

    collectPack(id) {
      const pack = this.packs[id];
      if (pack.taken) return false;
      pack.taken = true;
      this.player.heal(...PACK_AMOUNTS[pack.kind]);
      this.events.push(["pack", pack.kind]);
      return true;
    }

    // ---- hunter drone ----------------------------------------------------
    _pathStep(start, goal) {
      const prev = new Map([[start, null]]);
      const todo = [start];
      while (todo.length) {
        const cur = todo.shift();
        if (cur === goal) break;
        for (const n of this.sectors[cur].neighbours) {
          if (!prev.has(n) && this.gateOpen(cur, n)) { prev.set(n, cur); todo.push(n); }
        }
      }
      if (!prev.has(goal)) return start;
      let step = goal;
      while (prev.get(step) !== start && prev.get(step) !== null) step = prev.get(step);
      return step;
    }

    _spawnDrone() {
      const d = this.drone;
      let reachable = this.walkableFrom(this.playerSector);
      reachable.delete(this.playerSector);
      if (this.sealed.has(this.playerSector) || !reachable.size) {
        reachable = this.walkableFrom(this.startSector);
        reachable.delete(this.playerSector);
      }
      let options = [...reachable].filter((s) => this._walkDistance(s, this.playerSector) === 3);
      if (!options.length) options = reachable.size ? [...reachable] : [this.startSector];
      options = sortedNums(options);
      d.sector = this.rng.choice(options);
      d.active = true; d.alive = true; d.hp = DRONE.MAX_HP;
      d.travelTimer = 0.0;
    }

    setPlayerSector(sector) {
      this.playerSector = sector;
      this.drone.travelTimer = Math.min(this.drone.travelTimer, DRONE.STEP_TIME * 0.5);
    }

    _walkDistance(a, b) {
      let d = 0, frontier = new Set([a]);
      const seen = new Set([a]);
      while (!frontier.has(b)) {
        const next = new Set();
        for (const f of frontier) for (const n of this.sectors[f].neighbours) {
          if (!seen.has(n) && this.gateOpen(f, n)) next.add(n);
        }
        if (!next.size) return 99;
        frontier = next;
        for (const n of frontier) seen.add(n);
        d += 1;
      }
      return d;
    }

    droneDistance() {
      const d = this.drone;
      if (!(d.enabled && d.active && d.alive)) return null;
      return this._walkDistance(d.sector, this.playerSector);
    }

    damageDrone(amount = 1) {
      const d = this.drone;
      if (!(d.active && d.alive)) return false;
      d.hp -= amount;
      if (d.hp <= 0) {
        d.alive = false;
        d.respawnTimer = DRONE.RESPAWN_TIME;
        this.events.push(["drone_down"]);
        return true;
      }
      return false;
    }

    _updateDrone(dt) {
      const d = this.drone;
      if (!(d.enabled && d.active)) return;
      if (!d.alive) {
        d.respawnTimer -= dt;
        if (d.respawnTimer <= 0) { this._spawnDrone(); this.events.push(["drone_alert"]); }
        return;
      }
      if (d.sector === this.playerSector) { d.travelTimer = 0.0; return; }
      d.travelTimer += dt;
      if (d.travelTimer >= DRONE.STEP_TIME) {
        d.travelTimer = 0.0;
        const nxt = this._pathStep(d.sector, this.playerSector);
        if (nxt !== d.sector) {
          const prev = d.sector;
          d.sector = nxt;
          this.events.push(["drone_moved", nxt, prev]);
        }
      }
    }

    // ---- mirror relays ---------------------------------------------------
    relayPuzzlesIn(s) { return this.relayPuzzles.filter((p) => p.sector === s); }

    rotateRelay(id) {
      const r = this.relays[id];
      r.facing = (r.facing + 1) % 8;
      return r.facing;
    }

    traceBeam(pid, maxRange = 90.0) {
      const pz = this.relayPuzzles[pid];
      const core = this.cores[pz.core];
      let pos = [pz.ex, pz.ez], facing = pz.efacing;
      const points = [pos];
      const visited = new Set();
      let current = null;
      for (let step = 0; step < 12; step++) {
        const [dx, dz] = facingVector(facing);
        let best = null, bestT = maxRange;
        const targets = pz.relays.map((rid) => this.relays[rid])
          .filter((r) => r.id !== current).map((r) => ["relay", r]);
        if (core.alive) targets.push(["core", core]);
        for (const [kind, obj] of targets) {
          const wx = obj.x - pos[0], wz = obj.z - pos[1];
          const t = wx * dx + wz * dz;
          if (t <= 0.5 || t >= bestT) continue;
          if (hypot(wx - dx * t, wz - dz * t) < RELAY_RADIUS) { best = [kind, obj]; bestT = t; }
        }
        const end = [pos[0] + dx * bestT, pos[1] + dz * bestT];
        if (best === null) { points.push(end); return [points, "miss"]; }
        const [kind, obj] = best;
        points.push([obj.x, obj.z]);
        if (kind === "core") return [points, "core"];
        if (visited.has(obj.id)) return [points, "relay_loop"];
        visited.add(obj.id);
        current = obj.id; pos = [obj.x, obj.z]; facing = obj.facing;
      }
      return [points, "relay_loop"];
    }

    fireEmitter(pid) {
      const [points, result] = this.traceBeam(pid);
      if (result === "core") this.shootCore(this.relayPuzzles[pid].core, true);
      return [points, result];
    }

    killSentry(id) { this.sentries[id].alive = false; }

    update(dt) {
      if (this.state !== "playing") return;
      this.elapsed += dt;
      this._updateSunlight();
      this._updateDrone(dt);
      for (const core of this.cores) {
        if (core.alive) continue;
        if (this.willRegenerate(core)) {
          core.regenTimer += dt;
          if (core.regenTimer >= Moon.REGEN_DELAY) {
            core.alive = true;
            core.regenTimer = 0.0;
            this.events.push(["rebuilt", core.id]);
          }
        } else {
          core.regenTimer = 0.0;
        }
      }
      this.charge = Math.min(1.0, this.charge + this.chargeRate * dt);
      if (this.charge >= 1.0) {
        this.state = "lost";
        this.events.push(["lost", "lance"]);
      } else if (this.player.shield <= 0) {
        this.state = "lost";
        this.events.push(["lost", "shield"]);
      }
    }

    // ---- saving ----------------------------------------------------------
    saveState(extra) {
      const d = this.drone;
      return {
        version: Moon.SAVE_VERSION, seed: this.seed, hunter: d.enabled,
        elapsed: this.elapsed, charge: this.charge, state: this.state,
        player: { shield: this.player.shield, fuel: this.player.fuel },
        player_sector: this.playerSector,
        cores: this.cores.map((c) => [c.alive, c.regenTimer, c.warded, c.discovered]),
        breakers: this.breakers.map((b) => b.tripped),
        sentries: this.sentries.map((x) => x.alive),
        packs: this.packs.map((p) => p.taken),
        teleporters: this.teleporters.map((t) => t.active),
        puzzles: this.puzzles.map((p) => [p.state.slice(), p.solved]),
        slides: this.slides.map((p) => [p.tiles.slice(), p.solved]),
        relays: this.relays.map((r) => r.facing),
        visited: this.sectors.map((x) => x.visited),
        drone: [d.active, d.sector, d.hp, d.alive, d.travelTimer, d.respawnTimer],
        extra: extra || {},
      };
    }

    static fromSave(data) {
      if (!data || data.version !== Moon.SAVE_VERSION) {
        throw new Error("the save is from a different version of the game");
      }
      const moon = new Moon({ seed: data.seed, hunter: data.hunter });
      moon.elapsed = data.elapsed; moon.charge = data.charge; moon.state = data.state;
      moon.player.shield = data.player.shield; moon.player.fuel = data.player.fuel;
      moon.playerSector = data.player_sector;
      moon.cores.forEach((c, i) => {
        if (!data.cores[i]) return;
        [c.alive, c.regenTimer, c.warded, c.discovered] = data.cores[i];
      });
      moon.breakers.forEach((b, i) => { if (i in data.breakers) b.tripped = data.breakers[i]; });
      moon.sentries.forEach((x, i) => { if (i in data.sentries) x.alive = data.sentries[i]; });
      moon.packs.forEach((p, i) => { if (i in data.packs) p.taken = data.packs[i]; });
      moon.teleporters.forEach((t, i) => {
        if (i in data.teleporters) t.active = data.teleporters[i];
      });
      moon.puzzles.forEach((p, i) => {
        if (!data.puzzles[i]) return;
        p.state = data.puzzles[i][0].slice(); p.solved = data.puzzles[i][1];
      });
      moon.slides.forEach((p, i) => {
        if (!data.slides[i]) return;
        p.tiles = data.slides[i][0].slice(); p.solved = data.slides[i][1];
      });
      moon.relays.forEach((r, i) => { if (i in data.relays) r.facing = data.relays[i]; });
      moon.sectors.forEach((x, i) => { if (i in data.visited) x.visited = data.visited[i]; });
      const d = moon.drone;
      [d.active, d.sector, d.hp, d.alive, d.travelTimer, d.respawnTimer] = data.drone;
      moon._updateSunlight();
      moon.saveExtra = data.extra || {};
      return moon;
    }

    popEvents() { const ev = this.events; this.events = []; return ev; }
  }
  Object.assign(Moon, {
    FULL_CHARGE_TIME: 1023.0, REGEN_DELAY: 1.5, PREDICT_STEP: 2.0,
    PREDICT_HORIZON: 6 * 3600.0, SAVE_VERSION: 3,
  });

  function formatTime(seconds) {
    if (!isFinite(seconds)) return "--:--";
    const s = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  /** A plain snapshot of the generated world, used to compare with Python. */
  function worldSnapshot(m) {
    return {
      seed: m.seed, start: m.startSector, double_locked: m.doubleLocked,
      hues: m.sectors.map((s) => s.hue),
      cores: m.cores.map((c) => [c.lattice, c.index, c.sector, c.x, c.z, c.height, c.warded,
                                 c.relayLocked]),
      lattices: m.lattices,
      sealed: sortedNums(m.sealed), vaults: sortedNums(m.vaults),
      rubble: [...m.rubble].sort(), locks: [...m.locks.entries()],
      teleporters: m.teleporters.map((t) => [t.sector, t.x, t.z, t.dest, t.puzzle, t.active]),
      puzzles: m.puzzles.map((p) => [p.sector, p.positions, p.links, p.state]),
      slides: m.slides.map((p) => [p.sector, p.vault, p.x, p.z, p.tiles, p.scramble]),
      relays: m.relays.map((r) => [r.puzzle, r.x, r.z, r.facing, r.solution]),
      relay_puzzles: m.relayPuzzles.map((p) => [p.sector, p.core, p.ex, p.ez, p.efacing,
                                                p.relays]),
      silos: m.silos.map((s) => [s.sector, s.x, s.z, s.height]),
      chasms: m.chasms.map((c) => [c.sector, c.gate, c.d, c.width]),
      breakers: m.breakers.map((b) => [b.sector, b.x, b.z, b.core]),
      sentries: m.sentries.map((s) => [s.sector, s.x, s.z]),
      packs: m.packs.map((p) => [p.sector, p.x, p.z, p.kind]),
      buildings: m.sectors.map((s) => s.buildings.map((b) => [b.x, b.z, b.w, b.d, b.h, b.rot,
                                                              b.style])),
      ref_output: m.refOutput,
    };
  }

  const api = {
    Moon, Silo, SwitchPuzzle, SlidePuzzle, Chasm, PlayerState, formatTime, worldSnapshot,
    icosahedronAdjacency, faceLatLon, mapLatLon, faceNormal, localFrame, toLocal, norm, dot,
    sunDirectionAt, sectorSunlight, outputFor, gatePosition, facingVector, edgeKey, edgeEnds,
    SECTOR_NAMES, LATTICE_COLOURS, SUN_DIRECTION, DAY_LENGTH, MIN_OUTPUT, MAX_OUTPUT,
    SECTOR_HALF_SIZE, GATE_RADIUS, SPAWN_CLEAR_RADIUS, RELAY_RADIUS, BEAM_HEIGHT, DRONE,
    PACK_AMOUNTS, RAD2DEG, DEG2RAD, TAU,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PO = Object.assign(root.PO || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
