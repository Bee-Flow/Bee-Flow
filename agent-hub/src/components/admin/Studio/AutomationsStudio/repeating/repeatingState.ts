import scopedStorage from '../../../../../utils/scopedStorage';

/**
 * Per-viewer conveniences for "Find repeating work", in scoped (per-user)
 * storage: which source groups the viewer left switched on, and whether the
 * focus field was open. Nothing here must survive: scan results, "not now"
 * and "not repetitive" live on the server, keyed by the pattern's signature.
 *
 * Storage can be missing or throw (private window, cleared site data, no
 * active user), so every read falls back to the defaults and every write is
 * best-effort.
 */

const PREFS_KEY = 'automationsRepeatingPrefs';

export interface RepeatingPrefs {
    /** Group ids the viewer switched OFF. Stored as exclusions so a newly connected group starts on. */
    excludedSources: string[];
    focusOpen: boolean;
}

const DEFAULTS: RepeatingPrefs = Object.freeze({ excludedSources: [], focusOpen: false });

export function readRepeatingPrefs(): RepeatingPrefs {
    try {
        const raw = scopedStorage.getJSON<Partial<RepeatingPrefs>>(PREFS_KEY, null);
        if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
        return {
            excludedSources: Array.isArray(raw.excludedSources)
                ? raw.excludedSources.filter((x): x is string => typeof x === 'string' && !!x)
                : [],
            focusOpen: raw.focusOpen === true,
        };
    } catch {
        return { ...DEFAULTS };
    }
}

/** Store the prefs as they are in memory (never re-read: storage may be the part that is missing). */
export function writeRepeatingPrefs(prefs: RepeatingPrefs): RepeatingPrefs {
    try {
        scopedStorage.setJSON(PREFS_KEY, prefs);
    } catch { /* best-effort */ }
    return prefs;
}
