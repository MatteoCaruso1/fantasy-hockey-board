"""Export the owner's projections (A&G 2026-27 with his adjustments) to projections/ag-2026-27.json.

Reads the raw projected stat lines from the "Points projections" sheet of
projections/My Projections.xlsm so the engine can score them with the
league's own weights. Re-run after editing the workbook:
    python projections/export_ag.py
"""
import json
import os

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOK = os.path.join(ROOT, "projections", "My Projections.xlsm")
OUT = os.path.join(ROOT, "projections", "ag-2026-27.json")

wb = openpyxl.load_workbook(BOOK, read_only=True, data_only=True)

skaters = []
ws = wb["Points projections"]
# Header row 7: Taken?, Rank, -, Name, Team, Y! Pos, Proj PP, GP, G, A, PTS, PPP, SOG, HIT, BLK, PIM, S%, ATOI
for r in ws.iter_rows(min_row=8, values_only=True):
    if not r[3] or not r[7]:
        continue
    skaters.append({
        "rank": r[1], "name": r[3], "team": r[4], "pos": r[5], "ppUnit": r[6],
        "GP": r[7], "G": r[8], "A": r[9], "PPP": r[11], "SOG": r[12], "HIT": r[13], "BLK": r[14],
        "ATOI": r[17],
    })

goalies = []
ws = wb["Goalie Ranks & Tiers"]
for r in ws.iter_rows(min_row=2, values_only=True):
    if r[2]:
        goalies.append({"rank": r[0], "tier": r[1], "name": r[2], "team": r[3]})

with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"source": os.path.basename(BOOK), "skaters": skaters, "goalies": goalies}, f)
print(f"{len(skaters)} skaters, {len(goalies)} goalies -> {OUT}")
