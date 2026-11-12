"""Phase 0: verify Spine 4.3 CLI behaviour that the MCP design depends on.

Run outside the Claude Code sandbox (the Spine launcher hangs inside it):
    python3 research/phase0/run_phase0.py <lab_dir>
<lab_dir>/src/<name>/<name>-pro.spine + images/ must exist (copies of official examples).
"""
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

SPINE = "/Applications/Spine.app/Contents/MacOS/Spine"
LAB = Path(sys.argv[1]).resolve()
OUT = LAB / "phase0"
results = []


def run(*args):
    t0 = time.time()
    p = subprocess.run([SPINE, *map(str, args)], capture_output=True, text=True)
    out = (p.stdout + p.stderr).strip().splitlines()
    noise = ("Spine Launcher", "Esoteric Software", "Mac OS X", "Starting:", "Licensed to")
    lines = [l for l in out if not l.startswith(noise)]
    return p.returncode, round(time.time() - t0, 1), lines


def record(name, ok, detail):
    results.append({"experiment": name, "ok": ok, "detail": detail})
    print(f"[{'OK' if ok else 'FAIL'}] {name}: {detail}")


def export_json(project, dest):
    dest.mkdir(parents=True, exist_ok=True)
    rc, secs, lines = run("-i", project, "-o", dest, "-e", "json")
    files = list(dest.glob("*.json"))
    return rc, secs, lines, (json.loads(files[0].read_text()) if files else None)


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:12]


def strip_hash(d):
    d = copy.deepcopy(d)
    d["skeleton"].pop("hash", None)
    return d


DEFAULTS = {"value": 0, "x": 0, "y": 0, "time": 0}


def normalize(o):
    """Drop default-valued keyframe fields, as Spine does on export."""
    if isinstance(o, dict):
        return {k: normalize(v) for k, v in o.items() if not (k in DEFAULTS and v == DEFAULTS[k])}
    if isinstance(o, list):
        return [normalize(v) for v in o]
    return o


def diff_paths(a, b, path="", out=None, limit=20):
    out = [] if out is None else out
    if not path:
        a, b = normalize(a), normalize(b)
    if len(out) >= limit:
        return out
    num = (int, float)
    if isinstance(a, num) and isinstance(b, num) and not isinstance(a, bool) and not isinstance(b, bool):
        if abs(a - b) > 1e-4:
            out.append(f"{path}: {a}->{b}")
    elif type(a) is not type(b):
        out.append(f"{path}: type {type(a).__name__}->{type(b).__name__}")
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{path}/{k}: added")
            elif k not in b:
                out.append(f"{path}/{k}: removed")
            else:
                diff_paths(a[k], b[k], f"{path}/{k}", out, limit)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: len {len(a)}->{len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diff_paths(x, y, f"{path}[{i}]", out, limit)
    elif isinstance(a, float) or isinstance(b, float):
        if abs(a - b) > 1e-4:
            out.append(f"{path}: {a}->{b}")
    elif a != b:
        out.append(f"{path}: {a!r}->{b!r}")
    return out


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    src_dir = LAB / "src" / "spineboy"
    work = OUT / "spineboy"
    shutil.copytree(src_dir, work)
    proj = work / "spineboy-pro.spine"

    # E2: baseline export + CLI latency.
    rc, secs, lines, base = export_json(proj, OUT / "base")
    record("export_json", rc == 0 and base is not None, f"rc={rc} {secs}s spine={base and base['skeleton']['spine']}")

    # E4: full roundtrip JSON -> new project -> JSON.
    base_json = next((OUT / "base").glob("*.json"))
    shutil.copy(base_json, work / "rt.json")
    rt_proj = work / "rt.spine"
    rc, secs, lines = run("-i", work / "rt.json", "-o", rt_proj, "-r")
    rc2, _, _, rt = export_json(rt_proj, OUT / "rt")
    d = diff_paths(strip_hash(base), strip_hash(rt)) if rt else ["no export"]
    # Expected finding, not a failure: a full re-import drops editor-only data and resets some fields.
    record("roundtrip_new_project (expected lossy)", rc == 0 and rc2 == 0,
           f"rc={rc} {secs}s diffs={len(d)} {d[:5]} size {proj.stat().st_size}->{rt_proj.stat().st_size}")

    # E5a: add a NEW animation into the ORIGINAL project via animation-only import.
    edited = copy.deepcopy(base)
    anim = copy.deepcopy(edited["animations"]["idle"])
    for bone_tl in anim.get("bones", {}).values():
        for key in bone_tl.get("rotate", []):
            key["value"] = key.get("value", 0) * 1.5
    edited["animations"]["idle_mcp"] = anim
    (work / "edited.json").write_text(json.dumps(edited))
    before = sha(proj)
    rc, secs, lines = run("-i", work / "edited.json", "-o", proj, "-a", "idle_mcp", "-r")
    rc2, _, _, after = export_json(proj, OUT / "after_add")
    ok = rc == 0 and after is not None and "idle_mcp" in after["animations"]
    rest = diff_paths(strip_hash(base), {**strip_hash(after), "animations": {
        k: v for k, v in after["animations"].items() if k != "idle_mcp"}}) if after else ["no export"]
    record("anim_import_new", ok and not rest,
           f"rc={rc} {secs}s added={ok} other_diffs={len(rest)} {rest[:5]} sha {before}->{sha(proj)} log={lines[-3:]}")

    # E5b: replace an EXISTING animation (with and without --replace).
    edited2 = copy.deepcopy(base)
    edited2["animations"]["idle"] = anim
    (work / "edited2.json").write_text(json.dumps(edited2))
    rc, secs, lines = run("-i", work / "edited2.json", "-o", proj, "-a", "idle", "-r")
    _, _, _, chk = export_json(proj, OUT / "after_noreplace")
    changed = chk and chk["animations"]["idle"] != base["animations"]["idle"]
    record("anim_import_existing_no_replace", True,
           f"rc={rc} idle_changed={bool(changed)} anims={chk and sorted(chk['animations'])} log={lines[-3:]}")
    rc, secs, lines = run("-i", work / "edited2.json", "-o", proj, "-a", "idle", "--replace", "-r")
    _, _, _, chk = export_json(proj, OUT / "after_replace")
    d = diff_paths(anim, chk["animations"]["idle"]) if chk else ["no export"]
    record("anim_import_existing_replace", rc == 0 and not d, f"rc={rc} {secs}s diffs={d[:5]} log={lines[-3:]}")

    # E6: skeleton import into an existing project without --replace.
    p6 = work / "e6.spine"
    shutil.copy(src_dir / "spineboy-pro.spine", p6)
    rc, secs, lines = run("-i", work / "edited.json", "-o", p6, "-r")
    info_rc, _, info = run("-i", p6)
    record("skeleton_import_existing", True, f"rc={rc} log={lines[-3:]} info={[l for l in info if 'Skeleton' in l]}")

    # E7: --set override on export (prettyPrint false -> single line).
    rc, secs, lines = run("-i", proj, "-o", OUT / "set", "--set", "prettyPrint=false", "-e", "json")
    f = next((OUT / "set").glob("*.json"), None)
    record("set_override", rc == 0 and f is not None and f.read_text().count("\n") < 3,
           f"rc={rc} lines={f and f.read_text().count(chr(10))}")

    # E8: headless PNG frame export.
    png_settings = {
        "class": "export-png", "exportType": "animation", "skeletonType": "single", "skeleton": "spineboy-pro",
        "animationType": "single", "animation": "idle", "skinType": "current", "scale": 50, "fps": 10,
        "lastFrame": False, "maxBounds": True, "renderImages": True, "packAtlas": None}
    (work / "png.json").write_text(json.dumps(png_settings))
    (OUT / "png").mkdir()
    # -o is a file prefix for image export, not a folder.
    rc, secs, lines = run("-i", proj, "-o", OUT / "png" / "idle", "-e", work / "png.json")
    pngs = sorted((OUT / "png").glob("idle_*.png"))
    record("png_export", rc == 0 and len(pngs) > 0, f"rc={rc} {secs}s frames={len(pngs)} log={lines[-2:]}")

    # E10: error behaviour.
    rc, secs, lines = run("-i", work / "missing.spine")
    record("error_missing_input", rc != 0, f"rc={rc} log={lines[-2:]}")
    bad = work / "bad.json"
    bad.write_text('{"skeleton":{"spine":"4.3.26"},"bones":[{"name":"root"},{"name":"a","parent":"nope"}]}')
    rc, secs, lines = run("-i", bad, "-o", work / "bad.spine", "-r")
    record("error_bad_json", rc != 0, f"rc={rc} log={lines[-3:]}")

    # E11: version pin flag.
    rc, secs, lines = run("-u", "4.3.26", "-i", proj)
    record("version_pin", rc == 0, f"rc={rc} {secs}s")

    (OUT / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
