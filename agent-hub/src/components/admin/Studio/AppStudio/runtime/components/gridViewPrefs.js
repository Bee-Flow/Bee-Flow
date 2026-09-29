/**
 * Per-viewer display preferences for a data_grid.
 *
 * The author picks how a table looks; the person reading it every day has a
 * different problem. A nine-row order and a two-thousand-row register want
 * different row heights, and one long free-text column can make every row six
 * lines tall — at which point nothing on screen is scannable no matter how
 * carefully the columns were chosen.
 *
 * So: the author's props are the DEFAULT, and each viewer may override them
 * for that one grid. Nothing here touches the app definition — these are
 * reading preferences, not edits, and a viewer with no write access still gets
 * them.
 *
 * Scoped per node id rather than per app: two grids on one screen are usually
 * two different jobs (a nine-line order next to a filter list), and a setting
 * that fixed one while wrecking the other would be worse than none.
 */

const PREFIX = 'bf.gridview.';

/** The knobs a viewer may turn, and what counts as a legal value. */
export const VIEW_OPTIONS = {
    density: ['compact', 'comfortable', 'spacious'],
    look: ['default', 'striped', 'minimal', 'cards'],
    // How much vertical room one cell may take. 'off' is the old behaviour
    // (wrap forever); the numbers clamp to that many lines and give the row
    // back its uniform height — which is what makes a table scannable at all.
    clamp: ['1', '2', '3', 'off'],
};

export const VIEW_KEYS = Object.keys(VIEW_OPTIONS);

function isLegal(key, value) {
    return typeof value === 'string' && VIEW_OPTIONS[key] && VIEW_OPTIONS[key].includes(value);
}

/**
 * Read a viewer's overrides for one grid. Never throws: a private-mode browser,
 * a disabled storage quota or a hand-edited entry all degrade to "no override",
 * because a display preference must never be able to break the table itself.
 */
export function readViewPrefs(nodeId) {
    if (!nodeId || typeof localStorage === 'undefined') return {};
    let raw;
    try {
        raw = localStorage.getItem(PREFIX + nodeId);
    } catch {
        return {};
    }
    if (!raw) return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const key of VIEW_KEYS) {
        if (isLegal(key, parsed[key])) out[key] = parsed[key];
    }
    return out;
}

/**
 * Persist one viewer override. Writing a value equal to the author's default
 * still stores it — an explicit "I want comfortable" should survive the author
 * later changing the default, which is the whole point of pinning it.
 */
export function writeViewPrefs(nodeId, prefs) {
    if (!nodeId || typeof localStorage === 'undefined') return;
    const clean = {};
    for (const key of VIEW_KEYS) {
        if (isLegal(key, prefs && prefs[key])) clean[key] = prefs[key];
    }
    try {
        if (Object.keys(clean).length) localStorage.setItem(PREFIX + nodeId, JSON.stringify(clean));
        else localStorage.removeItem(PREFIX + nodeId);
    } catch {
        // Storage full or blocked — the session keeps the setting in React
        // state either way, so there is nothing useful to tell the reader.
    }
}

/** Forget this grid's overrides and fall back to whatever the author chose. */
export function clearViewPrefs(nodeId) {
    writeViewPrefs(nodeId, {});
}

/**
 * The effective view: author defaults with the viewer's legal overrides on top.
 * `authored` comes straight from node.props, so an author value this build does
 * not recognise falls back rather than rendering an unknown class.
 */
export function resolveView(authored, overrides) {
    const base = {
        density: isLegal('density', authored?.density) ? authored.density : 'comfortable',
        look: isLegal('look', authored?.look) ? authored.look : 'default',
        // Off by default: clamping is a change to what is VISIBLE, and a table
        // that silently hid the end of a value would be a worse default than
        // one that is merely tall. Viewers opt in; the menu is one click away.
        clamp: isLegal('clamp', authored?.clamp) ? authored.clamp : 'off',
    };
    return { ...base, ...(overrides || {}) };
}
