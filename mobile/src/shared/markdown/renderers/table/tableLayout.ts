/**
 * Column widths for a Markdown table.
 *
 * A browser sizes table columns from their content and wraps what does not
 * fit; React Native has no table layout, so the widths are chosen here from
 * each column's text: wide enough for its longest line up to a cap (past
 * which the cell wraps), never narrower than a readable minimum. A table
 * narrower than the message is stretched to fill it, as the web's
 * `width: 100%` does; a wider one scrolls sideways inside its wrapper, as the
 * web's `.table-wrapper` does.
 */

/** The table text's average character width at 13px, with a margin for bold headers. */
const CHAR_WIDTH = 7.4;
/** The cell's horizontal padding (0.6rem each side) and its border. */
const CELL_CHROME = 21;
export const MIN_COLUMN = 64;
export const MAX_COLUMN = 240;

function textWidth(text: string): number {
    const longestLine = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
    return longestLine * CHAR_WIDTH + CELL_CHROME;
}

/** The natural width of each column, from its header and its cells' text. */
export function columnWidths(header: readonly string[], rows: readonly (readonly string[])[]): number[] {
    return header.map((title, col) => {
        const widest = rows.reduce((max, row) => Math.max(max, textWidth(row[col] ?? '')), textWidth(title));
        return Math.round(Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, widest)));
    });
}

/** Stretch the columns to `available` when they fall short of it, in proportion. */
export function fillWidths(widths: readonly number[], available: number): number[] {
    const total = widths.reduce((sum, w) => sum + w, 0);
    if (available <= 0 || total <= 0 || total >= available) return [...widths];
    const scale = available / total;
    const out = widths.map((w) => Math.floor(w * scale));
    // Give the rounding remainder to the last column, so the edges meet.
    out[out.length - 1] = (out[out.length - 1] ?? 0) + available - out.reduce((sum, w) => sum + w, 0);
    return out;
}
