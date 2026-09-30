/**
 * A ```json-page definition: a tree of elements (`{ type, …, children }`) as
 * the web's PageRenderer reads it — layout (page, grid, row/columns,
 * section, card), content (heading, text/paragraph, image, list, divider),
 * interaction (button, tabs, accordion) and data (table, stat, badge,
 * chart). Any other element with `text` or `content` is shown as text.
 *
 * The tree stays the model's JSON; these helpers read one field at a time
 * and treat a wrong-typed field as absent, which is how the web's JSX
 * behaves with `element.title && …`.
 */

export type PageElement = Record<string, unknown> & { type?: unknown };

export function isElement(value: unknown): value is PageElement {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The page's root element, or null when the source is not a JSON object. */
export function readPage(source: string): PageElement | null {
    try {
        const parsed: unknown = JSON.parse(source);
        return isElement(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function field(el: PageElement, name: string): string {
    const value = el[name];
    if (typeof value === 'string') return value;
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

export function num(el: PageElement, name: string): number | null {
    const value = el[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function childrenOf(el: PageElement, name = 'children'): PageElement[] {
    const value = el[name];
    return Array.isArray(value) ? value.filter(isElement) : [];
}

export function listOf(el: PageElement, name: string): unknown[] {
    const value = el[name];
    return Array.isArray(value) ? value : [];
}

/** A table cell or column title: an object column shows its `label`. */
export function cellText(value: unknown): string {
    if (isElement(value)) return field(value, 'label');
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

/** A table row: an array as it is, an object by its values in order (the web's Object.values). */
export function rowCells(row: unknown): unknown[] {
    if (Array.isArray(row)) return row;
    return isElement(row) ? Object.values(row) : [];
}

/**
 * What a button's overlay shows, as the web builds it; '' where the web falls
 * back to its own words ("Info", "Action: click").
 */
export interface ButtonOverlay {
    title: string;
    content: string;
    action: string;
    url: string;
}

export function buttonOverlay(el: PageElement): ButtonOverlay {
    return {
        title: field(el, 'text') || field(el, 'label'),
        content: field(el, 'overlay') || field(el, 'description') || field(el, 'content'),
        action: field(el, 'action'),
        url: field(el, 'url') || field(el, 'href'),
    };
}

/** A chart's bars: labels and values, and the largest value they are drawn against. */
export function chartBars(el: PageElement): { bars: { label: string; value: number; color: string }[]; max: number } {
    const bars = listOf(el, 'data')
        .filter(isElement)
        .map((d) => ({ label: field(d, 'label'), value: num(d, 'value') ?? 0, color: field(d, 'color') }));
    const max = bars.reduce((m, b) => Math.max(m, b.value), 0);
    return { bars, max };
}
