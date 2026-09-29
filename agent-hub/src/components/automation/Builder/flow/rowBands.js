/**
 * rowBands — which nodes share a ROW on a wrapped canvas, from nothing but
 * their positions (builder redesign, artboard 1a: "Row 1 · steps 1–5").
 *
 * Pure, React-free, and deliberately NOT persisted. `arrange.js` throws its
 * row assignment away once positions are written, and storing `step.row` on
 * the definition would be a schema change the validator does not expect and
 * every version diff would carry. Deriving rows from `y` works on a
 * hand-dragged canvas as well as an arranged one, and it means a card the
 * user pulls down into the gutter simply joins the row below.
 *
 * Returns `[]` for a canvas with a single band, so nothing draws a gutter
 * label on a flow that never wrapped — self-limiting by construction.
 */

/** Vertical gap between two wrapped rows (design: 270; was 220). Generous on
 *  purpose: the return edge runs the full width of the row back to the next
 *  row's first card, and it travels through this band. */
export const ROW_GAP = 270;

/** How far above a row its gutter label sits. */
export const ROW_LABEL_OFFSET = 28;

/**
 * @param {Array<{id:string, x:number, y:number, width?:number, height?:number, number?:number}>} items
 * @param {{gap?:number}} opts
 * @returns {Array<{index:number, top:number, bottom:number, left:number, right:number, ids:string[], first:number|null, last:number|null}>}
 */
export function rowBands(items, { gap = ROW_GAP } = {}) {
    const valid = (items || []).filter(it => it && it.id != null
        && Number.isFinite(it.x) && Number.isFinite(it.y));
    const sorted = valid.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const bands = [];
    let cur = null;
    // Two ranks stacked inside one row (the arms of a condition) sit a card
    // height plus one nodesep apart; the next row starts a whole ROW_GAP
    // below. Half a ROW_GAP therefore separates "same row" from "next row"
    // with room on both sides.
    const threshold = gap / 2;
    for (const it of sorted) {
        const w = Number.isFinite(it.width) ? it.width : 240;
        const h = Number.isFinite(it.height) ? it.height : 72;
        const bottom = it.y + h;
        if (!cur || it.y > cur.bottom + threshold) {
            cur = { index: bands.length + 1, top: it.y, bottom, left: it.x, right: it.x + w, ids: [], first: null, last: null };
            bands.push(cur);
        }
        cur.ids.push(it.id);
        cur.top = Math.min(cur.top, it.y);
        cur.bottom = Math.max(cur.bottom, bottom);
        cur.left = Math.min(cur.left, it.x);
        cur.right = Math.max(cur.right, it.x + w);
        if (typeof it.number === 'number' && Number.isFinite(it.number)) {
            cur.first = cur.first == null ? it.number : Math.min(cur.first, it.number);
            cur.last = cur.last == null ? it.number : Math.max(cur.last, it.number);
        }
    }
    return bands.length > 1 ? bands : [];
}

/** `Map<id, rowIndex>` from a band list — empty when there is one row. */
export function rowIndexById(bands) {
    const m = new Map();
    for (const b of bands || []) for (const id of b.ids) m.set(id, b.index);
    return m;
}
