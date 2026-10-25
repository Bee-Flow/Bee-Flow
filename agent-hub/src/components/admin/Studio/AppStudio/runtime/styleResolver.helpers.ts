import type { StyleKnobs, StyledNode } from './styleResolver.types';

/**
 * True when this node asked to take the leftover space.
 *
 * An explicit heightMode ('px'/'pct'/'vh') overrides the preset entirely, so a
 * node that says 400px is NOT filling even if a stale `height: 'fill'` is still
 * sitting next to it — without this guard the component would add its own
 * h-full/.app-fill treatment on top of a fixed height and the two would fight.
 * For any definition without the advanced knobs this is exactly what it was.
 */
export const isFill = (node?: StyledNode | null): boolean => !resolveHeightCss(node?.style) && node?.style?.height === 'fill';

/**
 * gridTemplateRows for a container/tab/card that fills its height.
 *
 * A flat `minmax(0, 1fr)` declares ONE row, so it hands the whole height to
 * whatever lands in row 1 and pushes every later row past the bottom edge —
 * a summary above a conversation stretched to fill the panel while the
 * conversation itself was shoved off-screen. Only single-row layouts were ever
 * right.
 *
 * So: walk the 12-column flow, and give the slack to the row holding the child
 * that ASKED to fill (the last such row; the first row otherwise falls back to
 * the last row, which is where growable content nearly always sits). Every
 * other row stays at content height. One row still resolves to the old value
 * verbatim, so existing definitions render byte-identically.
 */
export function fillRowTemplate(node?: StyledNode | null): string {
    const kids = Array.isArray(node?.children) ? node.children : [];
    const rows: StyledNode[][] = [];
    let used = 0;
    for (const kid of kids) {
        const raw = Number(kid?.style?.span);
        const span = Math.min(12, Math.max(1, Number.isFinite(raw) ? raw : 12));
        if (rows.length === 0 || used + span > 12) { rows.push([kid]); used = span; }
        else { rows[rows.length - 1].push(kid); used += span; }
    }
    if (rows.length <= 1) return 'minmax(0, 1fr)';
    let grow = rows.findIndex((row) => row.some((kid) => isFill(kid)));
    if (grow < 0) grow = rows.length - 1;
    return rows.map((_, i) => (i === grow ? 'minmax(0, 1fr)' : 'auto')).join(' ');
}

/** Whole-number knob value, or null (mirrors what canonicalize already stored). */
export const sizeNumber = (v?: number | null): number | null => (Number.isFinite(v) ? Math.round(Number(v)) : null);

/**
 * heightMode/heightValue → a CSS height, or null when the `height` preset owns it.
 *
 * 'pct' is emitted, not swallowed: the server rejects a percentage height whose
 * parent has no definite height (validate.js style.height_pct_indefinite), so
 * anything that reaches here has something real to measure against.
 */
export function resolveHeightCss(s?: StyleKnobs | null): string | null {
    const mode = s && s.heightMode;
    if (mode !== 'px' && mode !== 'pct' && mode !== 'vh') return null;
    const n = sizeNumber(s?.heightValue);
    if (n === null) return null;
    if (mode === 'pct') return `${n}%`;
    return `${n}${mode}`;
}
