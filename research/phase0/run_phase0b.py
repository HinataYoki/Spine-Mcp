"""Phase 0b: animation-import edge cases the safety validator depends on.

Run outside the sandbox after run_phase0.py:
    python3 research/phase0/run_phase0b.py <lab_dir>
"""
import copy
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import run_phase0 as p0  # noqa: E402

LAB = Path(sys.argv[1]).resolve()
OUT = LAB / "phase0b"


def fresh(name):
    work = OUT / name
    shutil.copytree(LAB / "src" / name, work)
    return work, work / f"{name}-pro.spine"


def anim_import(work, proj, doc, anim, extra=()):
    src = work / f"in-{anim}.json"
    src.write_text(json.dumps(doc))
    size0 = proj.stat().st_size
    rc, secs, lines = p0.run("-i", src, "-o", proj, "-a", anim, *extra, "-r")
    return rc, lines, size0, proj.stat().st_size


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    # E12: .spine size delta for a pure animation add (editor-only data should survive).
    work, proj = fresh("spineboy")
    _, _, _, base = p0.export_json(proj, OUT / "sb-base")
    doc = copy.deepcopy(base)
    doc["animations"]["idle_copy"] = copy.deepcopy(base["animations"]["idle"])
    rc, lines, s0, s1 = anim_import(work, proj, doc, "idle_copy")
    idle_only = work / "idle_only.json"
    solo = copy.deepcopy(base)
    solo["animations"] = {"idle": base["animations"]["idle"]}
    idle_only.write_text(json.dumps(solo))
    # First import re-saves the project with the current editor version, so measure a second add.
    doc["animations"]["idle_copy2"] = copy.deepcopy(base["animations"]["idle"])
    rc2, lines2, s2, s3 = anim_import(work, proj, doc, "idle_copy2")
    p0.record("size_delta_anim_add", rc == 0 and rc2 == 0,
              f"first add {s0}->{s1} (re-save); second add {s2}->{s3} (+{s3 - s2} B); idle json {len(json.dumps(base['animations']['idle']))} B")

    # E13a: animation keys a bone missing from the target.
    doc = copy.deepcopy(base)
    a = copy.deepcopy(base["animations"]["idle"])
    a["bones"]["ghost-bone"] = {"rotate": [{"value": 10}, {"time": 1, "value": -10}]}
    doc["bones"].append({"name": "ghost-bone", "parent": "root"})
    doc["animations"]["missing_bone"] = a
    rc, lines, s0, s1 = anim_import(work, proj, doc, "missing_bone")
    _, _, _, chk = p0.export_json(proj, OUT / "sb-e13a")
    got = chk["animations"].get("missing_bone", {}).get("bones", {}) if chk else {}
    p0.record("anim_missing_bone", True,
              f"rc={rc} imported={'missing_bone' in (chk or {}).get('animations', {})} "
              f"ghost_kept={'ghost-bone' in got} bone_added={any(b['name'] == 'ghost-bone' for b in (chk or {}).get('bones', []))} log={lines[-3:]}")

    # E13b: animation references a bone that does not exist in the source JSON either (invalid input).
    doc = copy.deepcopy(base)
    a = copy.deepcopy(base["animations"]["idle"])
    a["bones"]["nope-bone"] = {"rotate": [{"value": 5}]}
    doc["animations"]["invalid_ref"] = a
    rc, lines, s0, s1 = anim_import(work, proj, doc, "invalid_ref")
    p0.record("anim_invalid_ref", rc != 0, f"rc={rc} size {s0}->{s1} log={lines[-3:]}")

    # E13c: slot attachment key naming an attachment missing from the target skin.
    doc = copy.deepcopy(base)
    a = copy.deepcopy(base["animations"]["idle"])
    a.setdefault("slots", {})["eye"] = {"attachment": [{"name": "eye-ghost"}]}
    doc["skins"][0]["attachments"].setdefault("eye", {})["eye-ghost"] = {"width": 10, "height": 10}
    doc["animations"]["missing_att"] = a
    rc, lines, s0, s1 = anim_import(work, proj, doc, "missing_att")
    _, _, _, chk = p0.export_json(proj, OUT / "sb-e13c")
    att = (chk or {}).get("skins", [{}])[0].get("attachments", {}).get("eye", {})
    p0.record("anim_missing_attachment", True,
              f"rc={rc} imported={'missing_att' in (chk or {}).get('animations', {})} attachment_added={'eye-ghost' in att} log={lines[-3:]}")

    # E14: --from/--to on a multi-skeleton target.
    two = OUT / "two.spine"
    shutil.copy(proj, two)
    rc, _, lines = p0.run("-i", idle_only, "-o", two, "--to", "second", "-r")
    doc = copy.deepcopy(base)
    doc["animations"] = {"to_second": base["animations"]["idle"]}
    src = work / "to_second.json"
    src.write_text(json.dumps(doc))
    rc2, _, lines2 = p0.run("-i", src, "-o", two, "--to", "second", "-a", "to_second", "-r")
    info2 = p0.run("-i", two)[2]
    p0.record("from_to_multi_skeleton", rc == 0 and rc2 == 0,
              f"skeleton_import rc={rc} anim_to rc={rc2} log={lines2[-2:]} info={[l.strip() for l in info2 if 'Skeleton' in l or 'Animations' in l]}")

    # E15a: physics timelines (celestial-circus).
    work, proj = fresh("celestial-circus")
    _, _, _, cc = p0.export_json(proj, OUT / "cc-base")
    phys_anim = next((n for n, a in cc["animations"].items() if "physics" in a), None)
    doc = copy.deepcopy(cc)
    doc["animations"][f"{phys_anim}_copy"] = copy.deepcopy(cc["animations"][phys_anim])
    rc, lines, s0, s1 = anim_import(work, proj, doc, f"{phys_anim}_copy")
    _, _, _, chk = p0.export_json(proj, OUT / "cc-after")
    d = p0.diff_paths(cc["animations"][phys_anim], chk["animations"].get(f"{phys_anim}_copy")) if chk else ["no export"]
    p0.record("anim_physics_timelines", rc == 0 and not d, f"anim={phys_anim} rc={rc} diffs={d[:3]} +{s1 - s0} B")

    # E15b: slider constraint + slider animation (diamond).
    work, proj = fresh("diamond")
    _, _, _, dm = p0.export_json(proj, OUT / "dm-base")
    sliders = [c for c in dm.get("constraints", []) if c["type"] == "slider"]
    slider_anim = next((n for n, a in dm["animations"].items() if "slider" in a), None)
    driven = sliders[0].get("animation") if sliders else None
    target = slider_anim or driven
    doc = copy.deepcopy(dm)
    doc["animations"][f"{target}_copy"] = copy.deepcopy(dm["animations"][target])
    rc, lines, s0, s1 = anim_import(work, proj, doc, f"{target}_copy")
    _, _, _, chk = p0.export_json(proj, OUT / "dm-after")
    d = p0.diff_paths(dm["animations"][target], chk["animations"].get(f"{target}_copy")) if chk else ["no export"]
    p0.record("anim_slider", rc == 0 and not d,
              f"slider={sliders[0] if sliders else None} slider_anim={slider_anim} copied={target} rc={rc} diffs={d[:3]}")

    # E15c: deform timelines (find any animation with deform/attachments mesh keys).
    deform = None
    for name in ("raptor", "alien", "owl", "spineboy", "celestial-circus"):
        js = list((OUT / "sb-base").glob("*.json")) if name == "spineboy" else list((LAB / "out").glob(f"{name}-json/*.json"))
        for j in js:
            dd = json.loads(j.read_text())
            for an, a in dd["animations"].items():
                if "attachments" in a:
                    deform = (name, an, j)
                    break
            if deform:
                break
        if deform:
            break
    if deform:
        name, an, j = deform
        work, proj = fresh(name)
        dd = json.loads(j.read_text())
        dd["animations"][f"{an}_copy"] = copy.deepcopy(dd["animations"][an])
        rc, lines, s0, s1 = anim_import(work, proj, dd, f"{an}_copy")
        _, _, _, chk = p0.export_json(proj, OUT / f"{name}-deform")
        d = p0.diff_paths(dd["animations"][an], chk["animations"].get(f"{an}_copy")) if chk else ["no export"]
        p0.record("anim_deform", rc == 0 and not d, f"{name}/{an} rc={rc} diffs={d[:3]}")

    (OUT / "results.json").write_text(json.dumps(p0.results, indent=2))


if __name__ == "__main__":
    main()
