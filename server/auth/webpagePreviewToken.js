// @typecheck
/**
 * Webpage Preview Tokens — short-lived HMAC-signed bearer tokens that let
 * the sandboxed preview iframe call back to the host API across origins.
 *
 * Why a token, not the session cookie:
 *   The preview iframe runs with `sandbox="allow-scripts"` (no
 *   `allow-same-origin`), giving it an opaque origin that can't carry the
 *   user's session cookie. Anything the iframe wants from the API has to be
 *   cross-origin and authenticated by some other means.
 *
 * Token shape:  base64url(payload) "." base64url(hmac_sha256(secret, payload))
 *               where payload = base64url(JSON({ u: userId, w: webpageId, e: expiresAtMs }))
 *
 * Secret precedence: WEBPAGE_PREVIEW_TOKEN_SECRET env var, then a
 * configStore-persisted secret bootstrapped at startup (ensureDurableSecret —
 * same pattern as server/auth/certificateToken.js's LEARNING_CERT_SECRET),
 * with a per-process random secret as the last-resort fallback in production
 * (only reachable if the startup bootstrap hasn't run yet or failed) and an
 * on-disk dev cache otherwise.
 *
 * Why configStore and not a hard "operator must set this env var" failure:
 * on a multi-replica deploy each pod would otherwise mint tokens with its own
 * random secret, so a token signed by pod A gets rejected as invalid by pod
 * B, and every restart invalidates all outstanding tokens — but the fix is a
 * value ALL replicas can agree on without operator action, which is exactly
 * what setSecretIfAbsent's ON CONFLICT DO NOTHING gives us (first pod to boot
 * wins, every other pod reads the same row back). ensureDurableSecret() is
 * called once at server startup, non-fatally, same as certificateToken's.
 */

const { createSigningSecret } = require('./lib/signingSecret');
const signedPayload = require('./lib/signedPayload');

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// The env → configStore → prod-random → dev-disk ladder lives in lib/
// signingSecret.js, shared with certificateToken and publicShareToken. The
// production fallback is loud but non-fatal on purpose: a request landing
// during the startup window must not 500, it just mints a token the other
// replicas will reject until ensureDurableSecret() finishes.
const secret = createSigningSecret({
    envVars: ['WEBPAGE_PREVIEW_TOKEN_SECRET'],
    devCacheName: 'beeflow-webpage-preview-secret',
    configKey: 'webpage_preview_token_secret',
    label: 'WebpagePreviewToken',
    productionWarning:
        'WEBPAGE_PREVIEW_TOKEN_SECRET not set and the startup bootstrap has not run — preview ' +
        'tokens minted by this replica will be rejected by others and invalidated on restart. ' +
        'Set WEBPAGE_PREVIEW_TOKEN_SECRET (32+ chars) to fix permanently, or wait for ' +
        'ensureDurableSecret() to finish bootstrapping.',
});

/**
 * Issue a token bound to (userId, webpageId) for `ttlMs` milliseconds.
 *
 * `viewerUserId` is de INGELOGDE BEZOEKER, en is iets anders dan `userId`.
 * `userId` is de EIGENAAR van de pagina: de per-pagina SQLite-database en de
 * ai/automations/integrations-bruggen draaien bewust acts-as-author, zodat
 * elke toegelaten lezer dezelfde paginadatabase ziet. Dat mag NOOIT gelden
 * voor een datatable: die heeft zijn eigen graden per persoon, dus de
 * tabelroutes lezen `viewerUserId` en niets anders.
 *
 * De claim is optioneel op de wire (een token van vóór W3 heeft hem niet),
 * maar het ontbreken ervan VERSMALT: verifyPreviewToken geeft dan
 * `viewerUserId: null` en de tabelroutes weigeren. Nooit terugvallen op
 * `userId` — dat zou elke lezer de tabelrechten van de auteur geven.
 */
function issuePreviewToken({ userId, webpageId, viewerUserId = null, ttlMs = DEFAULT_TTL_MS }) {
    if (!userId || !webpageId) throw new Error('userId and webpageId are required');
    const expiresAt = Date.now() + Math.max(60_000, ttlMs);
    const payload = { u: userId, w: webpageId, e: expiresAt };
    // Getrimd: een claim van alleen spaties is geen bezoeker, en zou anders als
    // gebruikers-id de scope-opzoeking in gaan.
    const viewer = typeof viewerUserId === 'string' ? viewerUserId.trim() : '';
    if (viewer) payload.v = viewer;
    return {
        token: signedPayload.sign(secret.get(), payload),
        expiresAt,
    };
}

/**
 * Verify a token. Returns `{ userId, webpageId, expiresAt }` on success or
 * `null` on any failure (bad shape, bad signature, expired). Use `null`
 * uniformly so the route just does `if (!claims) return 401`.
 */
function verifyPreviewToken(token) {
    const payload = signedPayload.verify(secret.get(), token);
    if (!payload) return null;
    if (!payload.u || !payload.w || typeof payload.e !== 'number') return null;
    if (payload.e < Date.now()) return null;
    return {
        userId: payload.u,
        webpageId: payload.w,
        // Alleen een echte, niet-lege string telt. Alles anders (ontbrekend,
        // een getal, een object) wordt null en laat de tabelroutes weigeren.
        viewerUserId: typeof payload.v === 'string' && payload.v.trim() ? payload.v.trim() : null,
        expiresAt: payload.e,
    };
}

/**
 * Express middleware that pulls a Bearer token off the Authorization header,
 * verifies it, and stashes `{ userId, webpageId, viewerUserId }` on
 * `req.previewClaims`.
 * Also enforces that the token's webpageId matches the URL's `:id` so a
 * token issued for one webpage can't be used to query another.
 */
function requirePreviewToken(req, res, next) {
    const auth = req.headers['authorization'] || req.headers['Authorization'];
    if (!auth || typeof auth !== 'string') {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Authorization must be Bearer <token>' });

    const claims = verifyPreviewToken(m[1].trim());
    if (!claims) return res.status(401).json({ error: 'Invalid or expired preview token' });

    const urlWebpageId = req.params?.id;
    if (urlWebpageId && claims.webpageId !== urlWebpageId) {
        return res.status(403).json({ error: 'Preview token does not match this webpage' });
    }
    req.previewClaims = claims;
    next();
}

// True once the signing secret is guaranteed stable across restarts/replicas
// (env var, configStore-bootstrapped, or a persisted dev cache file).
const hasDurableSecret = secret.hasDurable;

/**
 * Startup bootstrap for installs that never set WEBPAGE_PREVIEW_TOKEN_SECRET:
 * persist a random secret in configStore once (ON CONFLICT DO NOTHING — the
 * first replica to boot wins, every other replica reads the same row back),
 * and use it for every subsequent boot. Call once from server startup;
 * non-fatal and safe to call repeatedly. Env secrets always win — installs
 * that set one are untouched. Mirrors certificateToken.ensureDurableSecret().
 */
const ensureDurableSecret = secret.ensureDurable;

module.exports = {
    issuePreviewToken,
    verifyPreviewToken,
    requirePreviewToken,
    hasDurableSecret,
    ensureDurableSecret,
};
