/**
 * Nextcloud Talk BOT client — posting as "Bee Flow", not as a person.
 *
 * Every other Talk call in this codebase goes out as a *user* (OAuth, app
 * password, or the connector's AppAPI impersonation). An approval card should
 * not: it is the product speaking, and it must be postable on a schedule, from
 * a paused run, with nobody logged in. Talk's bot API is exactly that — an
 * identity authenticated by a shared secret instead of a session.
 *
 * ── The signature contract (verified against spreed) ────────────────────────
 * Both directions use HMAC-SHA256 over `RANDOM ‖ PAYLOAD`, keyed with the bot's
 * shared secret, compared lowercase-hex and constant-time. What PAYLOAD is
 * differs per endpoint, and getting it wrong is a silent 401:
 *
 *   inbound webhook   PAYLOAD = the RAW request body
 *                     (spreed/docs/bots.md "Signing and Verifying Requests")
 *   POST /bot/{token}/message           PAYLOAD = the message TEXT
 *   POST|DELETE /bot/{token}/reaction/… PAYLOAD = the emoji
 *                     (spreed lib/Controller/BotController.php — sendMessage
 *                      passes $message and react() passes $reaction into
 *                      getBotOrErrorResponse, which is what gets signed)
 *
 * Not the JSON envelope, in any case: `replyTo` / `referenceId` / `silent` ride
 * outside the signature.
 *
 * ── The thing that shapes the delivery ledger ───────────────────────────────
 * `POST /bot/{token}/message` answers **201 with an empty body** — verified in
 * BotController::sendMessage (`return new DataResponse(null, STATUS_CREATED)`).
 * A bot therefore cannot learn the id of the message it just posted, and the id
 * is what an inbound reaction is keyed by. So a bot post is followed by ONE
 * read — `GET /chat/{token}` matched on our own `referenceId` — using whatever
 * user/connector auth the caller has. When there is no read auth the card is
 * still delivered (deep link and all); it simply cannot count reactions, and
 * the ledger row records that by carrying no messageId.
 *
 * ── Versions ───────────────────────────────────────────────────────────────
 *   bots + `bots-v1`            Nextcloud 27.1 / Talk 17.1
 *   reaction webhooks           Nextcloud 31 / Talk 21 (bot feature `reaction`)
 *   GET /reaction/{token}/{id}  Nextcloud 24 (capability `reactions`) — the
 *                               polling fallback below 31
 *   react permission 256        Nextcloud 34 (a 403 means the attendee lacks it)
 *
 * The bot itself can only be installed by a Nextcloud admin (`occ
 * talk:bot:install`, or — as our ExApp does — AppAPI's talk_bot registration).
 * Bee Flow cannot self-provision one; without a secret every function here
 * declines and the caller falls back to posting as a user.
 */

const crypto = require('crypto');
const configStore = require('../stores/configStore');
const { nextcloudFetch } = require('./nextcloudTarget');

const TALK_V1 = '/ocs/v2.php/apps/spreed/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;
/** Talk's own cap (`spreed => config => chat => max-length`); margin kept. */
const MAX_MESSAGE_CHARS = 30_000;

const COMMON_HEADERS = Object.freeze({
    'OCS-APIRequest': 'true',
    'Accept': 'application/json',
});

/**
 * Where an org's bot secret lives. `_secret_` matches configStore's
 * SECRET_KEY_PATTERNS, so it is envelope-encrypted at rest and only ever
 * reachable through getSecret — it must never be logged, echoed in an error,
 * or returned to a client.
 */
function botSecretKey(orgId) {
    return `nc_talk_bot_secret_${orgId}`;
}

async function getBotSecret(orgId) {
    if (!orgId) return null;
    try {
        const secret = await configStore.getSecret(botSecretKey(orgId));
        return typeof secret === 'string' && secret.length >= 40 ? secret : null;
    } catch { return null; }
}

/** HMAC-SHA256(random ‖ payload) as lowercase hex. */
function botSignature(secret, random, payload) {
    return crypto.createHmac('sha256', secret).update(`${random}${payload}`).digest('hex');
}

/**
 * Verify an inbound Talk delivery. Fails CLOSED on a missing secret, a short
 * random (Talk sends 64 chars; anything brute-forceable is refused outright)
 * and any length mismatch, and compares constant-time so a wrong signature
 * leaks no timing information about the right one.
 *
 * @param {{secret:string, random:string, signature:string, body:string}} p
 */
function verifyTalkSignature({ secret, random, signature, body }) {
    if (typeof secret !== 'string' || !secret) return false;
    if (typeof random !== 'string' || random.length < 32) return false;
    if (typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
    const expected = crypto.createHmac('sha256', secret)
        .update(`${random}${typeof body === 'string' ? body : ''}`).digest();
    let got;
    try { got = Buffer.from(signature.toLowerCase(), 'hex'); } catch { return false; }
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(expected, got);
}

function signedHeaders(secret, payload) {
    const random = crypto.randomBytes(32).toString('hex');
    return {
        ...COMMON_HEADERS,
        'Content-Type': 'application/json',
        'X-Nextcloud-Talk-Bot-Random': random,
        'X-Nextcloud-Talk-Bot-Signature': botSignature(secret, random, payload),
    };
}

/**
 * Post a message as the bot.
 *
 * Returns `{ ok, status, referenceId }`. There is no message id in the
 * response by design (see the header) — pair this with
 * findMessageIdByReference when reactions have to be countable.
 */
async function postBotMessage({ baseUrl, secret, roomToken, message, replyTo = null, silent = false }) {
    const text = String(message || '').slice(0, MAX_MESSAGE_CHARS);
    if (!baseUrl || !secret || !roomToken || !text.trim()) {
        return { ok: false, status: 0, error: 'missing baseUrl, secret, room or message' };
    }
    // The referenceId is how we find our own message again; it is derived from
    // random bytes, never from the message content (two identical cards in one
    // room must not collide onto one id).
    const referenceId = crypto.randomBytes(32).toString('hex');
    const body = { message: text, referenceId, silent: !!silent };
    if (Number.isFinite(Number(replyTo)) && Number(replyTo) > 0) body.replyTo = Number(replyTo);

    const res = await nextcloudFetch(
        `${baseUrl}${TALK_V1}/bot/${encodeURIComponent(roomToken)}/message?format=json`,
        {
            method: 'POST',
            headers: signedHeaders(secret, text),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
    );
    if (res.status === 201 || res.ok) return { ok: true, status: res.status, referenceId };
    return { ok: false, status: res.status, referenceId, error: botPostError(res.status) };
}

/** Add a reaction as the bot. Signature covers the EMOJI, not the envelope. */
async function postBotReaction({ baseUrl, secret, roomToken, messageId, reaction }) {
    const emoji = String(reaction || '');
    if (!baseUrl || !secret || !roomToken || messageId == null || !emoji) {
        return { ok: false, status: 0, error: 'missing baseUrl, secret, room, message or reaction' };
    }
    const res = await nextcloudFetch(
        `${baseUrl}${TALK_V1}/bot/${encodeURIComponent(roomToken)}/reaction/${encodeURIComponent(messageId)}?format=json`,
        {
            method: 'POST',
            headers: signedHeaders(secret, emoji),
            body: JSON.stringify({ reaction: emoji }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
    );
    // 200 = the reaction already existed, which is the same outcome.
    if (res.status === 201 || res.status === 200) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: botPostError(res.status) };
}

function botPostError(status) {
    switch (status) {
        case 401: return 'the Bee Flow bot is not enabled in this conversation — a moderator has to add it';
        case 404: return 'conversation not found';
        case 413: return 'card too long for Talk';
        case 429: return 'Talk is throttling the bot (too many rejected requests)';
        default:  return `Talk bot post failed (HTTP ${status})`;
    }
}

/**
 * Recover the id of a message we posted, by our own referenceId.
 *
 * `ncFetch`/`baseUrl` come from nextcloudClient.resolveAuth — this is a USER
 * (or connector-impersonated) read, because bots have no read surface at all.
 * `lookIntoFuture=0` returns the newest messages immediately rather than long-
 * polling. Returns null when the read is unavailable or the message is not in
 * the window; the caller treats that as "delivered, reactions not countable".
 */
async function findMessageIdByReference({ ncFetch, baseUrl, roomToken, referenceId, limit = 20 }) {
    if (typeof ncFetch !== 'function' || !baseUrl || !roomToken || !referenceId) return null;
    try {
        const url = `${baseUrl}${TALK_V1}/chat/${encodeURIComponent(roomToken)}`
            + `?format=json&lookIntoFuture=0&limit=${encodeURIComponent(limit)}&setReadMarker=0`;
        const res = await ncFetch(url, { method: 'GET', headers: COMMON_HEADERS });
        if (!res || !res.ok) return null;                    // 304 included: nothing to match
        const data = await res.json().catch(() => null);
        const rows = data?.ocs?.data;
        if (!Array.isArray(rows)) return null;
        const hit = rows.find(m => m && m.referenceId === referenceId);
        return hit && hit.id != null ? String(hit.id) : null;
    } catch { return null; }
}

/**
 * Who reacted to a message, and with what — the POLLING half of the inbound
 * path, for Nextcloud 24–30 where the bot gets no reaction webhooks.
 *
 * Returns `[{ reaction, actorType, actorId, actorDisplayName, timestamp }]`,
 * flattened from Talk's emoji-keyed map. A 403 means the attendee lacks the
 * separate react permission (256, Nextcloud 34+); both that and any other
 * failure return [] — a poll that cannot read is silence, never a decision.
 */
async function listMessageReactions({ ncFetch, baseUrl, roomToken, messageId, reaction = null }) {
    if (typeof ncFetch !== 'function' || !baseUrl || !roomToken || messageId == null) return [];
    try {
        const qs = reaction ? `&reaction=${encodeURIComponent(reaction)}` : '';
        const url = `${baseUrl}${TALK_V1}/reaction/${encodeURIComponent(roomToken)}/${encodeURIComponent(messageId)}?format=json${qs}`;
        const res = await ncFetch(url, { method: 'GET', headers: COMMON_HEADERS });
        if (!res || !res.ok) return [];
        const data = await res.json().catch(() => null);
        const map = data?.ocs?.data;
        if (!map || typeof map !== 'object') return [];
        const out = [];
        for (const [emoji, actors] of Object.entries(map)) {
            for (const a of Array.isArray(actors) ? actors : []) {
                out.push({
                    reaction: emoji,
                    actorType: a?.actorType || null,
                    actorId: a?.actorId || null,
                    actorDisplayName: a?.actorDisplayName || null,
                    timestamp: a?.timestamp ?? null,
                });
            }
        }
        return out;
    } catch { return []; }
}

module.exports = {
    TALK_V1,
    MAX_MESSAGE_CHARS,
    botSecretKey,
    getBotSecret,
    botSignature,
    verifyTalkSignature,
    postBotMessage,
    postBotReaction,
    findMessageIdByReference,
    listMessageReactions,
};
