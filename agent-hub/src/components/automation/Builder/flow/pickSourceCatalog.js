/**
 * The apps an "Pick from an app" question can offer — fetched once, shared.
 *
 * The server's registry (server/automation/formPickSources.js) is the only
 * definition of what may be picked and of what a picked record's `data` holds.
 * The builder needs the same answer in two unrelated places: the field editor's
 * dropdown, and the mapping panel's sample of the answer's shape. Mirroring the
 * list here would put a second copy one refactor away from promising a key the
 * runtime never writes — a binding an author drags out of the panel that then
 * resolves to undefined forever, with nothing on screen to say why.
 *
 * So both read THIS module, and this module reads the server.
 *
 * Module-level, because the editor is mounted and unmounted every time a node
 * is selected while the answer does not change within a session. The sync
 * accessor is for callers that cannot await (the mapping panel's sample
 * builders are pure functions called during render): before the first load it
 * answers `[]`, and a sample simply carries fewer rows until the panel that
 * does the fetching has mounted. Empty is the honest degradation — a guessed
 * shape is not.
 */

let cache = null;
let inFlight = null;

/** Every source, or `[]` until the first load lands. Never throws. */
export function pickSourcesSync() {
    return cache || [];
}

/** One source by the id a field declares, or null. */
export function pickSourceById(id) {
    return pickSourcesSync().find(s => s.id === id) || null;
}

/**
 * Load the registry once. Concurrent callers share the flight; a FAILED load
 * leaves the cache null so the next caller retries rather than being stuck
 * with an empty dropdown for the rest of the session.
 */
export function loadPickSources() {
    if (cache) return Promise.resolve(cache);
    // The api client is imported HERE, not at module scope: this module is
    // reached from the mapping panel's pure path finders, which several suites
    // load in a plain node environment. api/client resolves its base URL from
    // `window` the moment it is imported, so a top-level import would make
    // every one of those suites fail on a browser global they never asked for.
    inFlight = inFlight || import('../../../../api/client')
        .then(({ default: apiClient }) => apiClient.get('/api/automation/catalog/form-pick-sources'))
        .then((d) => { cache = Array.isArray(d?.sources) ? d.sources : []; return cache; })
        .catch(() => { inFlight = null; return []; });
    return inFlight;
}

/** Test seam: drop what has been loaded. */
export function __resetPickSources() {
    cache = null;
    inFlight = null;
}
