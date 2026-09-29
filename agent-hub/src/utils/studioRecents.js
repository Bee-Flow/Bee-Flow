import scopedStorage from './scopedStorage';

/**
 * Which Studio items this user was last working on, per section.
 *
 * The Studio flyout lists eight sections, and each one is only a category: the
 * agent or routine you actually had open is still a click and a hunt away. The
 * second-level panel answers "what was I working on here", and that ordering
 * has two halves.
 *
 * The first half — "the ones YOU touched" — does not exist on the server. No
 * table records who opened what; `updated_at` records that SOMEONE saved, which
 * on a shared org is a different question. So opens are recorded here, on the
 * device, in per-user scoped storage. This is the same argument (and the same
 * shape) as `formRecents.js`, kept separate because that one deliberately falls
 * back to PUBLICATION date for an org-shared artefact, which is not what "last
 * edited" means.
 *
 * The second half is the fallback: an item you have never opened on this device
 * is ranked by its own `updatedAt`, which every Studio list endpoint returns.
 * So a fresh browser still shows something useful, and gets more personal as
 * you use it.
 *
 * Note what is recorded: OPENED IN ITS EDITOR, not "saved". In Studio, opening
 * an item is the editing surface, so the two coincide closely enough to be
 * honest — but a true edited-at signal would need a server-side activity table.
 */

// One key for all sections: `{ [section]: { [itemId]: epochMs } }`. A single
// key keeps the whole record readable and clearable in one go, while the cap
// below stays per section so a busy Automations day cannot evict your agents.
const KEY = 'studioRecents';
// More than the five the panel shows, so dropping off the list is not the same
// as being forgotten — reopening an older item should restore its place.
const REMEMBERED = 12;

/** The whole record, `{ [section]: { [id]: epochMs } }`, never throwing. */
function readAll() {
    try {
        const parsed = JSON.parse(scopedStorage.getItem(KEY) || 'null');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
    } catch {
        return {};
    }
}

/** `{ [itemId]: epochMs }` for one section, never throwing on absent or corrupt storage. */
export function readStudioRecents(section) {
    if (!section) return {};
    const bucket = readAll()[section];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return {};
    // Drop anything that is not a usable timestamp rather than letting it sort
    // unpredictably later.
    return Object.fromEntries(
        Object.entries(bucket).filter(([, at]) => Number.isFinite(at) && at > 0),
    );
}

/** Stamp a Studio item as opened by this user, now. */
export function rememberStudioItem(section, id, now = Date.now()) {
    if (!section || !id) return;
    const all = readAll();
    const next = { ...readStudioRecents(section), [id]: now };
    const trimmed = Object.fromEntries(
        Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, REMEMBERED),
    );
    try {
        scopedStorage.setItem(KEY, JSON.stringify({ ...all, [section]: trimmed }));
    } catch {
        // A full quota is not worth failing a navigation over.
    }
}

/**
 * The `limit` items to offer for a section, most relevant first: the ones this
 * user opened (most recent first), then the rest by their own last-updated.
 */
export function rankStudioItems(items, section, limit = 5, recents = readStudioRecents(section)) {
    const list = Array.isArray(items) ? items : [];
    const openedAt = (item) => recents[item?.id] || 0;
    const updatedAt = (item) => {
        const t = new Date(item?.updatedAt || 0).getTime();
        return Number.isFinite(t) ? t : 0;
    };
    return [...list]
        .filter((item) => item && item.id)
        .sort((a, b) => (openedAt(b) - openedAt(a)) || (updatedAt(b) - updatedAt(a)))
        .slice(0, Math.max(0, limit));
}
