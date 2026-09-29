// @typecheck
/**
 * Crypto context for the transcription store.
 *
 * Resolves two things for a request — is the TRANSCRIPTS surface on for this
 * org, and what key opens its rows — and turns a row's content columns into
 * envelopes and back. transcriptionStore.js takes the resulting context and
 * never talks to the policy or the escrow itself, mirroring how
 * stores/agent/messageCrypto.js serves the message store.
 *
 * ── Reading is format-driven, never mode-driven ─────────────────────────────
 *
 * Every read here asks the VALUE what it is, never the config. A row written
 * while the surface was on stays readable after it is switched off, and a row
 * written before it was switched on needs no migration. There is deliberately
 * no "the policy says encrypted, so assume these bytes are" branch: a
 * mode-dependent read is how a config flip turns into permanent data loss.
 *
 * ── The columns, and why these ──────────────────────────────────────────────
 *
 * CONTENT is what people said and who said it. It is encrypted:
 *
 *   full_text, transcript, summary, segments, speakers, attendees, chapters
 *
 * `attendees` and `speakers` are in that list for the obvious reason: they are
 * names.
 *
 * NOT encrypted, and each for a reason that has to hold up:
 *
 *   action_items / decisions / questions
 *       These three are merged IN SQL on write (artifactColumnSql in
 *       transcriptionStore.js): the statement walks the stored array with
 *       jsonb_array_elements and keeps any element a human touched during the
 *       run, matching on ->>'id' and ->>'touchedAt'. That merge exists because
 *       a regeneration makes four LLM calls before it writes, and a person
 *       ticking off an action in the meantime must not lose it. None of it
 *       works on an envelope.
 *
 *       Encrypting them therefore means moving that merge into Node as a
 *       read-modify-write, which reintroduces exactly the race the SQL version
 *       was written to close. That is a change to the concurrency model, not a
 *       change to a column, and it does not belong in the same commit as the
 *       rest. They stay plaintext, visibly, until it is made — an action item
 *       is a sentence from the meeting, usually naming who it is assigned to,
 *       so this is a real remaining gap and not a rounding error.
 *
 *   id / user_id / organization_id / status / created_at
 *       Access-control and lifecycle primitives. Encrypting them turns every
 *       authorisation query into a table scan.
 *   title / file_name
 *       Left for a later change ON PURPOSE, not overlooked. They order and
 *       label the list, and a meeting title frequently names a client — so
 *       they need a decision about the list UX, not a quiet flip. Recorded
 *       here so the gap is visible rather than implied.
 *   duration / speaker_count / segment_count / language / provider / tags
 *       Counts and labels. They carry no content.
 *
 * ── Two derived columns exist so the list query stays cheap ─────────────────
 *
 * The list view built its preview in SQL with `LEFT(full_text, 2000)`, which
 * over an envelope returns the head of a ciphertext. Making the list decrypt
 * whole transcripts instead would turn a 2 KB row into a hundred-kilobyte one,
 * fifty times per page load.
 *
 * So the write path also stores `full_text_snippet_enc`: the same 2000-char
 * preview, encrypted, and small. Rows written before that column existed have
 * NULL in it, and the reader below falls back to the SQL expression for exactly
 * those — which is why the list query still selects both.
 *
 * The action counters need no such column: `action_items` stays plaintext (see
 * above), so `jsonb_array_length` over it keeps answering correctly.
 */

const { encryptField, decryptField, isEnvelope } = require('./lib/fieldEnvelope');
const { SURFACES } = require('./encryptionPolicy');
const log = require('../telemetry/log');

/** How much of the transcript the list preview carries. Mirrors the old LEFT(). */
const SNIPPET_CHARS = 2000;

/** Columns holding a plain string. */
const TEXT_COLUMNS = Object.freeze(['full_text', 'transcript', 'summary']);
/** Columns holding a JSON array, stored as text/jsonb. */
const JSON_COLUMNS = Object.freeze([
    'segments', 'speakers', 'attendees', 'chapters',
]);
const ALL_COLUMNS = Object.freeze([...TEXT_COLUMNS, ...JSON_COLUMNS]);

/** @typedef {{ key: Buffer|null, encrypt: boolean, tier: string }} TranscriptCryptoContext */

/** @type {Readonly<TranscriptCryptoContext>} */
const PLAINTEXT_CONTEXT = Object.freeze({ key: null, encrypt: false, tier: 'none' });

/**
 * AAD binds a column's ciphertext to the transcription and column it belongs
 * to, so a value cannot be moved between rows or between fields.
 */
function columnAad(transcriptionId, column) {
    return Buffer.from(`beeflow:transcript:v1:${transcriptionId}:${column}`);
}

/**
 * Resolve the crypto context for one organisation.
 *
 * Returns PLAINTEXT_CONTEXT whenever a key cannot be had. That is the right
 * fallback — emitting a value nobody can ever open would be worse — but it is
 * never silent when the org asked for encryption.
 *
 * @param {string|null} orgId
 * @param {object} [deps] injection seam for tests
 */
async function resolveTranscriptCrypto(orgId, deps = {}) {
    try {
        const resolvePolicy = deps.resolvePolicy
            || require('./encryptionPolicy').resolvePolicy;
        const shouldEncrypt = deps.shouldEncrypt
            || require('./encryptionPolicy').shouldEncrypt;

        const policy = await resolvePolicy(orgId);
        if (!policy || !policy.enabled) return PLAINTEXT_CONTEXT;
        if (!shouldEncrypt(policy, SURFACES.TRANSCRIPTS)) {
            // The org encrypts, but has this surface switched off. Reads still
            // work on whatever is already there; new writes are plaintext.
            return { key: null, encrypt: false, tier: policy.tier };
        }

        const getDek = deps.getTranscriptDek
            || require('../auth/transcriptEscrow').getTranscriptDek;
        const dek = await getDek(orgId);
        if (!dek) {
            // The org asked for it and we are about to write plaintext. This
            // must be loud, or an org sits on the tier writing cleartext with
            // nothing in the logs to show for it.
            log.error(`[TranscriptCrypto] Org '${orgId}' has the transcripts surface ON but no key could be resolved — transcriptions are being written in PLAINTEXT.`);
            return { key: null, encrypt: false, tier: policy.tier };
        }
        return { key: dek, encrypt: true, tier: policy.tier };
    } catch (e) {
        // A policy hiccup must not fail a transcription request. Plaintext is
        // recoverable; a 500 in the middle of an upload is not.
        log.error(`[TranscriptCrypto] Could not resolve the context for org '${orgId}': ${e.message}`);
        return PLAINTEXT_CONTEXT;
    }
}

/** The per-transcription key, or null when there is no org key. */
function keyFor(ctx, transcriptionId, deps = {}) {
    if (!ctx || !ctx.key || !transcriptionId) return null;
    const derive = deps.transcriptionKey
        || require('../auth/transcriptEscrow').transcriptionKey;
    return derive(ctx.key, transcriptionId);
}

/**
 * Encrypt the content columns of a row about to be written.
 *
 * Takes and returns a flat `{column: value}` map, so a caller can hand it the
 * subset it is actually writing — an INSERT passes every column, an UPDATE
 * passes only what changed.
 *
 * @param {string} transcriptionId
 * @param {Record<string, string>} values already-serialised column values
 * @param {{key: Buffer|null, encrypt: boolean}} ctx
 */
function encryptRow(transcriptionId, values, ctx, deps = {}) {
    const out = { ...values };
    const key = keyFor(ctx, transcriptionId, deps);
    const on = !!(ctx && ctx.encrypt && key);
    for (const col of ALL_COLUMNS) {
        if (!(col in out)) continue;
        const raw = out[col];
        if (raw === null || raw === undefined) continue;
        out[col] = encryptField(String(raw), {
            key,
            aad: columnAad(transcriptionId, col),
            encrypt: on,
        });
    }
    return out;
}

/**
 * The list preview for a transcript, encrypted under the same key.
 *
 * Returns null when there is nothing to preview, so the column stays NULL
 * rather than holding an envelope around an empty string — the readers below
 * distinguish "no snippet stored" from "an empty snippet", and a row that
 * genuinely has no transcript yet must read as the former.
 */
function buildSnippet(transcriptionId, fullText, ctx, deps = {}) {
    const text = typeof fullText === 'string' ? fullText : '';
    if (!text) return null;
    const key = keyFor(ctx, transcriptionId, deps);
    return encryptField(text.slice(0, SNIPPET_CHARS), {
        key,
        aad: columnAad(transcriptionId, 'full_text_snippet'),
        encrypt: !!(ctx && ctx.encrypt && key),
    });
}

/**
 * Action counters for the list, computed from the plaintext at write time.
 *
 * Counts are not content — how many open actions a meeting has says nothing
 * about what was said — so they are stored plain and the list reads them
 * directly instead of running jsonb_array_length over an envelope.
 */
function actionCounts(actionItems) {
    let items = actionItems;
    if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (_) { items = null; }
    }
    if (!Array.isArray(items)) return { total: 0, open: 0 };
    const total = items.length;
    const open = items.filter(it => String((it && it.done) ?? 'false') !== 'true').length;
    return { total, open };
}

/**
 * Decrypt the content columns of a row that came back from the DB.
 *
 * Every column is decided by its own value. A plaintext column passes through
 * untouched, which is what lets encrypted and plaintext rows sit in the same
 * result set during and after a backfill.
 *
 * A column that IS an envelope but will not open THROWS. It must never degrade
 * to '' — `updateTranscription` writes back what it read, so a silent empty
 * read would overwrite a meeting's transcript with nothing.
 */
function decryptRow(row, ctx, deps = {}) {
    if (!row) return row;
    const id = row.id;
    const key = keyFor(ctx, id, deps);
    const out = { ...row };
    for (const col of ALL_COLUMNS) {
        if (!(col in out)) continue;
        const raw = out[col];
        if (raw === null || raw === undefined) continue;
        out[col] = decryptField(raw, { key, aad: columnAad(id, col) });
    }
    return out;
}

/**
 * The preview for one list row, from whichever of the two sources applies.
 *
 * Order matters. The encrypted column wins when present; the SQL LEFT() is the
 * fallback for rows written before that column existed. And the SQL fallback is
 * only trusted when it does NOT look like the head of an envelope: on an
 * encrypted row that expression returns the first 2000 characters of the
 * ciphertext JSON, which is not a preview of anything.
 *
 * @param {{full_text_snippet_enc?: string, full_text_snippet?: string, id: string}} row
 */
function readSnippet(row, ctx, deps = {}) {
    if (!row) return '';
    const key = keyFor(ctx, row.id, deps);
    const stored = row.full_text_snippet_enc;
    if (stored !== null && stored !== undefined && stored !== '') {
        try {
            return decryptField(stored, { key, aad: columnAad(row.id, 'full_text_snippet') }) || '';
        } catch (e) {
            // One unreadable preview must not fail the whole list. The row
            // still opens on its detail page, where a throw is the right answer.
            log.warn(`[TranscriptCrypto] Preview for '${row.id}' could not be opened: ${e.message}`);
            return '';
        }
    }
    const legacy = row.full_text_snippet;
    if (typeof legacy !== 'string' || legacy === '') return '';
    // A truncated envelope never parses, so isEnvelope() cannot be asked
    // directly — test the head of the string instead.
    if (looksLikeEnvelopeHead(legacy)) return '';
    return legacy;
}

/**
 * Does this string look like the beginning of an envelope?
 *
 * isEnvelope() needs the whole value; LEFT(x, 2000) hands us a truncated one
 * that will never parse. Returning "yes" for a genuine plaintext transcript
 * that happens to open with our marker is the harmless direction: the preview
 * is empty rather than wrong.
 */
function looksLikeEnvelopeHead(value) {
    if (typeof value !== 'string' || value.length < 10) return false;
    if (isEnvelope(value)) return true;
    return value.charCodeAt(0) === 123 /* { */ && value.slice(0, 60).includes('_bfenc');
}

/** How much of the summary a list row carries. Mirrors the old LEFT(). */
const SUMMARY_SNIPPET_CHARS = 400;

/**
 * Build the stored summary preview. Same shape as buildSnippet, different cap.
 */
function buildSummarySnippet(transcriptionId, summary, ctx, deps = {}) {
    const text = typeof summary === 'string' ? summary : '';
    if (!text) return null;
    const key = keyFor(ctx, transcriptionId, deps);
    return encryptField(text.slice(0, SUMMARY_SNIPPET_CHARS), {
        key,
        aad: columnAad(transcriptionId, 'summary_snippet'),
        encrypt: !!(ctx && ctx.encrypt && key),
    });
}

/**
 * The summary preview for one list row.
 *
 * Stored column first, SQL LEFT() as the fallback for rows written before it
 * existed — exactly the arrangement readSnippet uses for the transcript, and
 * for the same reason. Carrying the WHOLE summary column instead and cutting it
 * here would have worked too, but it would have meant fifty full summaries
 * crossing the wire to draw five menu rows: the very thing
 * transcriptionStore.insights.test.js was written to prevent.
 *
 * Returns '' on a decrypt failure: one unreadable row must not fail a page of
 * meetings. The detail view still throws, which is where it belongs.
 */
function readSummarySnippet(row, ctx, deps = {}) {
    if (!row) return '';
    const key = keyFor(ctx, row.id, deps);
    const stored = row.summary_snippet_enc;
    if (stored !== null && stored !== undefined && stored !== '') {
        try {
            const text = decryptField(stored, { key, aad: columnAad(row.id, 'summary_snippet') });
            return typeof text === 'string' ? text.slice(0, SUMMARY_SNIPPET_CHARS) : '';
        } catch (e) {
            log.warn(`[TranscriptCrypto] Summary preview for '${row.id}' could not be opened: ${e.message}`);
            return '';
        }
    }
    const legacy = row.summary_snippet;
    if (typeof legacy !== 'string' || legacy === '') return '';
    if (looksLikeEnvelopeHead(legacy)) return '';
    return legacy.slice(0, SUMMARY_SNIPPET_CHARS);
}

/**
 * One context per DISTINCT organisation in a result set.
 *
 * A super-admin list spans orgs, and each org has its own key. Resolving per
 * row would ask the escrow once per meeting; resolving once for the whole list
 * would decrypt every org's rows with the first org's key. So: once per org,
 * and rows carry their own answer.
 *
 * @param {Array<{organization_id?: string|null}>} rows
 * @returns {Promise<Map<string, object>>} keyed by the org id as stored ('' for none)
 */
async function resolveForRows(rows, deps = {}) {
    const byOrg = new Map();
    if (!Array.isArray(rows)) return byOrg;
    const resolve = deps.resolveTranscriptCrypto || resolveTranscriptCrypto;
    const orgIds = new Set(rows.map(r => (r && r.organization_id) || ''));
    for (const orgId of orgIds) {
        byOrg.set(orgId, orgId ? await resolve(orgId, deps) : PLAINTEXT_CONTEXT);
    }
    return byOrg;
}

/** The context for one row out of a resolveForRows() map. */
function ctxForRow(byOrg, row) {
    if (!byOrg || !row) return PLAINTEXT_CONTEXT;
    return byOrg.get((row && row.organization_id) || '') || PLAINTEXT_CONTEXT;
}

module.exports = {
    SNIPPET_CHARS,
    SUMMARY_SNIPPET_CHARS,
    readSummarySnippet,
    buildSummarySnippet,
    TEXT_COLUMNS,
    JSON_COLUMNS,
    ALL_COLUMNS,
    PLAINTEXT_CONTEXT,
    columnAad,
    resolveTranscriptCrypto,
    keyFor,
    encryptRow,
    buildSnippet,
    actionCounts,
    decryptRow,
    readSnippet,
    looksLikeEnvelopeHead,
    resolveForRows,
    ctxForRow,
};
