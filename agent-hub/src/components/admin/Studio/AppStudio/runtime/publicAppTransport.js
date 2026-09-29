import { API_BASE } from '../../../../../utils/helpers';

/**
 * The transport a PUBLIC Studio-app page installs (see pages/apps/PublicAppPage
 * .jsx and utils/helpers.js `setPublicAppTransport`).
 *
 * The runtime components are the product's real ones, so they call
 * `/api/studio-apps/:appId/…` on mount and on every interaction. On a public
 * page there is no session behind those calls, so each one is rewritten to the
 * anonymous router — same suffix, different prefix — and signed with the
 * visitor bearer minted at page load:
 *
 *   /api/studio-apps/<appId>/data/query      →  /api/public-app/<token>/data/query
 *   /api/studio-apps/<appId>/actions/x/step  →  /api/public-app/<token>/actions/x/step
 *
 * ── FAIL CLOSED ─────────────────────────────────────────────────────
 * Only the suffixes the public router actually serves are forwarded. Anything
 * else — connectors, the AI chat bridge, whole-automation runs, dataset CRUD —
 * answers 404 here and never leaves the browser. A passthrough default would
 * mean one un-rewritten call reaching the authenticated API as an anonymous
 * request, which is precisely the failure this file exists to prevent.
 *
 * The `?draft=1` query is dropped rather than forwarded: there is no draft on
 * a public page, and the server would refuse it anyway.
 */

/** Build a Response the way fetch would, so callers need no special-casing. */
function json(body, status) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Strip API_BASE (absolute in dev, '' in prod) and split off the query. */
function splitUrl(url) {
    const raw = String(url || '');
    const withoutOrigin = raw.replace(/^https?:\/\/[^/]+/i, '');
    const [path, query = ''] = withoutOrigin.split('#')[0].split('?');
    return { path, query };
}

// The public router's surface, as anchored patterns over the suffix that
// follows /api/studio-apps/<appId>. Kept as an explicit list rather than a
// prefix test so adding a route to the runtime cannot silently widen what an
// anonymous visitor may call.
// An attachment id is a UUID (studioAppDataStore.addAttachment mints one with
// crypto.randomUUID). Anchoring on that shape rather than on `[^/]+` is what
// stops a SIBLING route being mistaken for an id: `/data/attachments/materialize`
// — the mail-attachment redemption endpoint, which spends the owner's provider
// quota — matched a looser pattern and would have been forwarded.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const ALLOWED_SUFFIXES = [
    /^\/data\/query$/,
    // Many reads in one request. It carries nothing /data/query and
    // /data/tables/:id/records cannot already carry — server-side it is the
    // same dataReadRunner behind the same anonymous role — so admitting it
    // widens no access, only the number of round trips.
    //
    // It has to be here. The runtime coalesces reads whenever the server
    // answers this route, and a fail-closed 404 would leave every public page
    // permanently on the slow path. (Not on a blank page: the batch client
    // treats any batch-level failure as "cannot batch" and replays each read
    // individually. That fallback is the safety net, not the plan.)
    /^\/data\/batch$/,
    /^\/data\/tables\/[^/]+\/records$/,
    /^\/data\/attachments$/,
    new RegExp(`^/data/attachments/${UUID}$`, 'i'),
    /^\/actions\/[^/]+\/step$/,
];

export function isPublicSuffix(suffix) {
    return ALLOWED_SUFFIXES.some((re) => re.test(suffix));
}

/**
 * @param {object} opts
 * @param {string} opts.token             the public page token from the URL
 * @param {() => string|null} opts.getVisitorToken  reads the CURRENT visitor
 *   token — a function, not a value, so a token refreshed after a 401 is picked
 *   up without reinstalling the transport.
 */
export function createPublicAppTransport({ token, getVisitorToken }) {
    return async (url, options = {}) => {
        const { path, query } = splitUrl(url);

        const match = path.match(/^\/api\/studio-apps\/[^/]+(\/.*)?$/);
        if (!match) {
            return json({ error: 'Not available on a public page' }, 404);
        }
        const suffix = match[1] || '';
        if (!isPublicSuffix(suffix)) {
            return json({ error: 'Not available on a public page' }, 404);
        }

        // Keep the query (list filters, sort, cursor) but never `draft`.
        const params = new URLSearchParams(query);
        params.delete('draft');
        const qs = params.toString();

        const visitor = getVisitorToken();
        const headers = { ...(options.headers || {}) };
        if (visitor) headers.Authorization = `Bearer ${visitor}`;

        return fetch(
            `${API_BASE}/api/public-app/${encodeURIComponent(token)}${suffix}${qs ? `?${qs}` : ''}`,
            {
                ...options,
                headers,
                // No cookie is wanted or useful here: the bearer IS the identity,
                // and sending credentials would make this a cross-context request
                // for no benefit.
                credentials: 'omit',
                cache: 'no-store',
            },
        );
    };
}
