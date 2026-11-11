/**
 * The text fields of a captured template (title, description, category, icon, tags),
 * trimmed and capped. Split out of templateCapture.js.
 */

/** Trim + cap a string field, returning null when nothing is left. */
export function cleanStr(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

/** Tag list: strings only, deduped, capped. */
export function cleanTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const tag of value) {
        const clean = cleanStr(tag, 40);
        if (clean && !out.includes(clean)) out.push(clean);
        if (out.length >= 8) break;
    }
    return out;
}
