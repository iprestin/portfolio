# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Serving locally

The page must be served over HTTP — `file://` blocks the font fetch and the SVG loads:

```
cd /Users/artisartis/Desktop/portfolio && python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Architecture

Everything lives in `index.html` as a single self-contained file. There are no build tools, no npm, no dependencies to install. The only external dependency is Matter.js 0.19.0 loaded from CDN.

**Layer 1 — Rigid-body physics (Matter.js)**
Each letter gets one `Bodies.rectangle` (sized at 94% of its visual bounding box). Matter handles gravity, collisions, and drag constraints. The four static walls (floor, ceiling, left, right) are also in the world.

**Layer 2 — SoftBody deformation (custom)**
`SoftBody` is a 6×6 displacement-field grid laid over each rigid body. It has no physics representation — it's purely visual. Deformation is driven by:
- Collision impacts (`collisionStart` event → `applyWorldImpulse`)
- Drag stretch (`beforeUpdate` event — pushes front face, pulls back face)
- Spring restoration + neighbor coupling each tick (`update()`)

The grid stores `[dx, dy, vx, vy]` per cell in a `Float32Array`. `deformPoint(px, py)` bilinearly interpolates displacement to warp each sampled stroke point at draw time.

**Rendering**
Letters are drawn as strokes resampled from SVG path data (100 points per path). Two passes: white buffer stroke (width + 2) then black stroke on top, creating a separation gap when letters overlap.

**Hit testing**
Clicks/touches are hit-tested via `isPointInStroke` on an offscreen 1×1 canvas — not via the rigid body bounds. The mouse coordinate is transformed into SVG-local space before testing.

**Drag**
A `Constraint` spring (stiffness 0.15, damping 0.1, length 0) pulls the body at the exact grab point in body-local coordinates. `dragOffset` stores that local offset so the blue debug dot tracks the actual attach point.

## Asset layout

```
index.html
DrukWide-Heavy-Trial.otf        ← present but not yet wired into the page
DrukWide-SuperItalic-Trial.otf  ← present but not yet wired into the page
letters/
  first name (prestin)/   p r e s t i n  .svg
  last name (artis)/       new A  new R  T  i  s  .svg
```

The active SVG set for ARTIS is `new A.svg` / `new R.svg` (the un-prefixed `A.svg` and `R.svg` are unused alternates).

## Debug overlay

Press **D** in the browser to toggle:
- Red outlines — actual Matter.js rigid-body rectangles
- Blue dot + line — spring grab point and cursor anchor
- Label in top-left corner

`debugOn` is declared after the render function but is closed over by `loop()` — this is intentional (hoisting isn't needed since `loop` is only called after the SVGs load).

## Key tuning values

| Variable | Location | Current value | Effect |
|---|---|---|---|
| `stiffness` | drag `Constraint` | 0.15 | How snappily the letter follows the cursor |
| `k` | `SoftBody.update` | 0.04 | Restore-to-rest spring stiffness |
| `kc` | `SoftBody.update` | 0.024 | Cell-to-cell coupling (wave propagation) |
| `damp` | `SoftBody.update` | 0.06 | Per-tick velocity damping |
| `maxD` | `SoftBody.update` | 35% of min(svgW,svgH) | Max displacement clamp |
| `imp` | `collisionStart` | `min(spd*0.28, 9)` | Collision impulse magnitude |
| Body size | `spawnLetters` | 47% of visual extent (hw/hh) | Collider vs visible size ratio |
