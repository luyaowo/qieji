#!/usr/bin/env python3
"""Build the Mac screen face from the checked-in original; --check verifies invariants.

The original font and its license are never overwritten. Run with the project's
Python environment containing fontTools, not as part of the ordinary JS build.
"""
import hashlib
import json
import sys
from pathlib import Path
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "Sources/PaperEdgeApp/MacResources"
SOURCE = RESOURCES / "ZhuqueFangsong-Regular.ttf"
OUTPUT = RESOURCES / "QieJiPaper-Regular.ttf"
MANIFEST = RESOURCES / "QieJiPaper-font.json"
NAMES = {1: "QieJi Paper", 2: "Regular", 3: "QieJiPaper-Regular-C1",
         4: "QieJi Paper Regular", 6: "QieJiPaper-Regular", 16: "QieJi Paper", 17: "Regular"}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def prepare():
    font = TTFont(SOURCE)
    typo = font["OS/2"]
    font["hhea"].ascent = typo.sTypoAscender
    font["hhea"].descent = typo.sTypoDescender
    font["hhea"].lineGap = typo.sTypoLineGap
    for record in font["name"].names:
        if record.nameID in NAMES:
            record.string = NAMES[record.nameID].encode(record.getEncoding(), errors="strict")
    font.save(OUTPUT)
    MANIFEST.write_text(json.dumps({
        "family": "QieJi Paper", "postscript_name": "QieJiPaper-Regular",
        "scope": "Mac screen only; original face retained for print and non-native pages",
        "source": SOURCE.name, "source_sha256": sha(SOURCE),
        "output": OUTPUT.name, "output_sha256": sha(OUTPUT),
        "units_per_em": font["head"].unitsPerEm,
        "hhea": {k: getattr(font["hhea"], k) for k in ("ascent", "descent", "lineGap")},
        "changed_tables": ["hhea", "name", "head checksum/timestamp"],
        "license": "ZhuqueFangsong-OFL.txt",
        "provenance": "C-group metric alignment; original glyphs and OpenType features retained"
    }, ensure_ascii=False, indent=2) + "\n")

def check():
    source, output = TTFont(SOURCE), TTFont(OUTPUT)
    assert set(source.keys()) == set(output.keys()), "Font table inventory changed"
    unchanged = []
    for tag in source.keys():
        if tag in ("GlyphOrder", "hhea", "head", "name"):
            continue
        assert source[tag].compile(source) == output[tag].compile(output), f"Unexpected change: {tag}"
        unchanged.append(tag)
    assert (output["hhea"].ascent, output["hhea"].descent, output["hhea"].lineGap) == (850, -150, 200)
    assert output["head"].unitsPerEm == source["head"].unitsPerEm == 1000
    assert output.getBestCmap() == source.getBestCmap(), "Character coverage changed"
    for record in output["name"].names:
        if record.nameID in NAMES:
            assert record.toUnicode() == NAMES[record.nameID], "Derivative name mismatch"
    # Preserve the source copyright and license records verbatim.
    for name_id in (0, 13, 14):
        assert [r.string for r in source["name"].names if r.nameID == name_id] == [r.string for r in output["name"].names if r.nameID == name_id]
    manifest = json.loads(MANIFEST.read_text())
    assert manifest["source_sha256"] == sha(SOURCE)
    assert manifest["output_sha256"] == sha(OUTPUT)
    assert (RESOURCES / manifest["license"]).exists()
    print(f"Mac font verified: {len(unchanged)} tables unchanged; glyphs, advances, coverage and license preserved")

if "--check" not in sys.argv:
    prepare()
check()
