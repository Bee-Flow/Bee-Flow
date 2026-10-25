// Legacy per-message effort override, written by the thinking-effort dropdown
// this control replaces. `useChatEngine` still reads it at send time and, when
// present, it wins over the tier's own effort — so a value left behind by the
// old dropdown would silently pin Deep Thinking to "Low" forever. Clear it once.
export const LEGACY_EFFORT_KEY = 'reasoningEffort';

// ── Gauge ────────────────────────────────────────────────────────────────
// A speedometer, drawn from the same index the slider uses, so the collapsed
// trigger already tells you how deep the next answer will go. A per-tier glyph
// (bolt / brain / bulb) can't do that: it names the tier but says nothing about
// where the tier sits on the scale.
//
// 270° of arc with the gap at the bottom — the conventional gauge reading, and
// the shape leaves room for the needle to swing without clipping.
export const GAUGE_START_DEG = -135;

export const GAUGE_SWEEP_DEG = 270;

// The needle sweeps rather than jumps — a gauge that teleports reads as a state
// change, one that swings reads as a measurement. Slight overshoot on the
// needle (the `1.5` in the curve) is what makes it feel like a physical dial;
// the arc uses a plain ease-out because a fill that bounces looks broken.
const GAUGE_SWEEP_MS = 520;

export const NEEDLE_EASING = `transform ${GAUGE_SWEEP_MS}ms cubic-bezier(0.34, 1.5, 0.64, 1)`;

export const ARC_EASING = `stroke-dashoffset ${GAUGE_SWEEP_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;

export const GAUGE_RADIUS = 8.5;

// Length of the 270° arc, so the fill can be animated with stroke-dashoffset.
// `d` is not a transitionable property, so redrawing the path each time — the
// first attempt — could never animate no matter what duration it was given.
export const GAUGE_ARC_LEN = (GAUGE_SWEEP_DEG / 360) * 2 * Math.PI * GAUGE_RADIUS;

// Track geometry. THUMB_PAD is the inset every stop centre must respect so the
// 28px thumb never clips the 40px track: 6px of breathing room + its own 14px
// radius. Dots AND labels are positioned off the SAME expression, which is what
// keeps them in one vertical line — the first attempt used flex `space-between`
// for the dots and `flex: 1` cells for the labels, and the two disagreed as
// soon as the active dot grew from 10px to 28px and reflowed the row.
export const THUMB_PAD = 20;

export const THUMB_RADIUS = 14;

// Depth reads as INTENSITY, not only as bar length, and the ramp is visible
// within a single view: the fill is a gradient that starts soft at the shallow
// end and deepens toward the thumb. Its dark end also tracks travel, so Deep
// Thinking's right edge is the deepest ink while Fast's only reaches mid — you
// see the gradient in one screen AND the difference between the levels.
//
// The ramp is mixed from the theme's own INK (`--text-primary`) into its own
// track surface (`--bg-tertiary`), never from `--accent-primary`. The accent
// is a free-form colour an admin picks in Appearance and it defaults to a cool
// grey (`#9ca3af`), which painted a grey bar across the warm Paper/Sepia
// presets — foreign to every surface around it. Ink-over-surface is warm on a
// warm theme and cool on a cool one by construction, so the bar belongs to
// whatever preset is selected.
export const FILL_START_PCT = 10;   // % ink at the very left of the bar

export const FILL_MIN_END_PCT = 20; // % ink at the thumb when barely moved

export const FILL_MAX_END_PCT = 44; // % ink at the thumb at the deepest level
