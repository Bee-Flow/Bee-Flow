import scopedStorage from './scopedStorage';

/**
 * Which published forms this user reaches for.
 *
 * The sidebar shows at most a handful of forms, and an organisation can
 * publish many more than that, so it has to choose. The honest ordering is
 * "the ones YOU use": a form you opened last week is far more likely to be the
 * one you want than whichever form happens to be newest.
 *
 * That signal does not exist on the server. `submissions` / `lastSeenAt` count
 * what anonymous VISITORS did, which is a different thing — a form nobody in
 * the org has ever opened can be the busiest on the install. So opens are
 * recorded here, on the device, in per-user scoped storage.
 *
 * When there is no such history the fallback is publication date, which is the
 * only ordering left that means anything.
 */

const KEY = 'formRecents';
// A few more than the sidebar shows, so dropping off the list is not the same
// as being forgotten — reopening an older form should restore its place.
const REMEMBERED = 12;

/** `{ [formId]: epochMs }`, never throwing on absent or corrupt storage. */
export function readFormRecents() {
    try {
        const parsed = JSON.parse(scopedStorage.getItem(KEY) || 'null');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // Drop anything that is not a usable timestamp rather than letting it
        // sort unpredictably later.
        return Object.fromEntries(
            Object.entries(parsed).filter(([, at]) => Number.isFinite(at) && at > 0),
        );
    } catch {
        return {};
    }
}

/** Stamp a form as opened by this user, now. */
export function rememberFormOpened(id, now = Date.now()) {
    if (!id) return;
    const next = { ...readFormRecents(), [id]: now };
    const trimmed = Object.fromEntries(
        Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, REMEMBERED),
    );
    try {
        scopedStorage.setItem(KEY, JSON.stringify(trimmed));
    } catch {
        // A full quota is not worth failing a navigation over.
    }
}

/**
 * The `limit` forms to offer, most relevant first: the ones this user has
 * opened (most recent first), then the rest newest-published first.
 */
export function recentForms(forms, limit = 5, recents = readFormRecents()) {
    const list = Array.isArray(forms) ? forms : [];
    const openedAt = (f) => recents[f?.id] || 0;
    const publishedAt = (f) => {
        const t = new Date(f?.createdAt || 0).getTime();
        return Number.isFinite(t) ? t : 0;
    };
    return [...list]
        .sort((a, b) => (openedAt(b) - openedAt(a)) || (publishedAt(b) - publishedAt(a)))
        .slice(0, Math.max(0, limit));
}
