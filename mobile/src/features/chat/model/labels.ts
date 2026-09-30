/**
 * Parse the `labels_json` column, which is a JSON string on the wire.
 * Returns an empty array for null, malformed JSON or a non-array — a bad
 * label blob must not take a conversation row out of the list.
 */
export function parseLabels(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

/** The applied label ids with one toggled on or off. */
export function toggleLabel(applied: readonly string[], labelId: string): string[] {
    return applied.includes(labelId) ? applied.filter((v) => v !== labelId) : [...applied, labelId];
}
