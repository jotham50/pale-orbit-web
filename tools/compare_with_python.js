// Check that the browser version builds exactly the same moons as Python.
//
//   python tools/dump_python_worlds.py ../pale-orbit 0 200 > /tmp/py.json
//   node tools/compare_with_python.js /tmp/py.json
const fs = require("fs");
const path = require("path");
const { Moon, worldSnapshot } = require(path.join(__dirname, "..", "src", "logic.js"));

const py = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let same = 0;
const differ = [];
function firstDiff(a, b, where = "") {
  if (typeof a === "number" && typeof b === "number") {
    return a === b || Math.abs(a - b) < 1e-9 ? null : `${where}: ${a} != ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${where}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${where}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of Object.keys(b)) {
      const d = firstDiff(a[k], b[k], `${where}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${where}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}
for (const want of py) {
  const got = worldSnapshot(new Moon({ seed: want.seed }));
  const d = firstDiff(got, want);
  if (d) differ.push(`seed ${want.seed}: ${d}`); else same++;
}
console.log(`${same}/${py.length} moons identical to the Python version`);
for (const d of differ.slice(0, 10)) console.log("  " + d);
process.exit(differ.length ? 1 : 0);
