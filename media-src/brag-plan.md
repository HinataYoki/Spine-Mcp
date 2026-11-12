# Brag Plan: spine-mcp (v0.70 README videos)

A launch video plus nine feature videos, one per area, all in one HyperFrames project (`composition/`). Every clip,
picture and number on screen comes from the real spine-mcp server: `scripts/make-feature-media.mjs` drives it over stdio
on Bolt (the hand-built demo rig and Bolt rebuilt from a layered PSD) and writes `.lab/feature-media/facts.json`; the
videos only show what that file and the tool images say.

## What is this app?
An MCP server that lets an AI agent read, measure, render and safely edit Spine 4.3 projects: a layered PSD to a
rigged, animated character, verified writes, review tools, and the hand-off into Unity.

## The angle
"Every shot is a real result." Short, polished cards in the launch video's identity: indigo radial background, light
panels for Spine renders, teal ticks, monospace tool calls, the same music bed and soft UI clicks.

## Videos

| File | Length | Story |
|---|---|---|
| `index.html` (launch) | 22.5 s | PSD layers → auto rig → walk / turn / hop-squash → four write-safety rows + Unity's render next to Spine's → logo. |
| `feature-rig.html` | 18 s | 13 layers float in and gather → `spine_import_layers` (13 slots, 0.99 vs PSD, art check: torso/head don't overlap) → `spine_auto_rig` suggestions (13 bones, 4 IK) → built rig posed by Spine (18 bones · 13 meshes · 4 IK, 0.008 px). |
| `feature-animate.html` | 20 s | Walking rig beside the hook → prompt → walk / run / turn / hop-squash → prompt → breathe / look / hop-follow / blocking → spline, each card with the tool's own note. |
| `feature-derive.html` | 20 s | wave vs wave-mirrored (4 limb pairs) → hop vs hop-big (67.0° → 88.0°, 1.0 → 1.2 s) → idle, idle-overlap, hop-baked (255 keys). |
| `feature-review.html` | 20 s | Onion skin / arcs / curves → review cut beside mix and budget results (one pop: 92 units with no mix) → reference timing (1.21×, 6 peaks within 0.8 frame). |
| `feature-safety.html` | 20 s | "Spine drops a key and still says OK." → refused write → verified write (backup, import, compare, rollback) → `spine_status` steps + conformance (24 probes, 11 critical, all pass). |
| `feature-ship.html` | 20 s | Mobile export (1 page, 78%, 0.32 MB) → Unity parity (0.0001 units) and render (0.97, URP too) → `spine_unity_import` prefab kinds beside the spine-webgl render. |
| `feature-face.html` | 20 s | A blink from the artist's shut pose → blinks over head moves → eye darts (mix-and-match, Esoteric). |
| `feature-game.html` | 20 s | An Animator transition that pops in Unity and its fix → layered tracks, UI, draw calls, texture memory → lost events, the upgrade audit. |
| `feature-parts.html` | 20 s | Hook: "No PSD. Just a folder of PNGs." → 24 parts on the painting (IoU 1.0) → a slipped head and specks caught (IoU 0.96, edge alpha, stray pixels) → two characters rigged (31 bones, 24 slots, 6 IK) and breathing apart. |
| `feature-production.html` | 20 s | A file another tool wrote (weight order refused by Spine, a stretched region), fixed on the way in → a bake cleaned from 183 keys to 12 → a team profile's defaults and findings, part travel on a phone. |

Each: hook (3 s) → 2–3 highlights → outro (logo, one line, "38 tools · Spine 4.3 · MCP"). Brand bug bottom left.

## Build

```bash
npm run build && node scripts/make-feature-media.mjs      # media (outside the Claude Code sandbox)
node media-src/composition/build.mjs sync               # into composition/assets/gen (git-ignored)
node media-src/composition/build.mjs check              # hyperframes check, every video
node media-src/composition/build.mjs snap <name> <times>
node media-src/composition/build.mjs render             # composition/renders/<name>.mp4
node media-src/composition/build.mjs publish            # docs/media: mp4 (poster as frame 0), inline webp loop, jpg
```

## Found while making them
- A blocking pose at the end of a loop was keyed twice; the write failed verification (fixed, tested).
- Reference-timing and video-inspect charts drew every line black (ImageMagick SVG; fixed with MVG, tested).
- Unity and web renders differed only in the antenna (each renderer simulates physics): the videos compare `hop-baked`.
- Videos without an `id` freeze in HyperFrames renders (the check catches it).

## Audio
"Happy Beats / Business Moves, Vol. 12" by Sascha Ende (ende.app, CC BY 4.0) at 0.3 with fades, Kenney UI sounds (CC0) under it.
