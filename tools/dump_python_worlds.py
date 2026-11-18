"""Print snapshots of Python-generated moons as JSON (for compare_with_python.js).

Usage:  python tools/dump_python_worlds.py PATH_TO_PYTHON_PALE_ORBIT_FOLDER FIRST_SEED COUNT
"""
import json
import sys

sys.path.insert(0, sys.argv[1])
from pale_orbit.logic import Moon  # noqa: E402


def snapshot(m):
    return {
        "seed": m.seed, "start": m.start_sector,
        "double_locked": list(m.double_locked) if m.double_locked else None,
        "hues": [s.hue for s in m.sectors],
        "cores": [[c.lattice, c.index, c.sector, c.x, c.z, c.height, c.warded, c.relay_locked]
                  for c in m.cores],
        "lattices": m.lattices,
        "sealed": sorted(m.sealed), "vaults": sorted(m.vaults),
        "rubble": sorted("-".join(map(str, sorted(e))) for e in m.rubble),
        "locks": [["-".join(map(str, sorted(e))), v] for e, v in m.locks.items()],
        "teleporters": [[t.sector, t.x, t.z, t.dest, t.puzzle, t.active] for t in m.teleporters],
        "puzzles": [[p.sector, [list(x) for x in p.positions], p.links, p.state]
                    for p in m.puzzles],
        "slides": [[p.sector, p.vault, p.x, p.z, p.tiles, p.scramble] for p in m.slides],
        "relays": [[r.puzzle, r.x, r.z, r.facing, r.solution] for r in m.relays],
        "relay_puzzles": [[p.sector, p.core, p.ex, p.ez, p.efacing, p.relays]
                          for p in m.relay_puzzles],
        "silos": [[s.sector, s.x, s.z, s.height] for s in m.silos],
        "chasms": [[c.sector, c.gate, c.d, c.width] for c in m.chasms],
        "breakers": [[b.sector, b.x, b.z, b.core] for b in m.breakers],
        "sentries": [[s.sector, s.x, s.z] for s in m.sentries],
        "packs": [[p.sector, p.x, p.z, p.kind] for p in m.packs],
        "buildings": [[[b.x, b.z, b.w, b.d, b.h, b.rot, b.style] for b in s.buildings]
                      for s in m.sectors],
        "ref_output": m.ref_output,
    }


first, count = int(sys.argv[2]), int(sys.argv[3])
print(json.dumps([snapshot(Moon(seed=s)) for s in range(first, first + count)]))
