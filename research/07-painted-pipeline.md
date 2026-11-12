# 07 — A painted-popup kit next to spine-mcp: what each has, what moves here

2026-10-27. On a Windows PC, against a game on spine-unity 4.3.

We compared spine-mcp with a kit for animating painted popup art. That kit:
- cuts a flat painting into parts with SAM3;
- fills what the parts hide (generated layers, smooth continuation);
- mattes the edges;
- builds a puppet and motion from a recipe and writes Spine JSON;
- builds the Unity popup and reviews the pixels of the real prefab.

Here is only what concerns spine-mcp.

## What the comparison showed

**The two hardly overlap.**
- The kit is strong **before** Spine (cutting, hidden fills, edges) and **after** it (prefab building, effects, pixel review in the game's own UI).
- It is weak **inside** Spine:
  - bones are placed by typed pixel coordinates;
  - weights come from blurred maps;
  - meshes have hull 0 and no edges;
  - no IK, one looping animation, no mixes or events;
  - the whole JSON is rebuilt from the recipe on every run (no editor round trip);
  - no data QA, no tests.
- spine-mcp is the reverse. **Plan:** spine-mcp stays the only thing that writes Spine data. The art steps and the pixel review sit around it.

**Cross-checks (measured):**
- **spine-mcp on the kit's own writer output** (2 bones, an 86-vertex weighted outline mesh, physics, rotate and alpha):
  - `validate`: 0 errors, 1 info (`physics-bone-keyed`);
  - `rig_qa`: **`image-missing`** (only the packed page is written, so it is not editor-ready); fold-prone weights at 90° 1.2 %;
  - `budget`: 90 vertices;
  - `measure`: seam ratio 1.1.
- **The Spine 4.3.26 editor's Import Data refused its weighted meshes** ("Index -2 out of bounds") until each vertex listed its bones in bone order. That is G13, met again from the outside.
- **A 4.2 JSON loaded in spine-unity 4.3** through `CreateRuntimeInstance` silently lost its physics (constraints 0). Asset import refuses it (G82).
- **The kit's pixel review on a production two-character idle rig** (a phone-sized render of the real popup):
  - edge travel on a phone: one character's head 14 px, the other's hand 11 px;
  - a 238 px dark rim under the head when it is hidden;
  - the flash slots never on screen (they live in another skin);
  - blink attachment swaps flagged as pops.
  - spine-mcp measures none of these; the kit sees none of spine-mcp's findings (lashes while shut, elbow stretch, mix pops). **Run both.**

## What moves into spine-mcp (roadmap stages)

| Stage | Into | What |
|---|---|---|
| 0 ✓ | `rigedit.ts` | `addBone` remaps weighted bone indices (G127, 0.57.0); schema trimmed to 60,760 |
| 2 | `parts.ts`, `artqa.ts` | Remember which box (cut or filled) placed a cut-boxes part; read See-through `source`; a **cut report** (hidden-paint depth % of height and at joints; alpha only lowered vs the source; double alpha; dark-line ownership; default / non-English names), compared in canvas space (G114). Make D61 a decision |
| 3 | `autorig.ts` | **Multi-character:** a group per part, no parenting across characters, the body chosen per group (not "most connected"). **Team density:** vertex targets per part class (head ~140, body ~54, limb ~33) and a transform budget; optional fine zones (face, eyes). **Weights:** 50 % on the joint, transition 0.4–0.5× thickness on arms and 0.5–0.8× on bodies, ≤3 influences, rigid parts at 1 |
| 4 | `generate.ts`, `write-tools.ts` | **`breathe.path: "figure8"`**: y = breath, x = sway at half frequency, followers late through `offsetBones` wrap, asymmetry, stagger between characters. **`sway`**: whole-cycle sines, phase 0/π, harmonic lag, rest start; a wind mode as a temporary physics constraint with `wind`/`gravity`, baked from rest (D46). **`settle`**: a gesture decaying into idle, far joint 2–4 frames late, speed kept through keys and across the seam. **`blink.switchAt`**: lash / attachment keys at the lid's threshold crossing (G126) |
| 5 | `config.ts`, `export.ts`, `budget.ts` | A **team profile** (`SPINE_MCP_PROFILE` JSON: naming, export preset, budget limits, material notes); a team export preset (binary, straight, one-page check); Unity checks pinned to the game's spine-unity |
| 7 | `rigedit.ts`, `render.ts`, `rigqa.ts` | **Weight ops** (`setWeights`, `smoothWeights`, `transferWeights` from the parent's barycentric weights, `pinVertices` near dark strokes); a **bend preview** (`render_frames` pose + crop, the auto-rig test-pose path); a **concave-clip warning** (G-trap: JSON import makes clips convex and drops `inverse`); team naming in rig QA and the suggestions |

**Weights are out of scope today** (D05, D41, REFERENCE "meshes and weights of an existing rig stay with the editor"). Stage 7 needs a new decision: edits go only into new files, like `rig_edit`.

## Schema budget

60,760 of 62,000 after 0.57.0. New capability goes in as options of existing tools:
- generate types;
- `rig_edit` ops;
- `render_frames` options;
- `rig_qa` codes;
- an export preset.

Raise the cap only with a CHANGELOG note.

## Ideas from the kit that are not features here
- **A depth-order table before building:** for each overlap, the part whose outline forms the shared edge is in front (masks do not tell).
- **"At rest the frame equals the art":** prove it with an error map.
- **Sparse keys:** turning points only, ≤12 per curve, nothing for motion under ~1 % / 1° / 1–2 px on a phone.
- **"Too static" means randomness and tempo**, not more of the same motion.
