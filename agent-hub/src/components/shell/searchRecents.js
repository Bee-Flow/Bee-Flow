import scopedStorage from '../../utils/scopedStorage';

/**
 * Recent search terms for the search overlay.
 *
 * Per-user data (they show what someone was looking for), so they live in
 * user-scoped storage rather than on a device key a colleague on the same
 * browser would inherit. The pre-scoping bare `beeflow.search.recent` key is
 * moved into the user scope once by the storageMigrations pass.
 *
 * Shape is allow-listed: an array of strings. Corrupt JSON, a stored object
 * or mixed entries degrade to "no recents" — the overlay renders either way.
 */

const RECENT_KEY = 'beeflow.search.recent';
const MAX_RECENT = 5;

export const loadRecent = () => {
    const stored = scopedStorage.getJSON(RECENT_KEY, []);
    return Array.isArray(stored) ? stored.filter(t => typeof t === 'string') : [];
};

export const saveRecent = (term) => {
    const next = [term, ...loadRecent().filter(t => t !== term)].slice(0, MAX_RECENT);
    scopedStorage.setJSON(RECENT_KEY, next);
    return next;
};
