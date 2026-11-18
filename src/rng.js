/*
 * A random number generator that produces exactly the same numbers as
 * Python's `random.Random(seed)` (CPython 3.11+), so a moon seed gives the
 * same layout here as in the Python version of Pale Orbit.
 *
 * It is a port of CPython's Mersenne Twister (MT19937) together with the
 * pure-Python helpers in Lib/random.py that the game uses: random(),
 * uniform(), randrange(), randint(), choice(), shuffle() and sample().
 */
(function (root) {
  "use strict";

  const N = 624, M = 397;
  const MATRIX_A = 0x9908b0df, UPPER = 0x80000000, LOWER = 0x7fffffff;

  class PyRandom {
    constructor(seed) {
      this.mt = new Uint32Array(N);
      this.mti = N + 1;
      this.seed(seed);
    }

    // --- seeding (CPython random_seed + init_by_array) ---------------------
    _initGenrand(s) {
      const mt = this.mt;
      mt[0] = s >>> 0;
      for (let i = 1; i < N; i++) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        // 1812433253 * prev + i, in 32-bit arithmetic
        mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
      }
      this.mti = N;
    }

    _initByArray(key) {
      const mt = this.mt;
      this._initGenrand(19650218);
      let i = 1, j = 0;
      for (let k = Math.max(N, key.length); k; k--) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
        i++; j++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
        if (j >= key.length) j = 0;
      }
      for (let k = N - 1; k; k--) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
        i++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      }
      mt[0] = 0x80000000;
    }

    seed(seed) {
      // Python seeds with abs(int) split into 32-bit words, lowest first.
      let n = BigInt(Math.trunc(Math.abs(Number(seed))));
      if (typeof seed === "bigint") n = seed < 0n ? -seed : seed;
      const key = [];
      if (n === 0n) key.push(0);
      while (n > 0n) {
        key.push(Number(n & 0xffffffffn));
        n >>= 32n;
      }
      this._initByArray(key);
    }

    // --- core generator ----------------------------------------------------
    _genrand() {
      const mt = this.mt;
      let y;
      if (this.mti >= N) {
        let kk = 0;
        for (; kk < N - M; kk++) {
          y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
          mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
        }
        for (; kk < N - 1; kk++) {
          y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
          mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
        }
        y = (mt[N - 1] & UPPER) | (mt[0] & LOWER);
        mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
        this.mti = 0;
      }
      y = mt[this.mti++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    }

    /** float in [0, 1) with 53 bits, exactly like Python's random() */
    random() {
      const a = this._genrand() >>> 5, b = this._genrand() >>> 6;
      return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
    }

    getrandbits(k) {
      if (k <= 0) return 0;
      if (k > 32) throw new Error("getrandbits > 32 not needed by the game");
      return this._genrand() >>> (32 - k);
    }

    _randbelow(n) {
      if (n <= 0) throw new Error("empty range");
      const k = 32 - Math.clz32(n);            // n.bit_length()
      let r = this.getrandbits(k);
      while (r >= n) r = this.getrandbits(k);
      return r;
    }

    // --- Lib/random.py helpers ---------------------------------------------
    uniform(a, b) { return a + (b - a) * this.random(); }

    randrange(start, stop) {
      if (stop === undefined) return this._randbelow(start);
      return start + this._randbelow(stop - start);
    }

    randint(a, b) { return this.randrange(a, b + 1); }

    choice(seq) {
      if (!seq.length) throw new Error("Cannot choose from an empty sequence");
      return seq[this._randbelow(seq.length)];
    }

    shuffle(x) {
      for (let i = x.length - 1; i > 0; i--) {
        const j = this._randbelow(i + 1);
        const t = x[i]; x[i] = x[j]; x[j] = t;
      }
      return x;
    }

    sample(population, k) {
      const pop = Array.from(population);
      const n = pop.length;
      if (k < 0 || k > n) throw new Error("Sample larger than population");
      const result = new Array(k);
      let setsize = 21;
      if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
      if (n <= setsize) {
        const pool = pop.slice();
        for (let i = 0; i < k; i++) {
          const j = this._randbelow(n - i);
          result[i] = pool[j];
          pool[j] = pool[n - i - 1];
        }
      } else {
        const selected = new Set();
        for (let i = 0; i < k; i++) {
          let j = this._randbelow(n);
          while (selected.has(j)) j = this._randbelow(n);
          selected.add(j);
          result[i] = pop[j];
        }
      }
      return result;
    }

    /** Python's expovariate(lambd) */
    expovariate(lambd) { return -Math.log(1.0 - this.random()) / lambd; }

    /** Python's gauss(mu, sigma) (uses a cached second value, like CPython) */
    gauss(mu = 0, sigma = 1) {
      let z = this._gaussNext;
      this._gaussNext = null;
      if (z == null) {
        const x2pi = this.random() * 2 * Math.PI;
        const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
        z = Math.cos(x2pi) * g2rad;
        this._gaussNext = Math.sin(x2pi) * g2rad;
      }
      return mu + z * sigma;
    }
  }

  const api = { PyRandom };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PO = Object.assign(root.PO || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
