// @typecheck
/**
 * Meeting prefs — per-meeting recording preference and tags (M5, "Scheduled & rules").
 *
 * This is the RELOCATION of the recording exclusion, not a second source of truth. Until now
 * "do not record" lived as four string arrays in four configStore docs:
 *   org_talk_notes_<orgId>  / user_talk_notes_<userId>   → excludedRoomTokens[], excludedEventUids[]
 *   org_gmeet_notes_<orgId> / user_gmeet_notes_<userId>  → excludedMeetingCodes[], excludedEventIds[]
 * Presence in such an array meant "do not record"; there was no positive
 * value, so "on" and "never had an opinion" were the same thing. This table
 * takes over that role, `backfillFromExclusions()` fetches the existing
 * exclusions, and the old arrays are no longer read. They DO remain in place:
 * a rollback to the previous image must still find the exclusions.
 *
 * ── SHAPE ──────────────────────────────────────────────────────────────
 *   meeting_prefs(provider, id_kind, external_id, user_id, org_id, tags, record)
 *
 *   provider     'talk' | 'gmeet' | 'teams' — the same label that the Scheduled list shows.
 *   id_kind      'room' | 'event' | 'code'. One provider has TWO id spaces:
 *                Talk a roomToken (the room, every call in it) and an
 *                eventUid (one calendar occurrence); Meet a meetingCode (the
 *                series) and an eventId (one occurrence). Without id_kind a
 *                roomToken and an eventUid would collide in the same key and
 *                an exclusion on the one would become that of the other.
 *   user_id      the owner of the preference; '' = org-wide rule.
 *   org_id       '' = personal rule. The CHECK enforces that exactly one of
 *                the two is filled, so the same preference can never exist as two
 *                rows. '' instead of NULL because NULL does not collide in a key
 *                (same reason as skill_activations.agent_id).
 *   record       THREE-VALUED: TRUE = record, FALSE = do not record,
 *                NULL/no row = no opinion → inherit. That third case is not a
 *                luxury: without NULL the backfill would have to write a
 *                `true` for every non-excluded meeting, and then it would freeze the
 *                global autoRecord/autoImport switch at its current position.
 *   tags         the tags that the note receiving this will get later. New;
 *                the old storage had no source for it, so this starts empty. Note:
 *                this is something DIFFERENT from the tags on an existing note
 *                (GET /api/transcriptions/tags) — those hang on the result,
 *                these on the arrangement.
 *
 * ── THE ROW IS PER USER ───────────────────────────────────────────────
 * Two participants of the same meeting each have their own row and may decide
 * differently. `listPrefs` therefore filters on `user_id = $n` (exact,
 * never a LIKE or an OR that lets in someone else's row) and on org rows only
 * via `user_id = '' AND org_id = $n`. A call with neither a userId nor an orgId
 * yields [] — a filter that scopes to nobody returns nothing rather than
 * everything (same rule as automationStore.buildRunFilterWhere).
 *
 * ── THE 1-ON-1 DEFAULT ────────────────────────────────────────────────
 * With at most two participants `record` defaults to FALSE: a
 * one-to-one conversation is rarely a meeting and often the most sensitive thing
 * on the calendar. "Two participants" and "count unknown" are not the
 * same there, but unknown NARROWS: it does not count as "more than two", so even
 * then the default stays FALSE. Only a KNOWN count above two lets the
 * global switch (`fallback`) decide. An explicit preference always wins
 * over this default — that is precisely what `record = TRUE` exists for.
 *
 * ── EXCLUSION NARROWS ─────────────────────────────────────────────────
 * If several rows touch the same meeting (org + user, or room +
 * occurrence), then a single FALSE wins. That is exactly what the old union
 * of org and user arrays did: an org could exclude and a user could not
 * get around it. Only when no touching row says FALSE does a TRUE count.
 */

'use strict';

const { run, getAll } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');

const PROVIDERS = Object.freeze(['talk', 'gmeet', 'teams']);
const ID_KINDS = Object.freeze(['room', 'event', 'code']);

/** Tot en met dit aantal deelnemers is opnemen standaard UIT. */
const SMALL_MEETING_MAX = 2;

/** configStore-sleutel die zegt dat de eenmalige backfill klaar is. */
const BACKFILL_KEY = 'meeting_prefs_backfill_v1';

/**
 * The four old exclusion documents, with per document which field stores which
 * id space. This is the ONLY place that still knows the old shape.
 */
const LEGACY_SOURCES = Object.freeze([
    { prefix: 'user_talk_notes_', provider: 'talk', scope: 'user', fields: [['excludedEventUids', 'event'], ['excludedRoomTokens', 'room']] },
    { prefix: 'org_talk_notes_', provider: 'talk', scope: 'org', fields: [['excludedEventUids', 'event'], ['excludedRoomTokens', 'room']] },
    { prefix: 'user_gmeet_notes_', provider: 'gmeet', scope: 'user', fields: [['excludedEventIds', 'event'], ['excludedMeetingCodes', 'code']] },
    { prefix: 'org_gmeet_notes_', provider: 'gmeet', scope: 'org', fields: [['excludedEventIds', 'event'], ['excludedMeetingCodes', 'code']] },
]);

/**
 * @typedef {{ provider: string, idKind: string, externalId: string, userId: string | null, orgId: string | null,
 *   tags: string[], record: boolean | null, updatedAt?: string | null, updatedBy?: string | null }} PrefRow
 * @typedef {{ kind?: string, id?: string | null }} PrefIdInput
 */

// ── kleine normalisatoren ────────────────────────────────────────────
/** @param {string | null | undefined} v */
function normProvider(v) { return PROVIDERS.includes(v) ? v : null; }
/** @param {string | null | undefined} v */
function normKind(v) { return ID_KINDS.includes(v) ? v : null; }
/** @param {unknown} v */
function normId(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
/** @param {unknown} v */
function asStrArray(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []; }

/** JSONB komt terug als array (pg parst jsonb) of als string (sommige facades). */
/**
 * @param {unknown} v
 * @returns {string[]}
 */
function parseTags(v) {
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    if (typeof v === 'string') {
        try { return parseTags(JSON.parse(v)); } catch (_) { return []; }
    }
    return [];
}

/**
 * @param {import('pg').QueryResultRow | null | undefined} r
 * @returns {PrefRow | null}
 */
function mapRow(r) {
    if (!r) return null;
    return {
        provider: r.provider,
        idKind: r.id_kind,
        externalId: r.external_id,
        userId: r.user_id || null,
        orgId: r.org_id || null,
        tags: parseTags(r.tags),
        // Only a real boolean is an opinion; everything else is "no opinion".
        record: r.record === true ? true : r.record === false ? false : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        updatedBy: r.updated_by || null,
    };
}

/**
 * Normalise a list of identities. Accepts [{kind, id}] and discards empty or
 * unknown kinds. Order is preserved: call with the MOST SPECIFIC
 * first (occurrence before room/series) — tags are collected in that order.
 * @param {PrefIdInput | Array<PrefIdInput | null | undefined> | null | undefined} ids
 */
function normalizeIds(ids) {
    /** @type {{ kind: string, id: string }[]} */
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(ids) ? ids : [ids]) {
        if (!entry) continue;
        const kind = normKind(entry.kind);
        const id = normId(entry.id);
        if (!kind || !id) continue;
        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, id });
    }
    return out;
}

/**
 * Talk-identiteiten van een vergadering, meest specifiek eerst.
 * @param {{ eventUid?: string | null, roomToken?: string | null }} [ids]
 */
function talkIds({ eventUid = null, roomToken = null } = {}) {
    return normalizeIds([{ kind: 'event', id: eventUid }, { kind: 'room', id: roomToken }]);
}

/**
 * Google Meet-identiteiten van een vergadering, meest specifiek eerst.
 * @param {{ eventId?: string | null, meetingCode?: string | null }} [ids]
 */
function gmeetIds({ eventId = null, meetingCode = null } = {}) {
    return normalizeIds([{ kind: 'event', id: eventId }, { kind: 'code', id: meetingCode }]);
}

/**
 * Teams identities of a meeting, most specific first: the
 * calendar appointment (this time) and the series master in Outlook (the whole series).
 * @param {{ eventId?: string | null, seriesMasterId?: string | null }} [ids]
 */
function teamsIds({ eventId = null, seriesMasterId = null } = {}) {
    return normalizeIds([{ kind: 'event', id: eventId }, { kind: 'code', id: seriesMasterId }]);
}

// ── schema + eenmalige backfill ──────────────────────────────────────

const initDB = makeStoreInit('MeetingPrefsStore', async () => {
    const res = await runDdl('meetingPrefsStore', [
        `CREATE TABLE IF NOT EXISTS meeting_prefs (
            provider    TEXT NOT NULL,
            id_kind     TEXT NOT NULL,
            external_id TEXT NOT NULL,
            user_id     TEXT NOT NULL DEFAULT '',
            org_id      TEXT NOT NULL DEFAULT '',
            tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
            record      BOOLEAN,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by  TEXT,
            PRIMARY KEY (provider, id_kind, external_id, user_id, org_id),
            CONSTRAINT meeting_prefs_one_scope
                CHECK ((user_id <> '' AND org_id = '') OR (user_id = '' AND org_id <> ''))
        )`,
        `CREATE INDEX IF NOT EXISTS idx_meeting_prefs_user ON meeting_prefs(user_id, provider) WHERE user_id <> ''`,
        `CREATE INDEX IF NOT EXISTS idx_meeting_prefs_org ON meeting_prefs(org_id, provider) WHERE user_id = ''`,
    ]);
    // runDdl reports SQLSTATE errors back instead of throwing. Here that is not
    // enough: on a half-built schema every read would silently return empty —
    // and empty means here "nobody has switched recording off".
    if (res.failures.length) {
        throw new Error(`meeting_prefs DDL faalde (${res.failures.map(f => f.code).join(', ')}) — zie de [DDL:meetingPrefsStore]-regels`);
    }
    // The backfill belongs WITHIN the init promise: every public function waits on
    // initDB(), so no reader can see the table before the existing
    // exclusions are in it. The other way round, a read in that window would read "no
    // opinion" and therefore record what somebody had switched off.
    await backfillFromExclusions();
});

/**
 * Fetch the existing exclusions from the four configStore documents and write
 * them as `record = FALSE` rows. Idempotent (ON CONFLICT DO NOTHING) and not
 * destructive: the old fields remain in place.
 *
 * ONLY exclusions. For meetings that are not in there nothing is written —
 * a `record = true` row would freeze the global switch.
 *
 * Fails loudly. One unreadable document makes the whole backfill (and with it
 * the store init) fail instead of skipping that user: skipping would
 * mean that their exclusion silently disappears, and that is precisely the
 * mistake that this relocation may not make. The init memo retries.
 *
 * ── AN EMPTY SCAN IS NO PROOF ─────────────────────────────────────────
 * The marker is only set if the scan really SAW something. For one document that
 * distinction already held (unreadable ≠ empty); for the COLLECTION it did not,
 * and there lies a real race: `migrateConfigJson()`
 * in configStore is fire-and-forget (nothing awaits it) and writes a
 * leftover data/config.json row by row. If this backfill runs in
 * that window, then `listKeysWithPrefix` yields zero keys — and with an unconditional
 * marker every later boot skipped the scan and those exclusions were
 * gone for good. That is exactly the FALSE→TRUE that this relocation
 * may not make, so: no documents seen = nothing proven = no marker.
 * The price is four prefix scans (index-range reads that return nothing) per
 * boot on an installation that really has no meeting settings.
 *
 * Manual recovery path, if the marker nevertheless turns out to be set too early:
 *   node -e "require('./stores/meetingPrefsStore').backfillFromExclusions({force:true}).then(console.log)"
 * (from server/ — `force` skips the marker check and rereads everything).
 */
async function backfillFromExclusions({ force = false } = {}) {
    const configStore = require('./configStore');
    if (!force) {
        const done = await configStore.getConfig(BACKFILL_KEY);
        if (done && done.completedAt) return { skipped: true, scanned: 0, inserted: 0, marked: true };
    }

    let scanned = 0;
    let inserted = 0;
    for (const src of LEGACY_SOURCES) {
        const keys = await configStore.listKeysWithPrefix(src.prefix);
        for (const key of keys) {
            const ownerId = key.slice(src.prefix.length);
            if (!ownerId) continue;
            const doc = await configStore.getConfig(key);
            // No document = nothing to exclude. A document that is NOT an
            // object is unreadable — and unreadable is something other than empty.
            if (doc === null || doc === undefined) continue;
            if (typeof doc !== 'object' || Array.isArray(doc)) {
                throw new Error(`meeting_prefs backfill: ${key} is geen object — onleesbaar telt niet als leeg`);
            }
            scanned += 1;
            for (const [field, idKind] of src.fields) {
                for (const externalId of asStrArray(doc[field])) {
                    inserted += await _insertExclusion({
                        provider: src.provider,
                        idKind,
                        externalId,
                        userId: src.scope === 'user' ? ownerId : '',
                        orgId: src.scope === 'org' ? ownerId : '',
                    });
                }
            }
        }
    }

    if (scanned === 0) {
        // Nothing seen is not the same as nothing found. No marker, so
        // the next boot looks again.
        return { skipped: false, scanned, inserted, marked: false };
    }
    await configStore.setConfig(BACKFILL_KEY, { completedAt: new Date().toISOString(), scanned, inserted });
    if (inserted > 0) log.info(`[MeetingPrefsStore] backfill: ${inserted} uitsluiting(en) overgenomen uit ${scanned} instellingendocument(en)`);
    return { skipped: false, scanned, inserted, marked: true };
}

/**
 * One exclusion row. Does NOT call initDB — it runs that itself internally.
 * ON CONFLICT DO NOTHING: a row that already exists (e.g. because the user has
 * chosen again since the previous attempt) beats the old value.
 * @param {{ provider: string, idKind: string, externalId: string, userId: string, orgId: string }} row
 */
async function _insertExclusion({ provider, idKind, externalId, userId, orgId }) {
    const res = await run(
        `INSERT INTO meeting_prefs (provider, id_kind, external_id, user_id, org_id, record, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, FALSE, NOW(), $6)
         ON CONFLICT (provider, id_kind, external_id, user_id, org_id) DO NOTHING`,
        [provider, idKind, externalId, userId, orgId, 'backfill'],
    );
    return res && res.rowCount ? res.rowCount : 0;
}

// ── lezen ────────────────────────────────────────────────────────────

/**
 * The preference rows that apply for THIS user: their own rows plus the
 * org-wide rows of their org. Never those of anyone else.
 *
 * @param {{provider?: string, userId?: string|null, orgId?: string|null}} [args]
 * @returns {Promise<PrefRow[]>}
 */
async function listPrefs({ provider, userId = null, orgId = null } = {}) {
    const p = normProvider(provider);
    const uid = normId(userId);
    const oid = normId(orgId);
    if (!p) return [];
    if (!uid && !oid) return [];   // scopes to nobody → yields nothing, not everything
    await initDB();

    /** @type {string[]} */
    const params = [p];
    /** @type {string[]} */
    const scopes = [];
    if (uid) { params.push(uid); scopes.push(`user_id = $${params.length}`); }
    if (oid) { params.push(oid); scopes.push(`(user_id = '' AND org_id = $${params.length})`); }
    const rows = await getAll(
        `SELECT provider, id_kind, external_id, user_id, org_id, tags, record, updated_at, updated_by
           FROM meeting_prefs
          WHERE provider = $1 AND (${scopes.join(' OR ')})`,
        params,
    );
    return (rows || []).map(mapRow);
}

/**
 * De expliciete mening over één vergadering, uit al geladen rijen.
 * Puur — geen database.
 *
 * @param {PrefRow[]} rows
 * @param {PrefIdInput | Array<PrefIdInput | null | undefined> | null | undefined} ids
 * @returns {{record: true|false|null, tags: string[]}} record NULL = geen mening.
 */
function resolvePrefs(rows, ids) {
    const wanted = normalizeIds(ids);
    /** @type {{ record: boolean | null, tags: string[] }} */
    const out = { record: null, tags: [] };
    if (!wanted.length) return out;

    const list = Array.isArray(rows) ? rows : [];
    let sawTrue = false;
    /** @type {string[]} */
    const tags = [];
    // In de volgorde van `ids`, dus meest specifiek eerst — dat bepaalt de
    // tagvolgorde. Voor `record` telt volgorde niet: één FALSE wint altijd.
    for (const want of wanted) {
        for (const row of list) {
            if (!row || row.idKind !== want.kind || row.externalId !== want.id) continue;
            if (row.record === false) out.record = false;
            else if (row.record === true) sawTrue = true;
            for (const tag of parseTags(row.tags)) if (!tags.includes(tag)) tags.push(tag);
        }
    }
    if (out.record !== false && sawTrue) out.record = true;
    out.tags = tags;
    return out;
}

/**
 * Number of participants for the 1-on-1 default, or NULL if it is not known.
 *
 * Accepts a calendar meeting from either provider (`attendees[]` +
 * organizer) or an explicit `participantCount`. An EMPTY participant list
 * yields NULL: that means "the calendar told us nothing", not "zero people".
 * Only a real, finite, non-negative count counts as known — a string like '3'
 * does not, because guessing here is the same as fail-open.
 *
 * @param {number | null | undefined | {
 *   participantCount?: number | null,
 *   attendees?: Array<string | { email?: string, cn?: string, displayName?: string, name?: string } | null>,
 *   organizerEmail?: string,
 *   organizer?: string | { email?: string, cn?: string },
 * }} meeting
 */
function participantCountOf(meeting) {
    if (meeting == null) return null;
    if (typeof meeting === 'number') return Number.isFinite(meeting) && meeting >= 0 ? Math.floor(meeting) : null;
    if (typeof meeting !== 'object') return null;
    if (meeting.participantCount !== undefined && meeting.participantCount !== null) {
        const n = meeting.participantCount;
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    }
    if (!Array.isArray(meeting.attendees)) return null;

    const ids = new Set();
    let anon = 0;
    for (const a of meeting.attendees) {
        const ident = a && typeof a === 'object'
            ? (a.email || a.cn || a.displayName || a.name || null)
            : (typeof a === 'string' ? a : null);
        if (ident) ids.add(String(ident).trim().toLowerCase());
        else anon += 1;   // a participant without a name is still a participant
    }
    const organizer = meeting.organizerEmail
        || (meeting.organizer && typeof meeting.organizer === 'object' ? (meeting.organizer.email || meeting.organizer.cn) : meeting.organizer);
    if (organizer) ids.add(String(organizer).trim().toLowerCase());

    const total = ids.size + anon;
    return total > 0 ? total : null;
}

/**
 * Should this meeting be recorded?
 *
 * @param {object} [args]
 * @param {Array} [args.rows]             rows from listPrefs (or loadMeetingPrefs)
 * @param {Array} [args.ids]              [{kind, id}] of this meeting
 * @param {number|null} [args.participantCount]  NULL/undefined = unknown
 * @param {boolean} [args.fallback]       the global autoRecord/autoImport setting
 * @returns {{record: boolean, reason: string}}
 *   reason: opted_out | opted_in | small_meeting | unknown_size | auto | auto_off
 */
function decideRecord({ rows = [], ids = [], participantCount = null, fallback = false } = {}) {
    const { record: opinion } = resolvePrefs(rows, ids);
    if (opinion === false) return { record: false, reason: 'opted_out' };
    if (opinion === true) return { record: true, reason: 'opted_in' };

    const n = participantCountOf({ participantCount });
    // Unknown is not "more than two". It narrows, just like two participants do.
    if (n === null) return { record: false, reason: 'unknown_size' };
    if (n <= SMALL_MEETING_MAX) return { record: false, reason: 'small_meeting' };
    return fallback ? { record: true, reason: 'auto' } : { record: false, reason: 'auto_off' };
}

/**
 * Load one user's preferences for one provider and wrap a small
 * decider around them. One query per list of meetings, not one per row.
 * @param {{ provider?: string, userId?: string|null, orgId?: string|null }} [opts]
 */
async function loadMeetingPrefs({ provider, userId = null, orgId = null } = {}) {
    const rows = await listPrefs({ provider, userId, orgId });
    return {
        rows,
        /**
         * De expliciete mening: true | false | null (geen mening).
         * @param {PrefIdInput | Array<PrefIdInput | null | undefined> | null | undefined} ids
         */
        opinionFor(ids) { return resolvePrefs(rows, ids).record; },
        /**
         * De tags die op deze vergadering staan (unie, meest specifieke eerst).
         * @param {PrefIdInput | Array<PrefIdInput | null | undefined> | null | undefined} ids
         */
        tagsFor(ids) { return resolvePrefs(rows, ids).tags; },
        /** Volledige beslissing inclusief de 1-op-1-standaard. */
        /** @param {{ ids?: Array<{kind: string, id: string}>, participantCount?: number|null, fallback?: boolean }} [opts] */
        decide({ ids, participantCount = null, fallback = false } = {}) {
            return decideRecord({ rows, ids, participantCount, fallback });
        },
    };
}

// ── schrijven ────────────────────────────────────────────────────────

/**
 * Determine the scope of a write action. Exactly one of two: a personal
 * row (user_id set, org_id '') or an org-wide row. The CHECK
 * in the schema enforces the same, so the same preference can never exist as
 * two rows.
 * @param {string | null | undefined} userId
 * @param {string | null | undefined} orgId
 */
function _scopeOf(userId, orgId) {
    const uid = normId(userId);
    const oid = normId(orgId);
    if (uid) return { userId: uid, orgId: '' };
    if (oid) return { userId: '', orgId: oid };
    throw new Error('meetingPrefsStore: een voorkeur heeft een userId of een orgId nodig');
}

/**
 * Set the recording preference for one meeting. `record` may be TRUE, FALSE or NULL;
 * NULL clears the opinion (back to inheriting) without touching the tags.
 * Writes one row per supplied identity.
 *
 * @returns {Promise<number>} number of rows written
 * @param {{ provider?: string, ids?: Array<{kind: string, id: string}>, userId?: string|null, orgId?: string|null, record?: boolean|null, updatedBy?: string|null }} [opts]
 */
async function setRecord({ provider, ids, userId = null, orgId = null, record, updatedBy = null } = {}) {
    const p = normProvider(provider);
    if (!p) throw new Error(`meetingPrefsStore: onbekende provider '${provider}'`);
    const wanted = normalizeIds(ids);
    if (!wanted.length) return 0;
    const scope = _scopeOf(userId, orgId);
    const value = record === true ? true : record === false ? false : null;
    await initDB();

    let written = 0;
    for (const { kind, id } of wanted) {
        const res = await run(
            `INSERT INTO meeting_prefs (provider, id_kind, external_id, user_id, org_id, record, updated_at, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
             ON CONFLICT (provider, id_kind, external_id, user_id, org_id)
             DO UPDATE SET record = EXCLUDED.record, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
            [p, kind, id, scope.userId, scope.orgId, value, updatedBy || scope.userId || scope.orgId || null],
        );
        written += res && res.rowCount ? res.rowCount : 0;
    }
    return written;
}

/**
 * Set the tags for one meeting. Does NOT touch `record` — a new row
 * gets `record NULL` (no opinion), so tag sets never silently make a
 * recording decision.
 * @param {{ provider?: string, ids?: Array<{kind: string, id: string}>, userId?: string|null, orgId?: string|null, tags?: string[], updatedBy?: string|null }} [opts]
 */
async function setTags({ provider, ids, userId = null, orgId = null, tags = [], updatedBy = null } = {}) {
    const p = normProvider(provider);
    if (!p) throw new Error(`meetingPrefsStore: onbekende provider '${provider}'`);
    const wanted = normalizeIds(ids);
    if (!wanted.length) return 0;
    const scope = _scopeOf(userId, orgId);
    const clean = Array.from(new Set(asStrArray(tags)));
    await initDB();

    let written = 0;
    for (const { kind, id } of wanted) {
        const res = await run(
            `INSERT INTO meeting_prefs (provider, id_kind, external_id, user_id, org_id, tags, updated_at, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), $7)
             ON CONFLICT (provider, id_kind, external_id, user_id, org_id)
             DO UPDATE SET tags = EXCLUDED.tags, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
            [p, kind, id, scope.userId, scope.orgId, JSON.stringify(clean), updatedBy || scope.userId || scope.orgId || null],
        );
        written += res && res.rowCount ? res.rowCount : 0;
    }
    return written;
}

module.exports = {
    PROVIDERS,
    ID_KINDS,
    SMALL_MEETING_MAX,
    BACKFILL_KEY,
    initDB,
    // lezen
    listPrefs,
    loadMeetingPrefs,
    resolvePrefs,
    decideRecord,
    participantCountOf,
    talkIds,
    gmeetIds,
    teamsIds,
    // schrijven
    setRecord,
    setTags,
    backfillFromExclusions,
};
