/**
 * What the fill-in form writes into a document's settings through its own
 * routes (PUT /api/studio-documents/:id/values and its neighbours), while the
 * editor's side panel holds a copy of the same settings for the things IT
 * changes (the contract, the design, the section choices).
 *
 * The settings are stored as one object, so the panel's next save would put
 * its older copy of these keys back over what the form (or a colleague, or
 * the assistant) saved since. `adoptFillState` takes the document's current
 * values of exactly these keys into the panel's copy, and leaves everything
 * else the panel holds alone.
 */

/** The settings keys the fill-in form owns. */
const FILL_STATE_KEYS = ['sampleValues', 'valueRequests', 'filledBy', 'fieldNotes', 'fillReview', 'templateFill'] as const;

type Settings = Record<string, unknown>;

/**
 * `mine` with the fill-in keys as they are in `current`. The same object comes
 * back when nothing differs, so a caller can tell that nothing changed.
 */
export function adoptFillState<T extends object>(mine: T, current: object | null | undefined): T {
    const fresh = (current || {}) as Settings;
    const held = mine as Settings;
    const same = FILL_STATE_KEYS.every((key) => JSON.stringify(held[key]) === JSON.stringify(fresh[key]));
    if (same) return mine;
    const next: Settings = { ...held };
    for (const key of FILL_STATE_KEYS) {
        if (fresh[key] === undefined) delete next[key];
        else next[key] = fresh[key];
    }
    return next as T;
}
