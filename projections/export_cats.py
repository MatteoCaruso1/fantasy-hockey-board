"""Export the "CATS projections" sheet of projections/My Projections.xlsm to projections/cats-2026-27.json.

The sheet scores each skater category as a z-score that is an exact linear function of his
projected per-game rate (z = a + b * stat/GP), and ranks by the sum of the used categories
("CATS per GP"). This export keeps every player's projected line and recovers each category's
a and b, so the board can put in-season rates on the same scale as the sheet. Re-run after
editing the workbook:
    python projections/export_cats.py
"""
import json
import os

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOK = os.path.join(ROOT, "projections", "My Projections.xlsm")
OUT = os.path.join(ROOT, "projections", "cats-2026-27.json")

wb = openpyxl.load_workbook(BOOK, read_only=True, data_only=True)
ws = wb["CATS projections"]
# Header row 6: Name, Team, Y! Pos, Proj PP, GP, G, G_CAT, A, A_CAT, PTS, PTS_CAT, PPP, PPP_CAT,
# SOG, SOG_CAT, HIT, HIT_CAT, BLK, BLK_CAT, PIM, PIM_CAT, S%, ATOI, ..., CATS per GP (col 36)
COLS = {"G": 5, "A": 7, "PPP": 11, "SOG": 13, "HIT": 15, "BLK": 17}
rows = [r for r in ws.iter_rows(min_row=7, values_only=True) if r[0] and r[4]]

scale = {}
for k, c in COLS.items():
    pts = [(r[c] / r[4], r[c + 1]) for r in rows if isinstance(r[c], (int, float)) and isinstance(r[c + 1], (int, float))]
    n = len(pts)
    sx = sum(x for x, _ in pts); sz = sum(z for _, z in pts)
    sxx = sum(x * x for x, _ in pts); sxz = sum(x * z for x, z in pts)
    b = (n * sxz - sx * sz) / (n * sxx - sx * sx)
    a = (sz - b * sx) / n
    scale[k] = {"a": a, "b": b, "maxErr": max(abs(a + b * x - z) for x, z in pts)}

skaters = [{
    "name": r[0], "team": r[1], "pos": r[2], "ppUnit": r[3], "GP": r[4],
    **{k: r[c] for k, c in COLS.items()}, "ATOI": r[22], "cats": r[35],
} for r in rows]

goalies = []
gs = wb["Goalie Ranks & Tiers"]
for r in gs.iter_rows(min_row=2, values_only=True):
    if r[2]:
        goalies.append({"rank": r[0], "tier": r[1], "name": r[2], "team": r[3]})

with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"source": "CATS projections (A&G, 18 Skaters CATS modification) + Goalie Ranks & Tiers",
               "weights": {k: 1 for k in COLS}, "scale": scale, "skaters": skaters, "goalies": goalies}, f, indent=1)
print(f"Wrote {len(skaters)} skaters, {len(goalies)} goalies; per-game z fit max error "
      + ", ".join(f"{k} {v['maxErr']:.4f}" for k, v in scale.items()))
