/**
 * Numbers as people type them. Many of Bee Flow's users are Dutch and write a
 * decimal comma ("1,5"), while JavaScript and the server read only a dot.
 * Both helpers read either separator and nothing cleverer: a comma and a dot
 * together ("1.000,5") is a thousands separator in one locale and a typo in
 * another, so it is left alone rather than guessed at.
 */

/** Digits with at most one "." or ",", and an optional sign. "1," and ",5" count; "-" and "1.2.3" do not. */
const DECIMAL_RE = /^[+-]?(?:\d+[.,]?\d*|[.,]\d+)$/;

/** The text with its one decimal comma read as a dot ("1,5" → "1.5"). Any other text is returned as it came. */
export function normaliseDecimal(text: string): string {
    return /^[^.,]*,[^.,]*$/.test(text) ? text.replace(',', '.') : text;
}

/** The number typed, with a dot or a comma; null while the text is blank or not (yet) a number. */
export function parseDecimal(text: string): number | null {
    const trimmed = text.trim();
    return DECIMAL_RE.test(trimmed) ? Number(trimmed.replace(',', '.')) : null;
}
