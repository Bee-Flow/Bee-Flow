// @typecheck
/**
 * Public-share viewer auth — three signed tokens, all HMAC-SHA256:
 *
 *   1. Magic-link `k` query param  — emailed to an allow-listed recipient,
 *      proves "this email holder asked to view this share". Short TTL.
 *   2. Unlock cookie                — set by the server after a successful
 *      password-unlock or magic-link redemption; lets the viewer skip the
 *      gate on subsequent navigations to the same share. Bound to the
 *      share ID, NOT the raw token, so the cookie is useless if the share
 *      is revoked then re-issued with a new token.
 *   3. CSRF token                   — for the password-unlock POST.
 *
 * Three more are minted for surfaces that have no session at all: a `view`
 * token for the opaque-origin content iframe, a `bridge` token for the public
 * AI bridge, and a `visitor` token that gives an anonymous Studio-app visitor a
 * stable, server-generated identity (see the section at the bottom).
 *
 * All of them are derived from the same secret, but with distinct purpose
 * prefixes so a token of one type cannot be replayed as another. That secret
 * comes from the shared env -> configStore -> prod-random -> dev-disk ladder
 * (see the createSigningSecret call below); the configStore rung is what makes
 * every replica of a multi-pod deploy agree on it, and dev falls back to a
 * random key persisted on disk so restarts keep verifying.
 */

const { createSigningSecret } = require('./lib/signingSecret');
const signedPayload = require('./lib/signedPayload');

const MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;        // 24h
const UNLOCK_COOKIE_TTL_MS = 6 * 60 * 60 * 1000;      // 6h
const CSRF_TTL_MS = 30 * 60 * 1000;                   // 30m
const VIEW_TOKEN_TTL_MS = 15 * 60 * 1000;             // 15m
const BRIDGE_TOKEN_TTL_MS = 30 * 60 * 1000;           // 30m
// Long, deliberately: this is the identity a person filling in a public form
// carries. Photographing a meter cupboard from a phone and finishing the form
// is not a 30-minute task, and losing the token mid-way loses the answers.
const VISITOR_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;     // 12h

// The env → configStore → prod-random → dev-disk ladder lives in lib/
// signingSecret.js, shared with certificateToken and webpagePreviewToken.
//
// The configKey was added in BFSF-420. Until then this module had no durable
// rung at all: with no env var set, a production replica dropped straight to
// the per-process crypto.randomBytes(32) branch, so every pod signed with a
// different key. On the documented two-replica deploy that is a coin flip per
// request — the CSRF minted while rendering a public form page came back
// "This form expired" whenever the submit landed on the sibling pod, magic
// links only opened on the pod that mailed them, and an anonymous Studio-app
// visitor whose visitor token hit the wrong pod was 401'd, reloaded, and was
// handed a NEW viewerId — losing every row created_by had scoped to the old
// one. setSecretIfAbsent's ON CONFLICT DO NOTHING gives all replicas one
// agreed value with no operator action: first pod to boot wins, the rest read
// the same row back.
//
// The one-time cost, accepted knowingly: on the first boot after this change
// the effective secret becomes the configStore one instead of whatever this
// process had improvised, so magic links, unlock cookies, view/bridge/visitor
// tokens and form CSRFs outstanding at that moment stop verifying — visitors
// re-request the link or reload the page. On any multi-replica install those
// tokens already verified on just one pod out of N, so this is strictly
// better; webpagePreviewToken took the identical trade for the identical
// reason. Nor does it close the startup window: a request arriving before
// ensureDurableSecret() resolves still mints with the per-process random,
// which is what the loud warning below is for.
//
// Deliberately NOT solved by telling operators to set the env var:
// PUBLIC_SHARE_TOKEN_SECRET is also the second entry in certificateToken.js's
// envVars, and env wins the entire ladder — setting it re-derives every
// Learning-Center certificate serial and permanently 404s every
// /verify/<token> link already handed out.
const secret = createSigningSecret({
    envVars: ['PUBLIC_SHARE_TOKEN_SECRET'],
    devCacheName: 'beeflow-public-share-secret',
    configKey: 'public_share_token_secret',
    label: 'PublicShareToken',
    productionLogLevel: 'warn',
    productionWarning:
        'PUBLIC_SHARE_TOKEN_SECRET is not set and the startup bootstrap has not run — this ' +
        'replica is signing with a per-process random key. Everything minted here is rejected ' +
        'by sibling replicas and dies on restart: magic links, unlock cookies, view/bridge ' +
        'tokens, the CSRF on public forms (submitting one reports "This form expired") and the ' +
        'anonymous Studio-app visitor identity (the visitor silently gets a new id and loses ' +
        'the rows scoped to the old one). Normally transient — wait for ensureDurableSecret() ' +
        'to persist the configStore secret that every replica then shares. Do NOT set ' +
        'PUBLIC_SHARE_TOKEN_SECRET to silence this: certificateToken.js reads the same ' +
        'variable and would rekey every Learning-Center certificate serial and verify link.',
});

// The purpose prefix is what stops a token of one type being replayed as
// another, so it is stamped in on the way out and checked on the way back.
function signPayload(purpose, payload) {
    return signedPayload.sign(secret.get(), { p: purpose, ...payload });
}

function verifyPayload(purpose, token) {
    const payload = signedPayload.verify(secret.get(), token);
    if (!payload || payload.p !== purpose) return null;
    if (typeof payload.e === 'number' && payload.e < Date.now()) return null;
    return payload;
}

// ── Magic link (email-gated mode) ──────────────────────────────────

function issueMagicLink({ shareId, email }) {
    return signPayload('magic', {
        s: shareId,
        m: String(email).trim().toLowerCase(),
        e: Date.now() + MAGIC_LINK_TTL_MS,
    });
}

function verifyMagicLink(token, expectedShareId) {
    const p = verifyPayload('magic', token);
    if (!p) return null;
    if (p.s !== expectedShareId) return null;
    return { email: p.m, expiresAt: p.e };
}

// ── Unlock cookie ──────────────────────────────────────────────────

function issueUnlockCookie({ shareId, email }) {
    return signPayload('unlock', {
        s: shareId,
        ...(email ? { m: String(email).trim().toLowerCase() } : {}),
        e: Date.now() + UNLOCK_COOKIE_TTL_MS,
    });
}

function verifyUnlockCookie(token, expectedShareId) {
    const p = verifyPayload('unlock', token);
    if (!p) return null;
    if (p.s !== expectedShareId) return null;
    return { email: p.m || null, expiresAt: p.e };
}

// ── CSRF (password-unlock form) ────────────────────────────────────

function issueCsrf(shareId) {
    return signPayload('csrf', { s: shareId, e: Date.now() + CSRF_TTL_MS });
}

function verifyCsrf(token, expectedShareId) {
    const p = verifyPayload('csrf', token);
    return !!(p && p.s === expectedShareId);
}

// ── View token (opaque-origin sub-frame auth) ──────────────────────
//
// The content iframe runs `sandbox="allow-scripts allow-forms"` with NO
// `allow-same-origin`, so it has an opaque origin and the browser withholds
// the SameSite=Lax unlock cookie on its /content and /extras sub-requests.
// A view token, minted at chrome-render time (top-level nav, where the cookie
// IS sent and the gate passes) and threaded into the iframe/extras URLs, lets
// those sub-requests authorize without the cookie. Bound to the share ID, so
// it is worthless for any other share and dies when the share is revoked +
// re-issued with a new share ID.
function issueViewToken({ shareId, email }) {
    return signPayload('view', {
        s: shareId,
        ...(email ? { m: String(email).trim().toLowerCase() } : {}),
        e: Date.now() + VIEW_TOKEN_TTL_MS,
    });
}

function verifyViewToken(token, expectedShareId) {
    const p = verifyPayload('view', token);
    if (!p) return null;
    if (p.s !== expectedShareId) return null;
    return { shareId: p.s, email: p.m || null, expiresAt: p.e };
}

// ── Bridge token (anonymous AI bridge auth) ────────────────────────
//
// Authorizes the public AI bridge (window.beeflowAI on a shared page) to call
// /api/public-share/ai/*. Minted at content-serve time only when the author
// opted the share into public AI. Binds BOTH the share (`s` — keys rate-limit/
// spend-cap and lets each call re-check the share is still live) and the
// webpage (`w` — resolves the author server-side; there is no URL :id to
// cross-check as requirePreviewToken does). No user is bound: the share row +
// gate is the authorization, and the bridge runs acts-as-author.
function issueBridgeToken({ shareId, webpageId }) {
    return signPayload('bridge', { s: shareId, w: webpageId, e: Date.now() + BRIDGE_TOKEN_TTL_MS });
}

function verifyBridgeToken(token) {
    const p = verifyPayload('bridge', token);
    if (!p || !p.s || !p.w) return null;
    return { shareId: p.s, webpageId: p.w, expiresAt: p.e };
}

// ── Visitor token (anonymous Studio-app viewer identity) ───────────
//
// A public Studio-app page (routes/studioAppPublic.js) has no session and no
// user, but its writes still have to be attributable and isolated: RLS scopes
// rows by `created_by`, so two strangers filling in the same form must not be
// able to read each other's answers. This token IS that identity — minted at
// page-load, carrying a server-generated anonymous viewer id, and presented as
// a bearer on every follow-up call.
//
// Bound to BOTH the page token (`t`) and the app (`a`): a visitor token from
// one public page is worthless on another, and revoking the page (deleting the
// row) kills every token that named it. The viewer id is never client-supplied
// — that is the whole point, since it is what `created_by` becomes.
function issueVisitorToken({ pageToken, appId, viewerId }) {
    return signPayload('visitor', {
        t: pageToken,
        a: appId,
        v: viewerId,
        e: Date.now() + VISITOR_TOKEN_TTL_MS,
    });
}

function verifyVisitorToken(token, expectedPageToken) {
    const p = verifyPayload('visitor', token);
    if (!p || !p.t || !p.a || !p.v) return null;
    if (expectedPageToken && p.t !== expectedPageToken) return null;
    return { pageToken: p.t, appId: p.a, viewerId: p.v, expiresAt: p.e };
}

// True once the signing secret survives a restart AND is shared with the
// sibling replicas (env var, configStore-bootstrapped, or a persisted dev
// cache file). False means this process is on the per-process random fallback.
const hasDurableSecret = secret.hasDurable;

/**
 * Startup bootstrap for installs that never set PUBLIC_SHARE_TOKEN_SECRET —
 * and that is every install, since setting that variable would collide with
 * certificateToken (see the note above the createSigningSecret call). Persists
 * one random secret in configStore (ON CONFLICT DO NOTHING, so the first
 * replica to boot wins and every other replica reads the same row back) and
 * uses it for every subsequent boot. Call once from server startup; non-fatal
 * and safe to call repeatedly. Mirrors webpagePreviewToken.ensureDurableSecret().
 */
const ensureDurableSecret = secret.ensureDurable;

module.exports = {
    issueMagicLink,
    verifyMagicLink,
    issueUnlockCookie,
    verifyUnlockCookie,
    issueCsrf,
    verifyCsrf,
    issueViewToken,
    verifyViewToken,
    issueBridgeToken,
    verifyBridgeToken,
    issueVisitorToken,
    verifyVisitorToken,
    hasDurableSecret,
    ensureDurableSecret,
    UNLOCK_COOKIE_TTL_MS,
    MAGIC_LINK_TTL_MS,
    VIEW_TOKEN_TTL_MS,
    BRIDGE_TOKEN_TTL_MS,
    VISITOR_TOKEN_TTL_MS,
};
