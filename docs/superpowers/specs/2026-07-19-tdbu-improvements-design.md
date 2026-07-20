# TDBU (Top-Down Bottom-Up) Improvements — Design

**Date:** 2026-07-19
**Status:** Approved (Approach 2: simplified geometry + hardening)

## Background

TDBU support renders a dual-rail blind: the main cover entity drives the bottom
rail, `tdbu_entity` drives the top rail, and slat fabric fills the gap. The
initial port works but has correctness gaps, a convoluted rendering model, and
minimal usability affordances. This design simplifies the geometry to a single
source of truth and hardens behavior. TDBU remains vertical-only
(`closing_direction: down`); real TDBU hardware is vertical.

## Goals

1. Rails may touch but never cross — on screen and in commands sent to devices.
2. Dragging works when rails are close together (no picker stacking conflict).
3. Geometry is derived from two well-named numbers, not three coupled CSS
   mechanisms.
4. The top rail is visibly grabbable, and an optional slider offers an easier
   control surface.
5. Invalid configurations warn instead of rendering garbage.

## Non-goals

- Rotated/horizontal TDBU rendering (warn + fall back to plain shutter).
- Buttons for the tdbu entity.
- Tilt-specific TDBU behavior changes (tilt slats render inside the clip as
  before).

## Design

### Geometry model (single source of truth)

`EnhancedShutter.render()` computes:

- `this.topRailPx` — top rail screen position. From
  `defScreenPositionFromTdbuPosition(position)` where `position` is
  `react_TdbuPosition` during `user-drag-tdbu`, else the device position.
  Clamped to `<= actualScreenPosition` (the bottom rail; rails touch, never
  cross).
- `this.actualTdbuPosition` — top rail percent for position text, symmetric
  with `actualShutterPosition`. Set from `react_TdbuPosition` during drag, else
  from the device.

`htmlShutter.js` derives all TDBU CSS vars from `topRailPx` and
`actualScreenPosition`:
`--esc-tdbu-clip-top`, `--esc-tdbu-clip-height`, `--esc-tdbu-rail-bottom-top`,
`--esc-transform-picker-tdbu`. `--esc-transform-slide` returns to its single
meaning (`transformSlide(actualScreenPosition)`) for all shutters — the
gap-size hijack is removed.

The slide inside the TDBU clip container becomes static CSS
(`top:0; left:0; height:100%; transform:none`), and the slats fill 100% of the
clip. The clip container alone defines the fabric rectangle.

### Drag behavior

- `mouseMoveTdbuPicker` clamps to `[coverOpenedPx, min(coverClosedPx,
  actualScreenPosition)]`.
- The main picker's screen-position clamp gains a lower bound of `topRailPx`
  when `hasTdbu()`.
- `sendTdbuShutterPosition` clamps the outgoing percent so a crossing command
  can never be sent, regardless of caller.
- Nearest-rail routing: the two picker mousedown handlers become routers over
  shared `startOpenCloseDrag(event)` / `startTdbuDrag(event)` helpers. A
  `nearestTdbuRail(event)` helper compares the press point's vertical offset
  within the selector rect against `topRailPx` and `actualScreenPosition`
  (valid because TDBU is vertical-only) and routes the drag to the closer rail.

### Affordances

- Each rail div (`…-rail-top`, `…-rail-bottom`) contains a decorative
  grab-handle pill (`pointer-events: none`, centered, theme-colored). Rendered
  only for TDBU shutters; non-TDBU rendering is unchanged.
- The top rail's edge image is flipped with `scaleY(-1)` so it reads as a top
  rail instead of an upside-down bottom bar.
- Optional `show_tdbu_slider: true` renders a second range slider next to the
  open/close slider (new `htmlBlockTdbuSlider`, following
  `htmlBlockOpenCloseSlider`). Slider drag reuses the `user-drag-tdbu` action
  and sends through the same clamped send path.

### Guards and fixes

- `tdbu_entity` combined with `closing_direction != down` adds a
  `messageManager` warning and strips the tdbu entity from that shutter's
  config (falls back to plain rendering).
- Restore `picker_overlap_px` config wiring in `shutterCfg` (upstream
  regression: the constant is hardcoded).

### Docs

README gains a TDBU section: concept, `tdbu_entity`,
`tdbu_invert_percentage`, `show_tdbu_slider`, position semantics
(0 = top rail at top / fabric covers from bottom rail up; 100 = retracted),
and a YAML example.

## Testing

Extend the jsdom smoke test (scratchpad `tdbu-smoke-test.mjs`):

- Crossing clamp: dragging the top rail far past the bottom rail sends a
  position `<=` the bottom rail's equivalent; clip height never negative.
- Nearest-rail routing: a press on the overlap zone nearer the bottom rail
  starts a main-entity drag.
- Slider: with `show_tdbu_slider`, the slider renders and its drag sends
  `set_cover_position` to the tdbu entity.
- Warning: `closing_direction: left` + `tdbu_entity` renders no TDBU nodes and
  registers a card message.
- Handles and flipped top rail render.
- All pre-existing checks pass unchanged (regression).
