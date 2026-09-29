// @typecheck
/**
 * Meeting prefs — per-vergadering opnamevoorkeur en tags (M5, "Gepland & regels").
 *
 * Dit is de VERHUIZING van de opname-uitsluiting, geen tweede waarheid. Tot nu
 * toe leefde "niet opnemen" als vier string-arrays in vier configStore-docs:
 *   org_talk_notes_<orgId>  / user_talk_notes_<userId>   → excludedRoomTokens[], excludedEventUids[]
 *   org_gmeet_notes_<orgId> / user_gmeet_notes_<userId>  → excludedMeetingCodes[], excludedEventIds[]
 * Aanwezigheid in zo'n array betekende "niet opnemen"; er was geen positieve
 * waarde, dus "aan" en "nooit een mening gehad" waren hetzelfde. Deze tabel
 * neemt die rol over, `backfillFromExclusions()` haalt de bestaande
 * uitsluitingen op, en de oude arrays worden niet meer gelezen. Ze blijven wél
 * staan: een rollback naar de vorige image moet de uitsluitingen nog vinden.
 *
 * ── VORM ──────────────────────────────────────────────────────────────
 *   meeting_prefs(provider, id_kind, external_id, user_id, org_id, tags, record)
 *
 *   provider     'talk' | 'gmeet' — hetzelfde label dat de Gepland-lijst toont.
 *   id_kind      'room' | 'event' | 'code'. Eén provider heeft TWEE id-ruimtes:
 *                Talk een roomToken (de ruimte, elke call daarin) en een
 *                eventUid (één agenda-occurrence); Meet een meetingCode (de
 *                serie) en een eventId (één occurrence). Zonder id_kind zouden
 *                een roomToken en een eventUid in dezelfde sleutel botsen en
 *                zou een uitsluiting op de één die van de ander worden.
 *   user_id      de eigenaar van de voorkeur; '' = org-brede regel.
 *   org_id       '' = persoonlijke regel. De CHECK dwingt af dat precies één
 *                van de twee gevuld is, zodat dezelfde voorkeur nooit als twee
 *                rijen kan bestaan. '' i.p.v. NULL omdat NULL in een sleutel
 *                niet botst (zelfde reden als skill_activations.agent_id).
 *   record       DRIEWAARDIG: TRUE = wel opnemen, FALSE = niet opnemen,
 *                NULL/geen rij = geen mening → erven. Dat derde geval is geen
 *                luxe: zonder NULL zou de backfill voor élke niet-uitgesloten
 *                vergadering een `true` moeten schrijven en dan bevriest hij de
 *                globale autoRecord/autoImport-schakelaar op zijn stand van nu.
 *   tags         de tags die de notitie krijgt die hier straks uit komt. Nieuw;
 *                de oude opslag had er geen bron voor, dus dit begint leeg. Let
 *                op: dit is iets ANDERS dan de tags op een bestaande notitie
 *                (GET /api/transcriptions/tags) — die hangen aan het resultaat,
 *                deze aan de afspraak.
 *
 * ── DE RIJ IS PER GEBRUIKER ───────────────────────────────────────────
 * Twee deelnemers aan dezelfde vergadering hebben elk hun eigen rij en mogen
 * verschillend beslissen. `listPrefs` filtert daarom op `user_id = $n` (exact,
 * nooit een LIKE of een OR die andermans rij binnenlaat) en op org-rijen alleen
 * via `user_id = '' AND org_id = $n`. Een aanroep zónder userId én zónder orgId
 * levert [] — een filter dat naar niemand scoopt geeft niets terug in plaats
 * van alles (zelfde regel als automationStore.buildRunFilterWhere).
 *
 * ── DE 1-OP-1-STANDAARD ───────────────────────────────────────────────
 * Bij ten hoogste twee deelnemers is `record` standaard FALSE: een
 * één-op-één-gesprek is zelden een vergadering en vaak het gevoeligste wat er
 * op de agenda staat. "Twee deelnemers" en "aantal onbekend" zijn daarbij niet
 * hetzelfde, maar onbekend VERSMALT: het telt niet als "meer dan twee", dus ook
 * dan blijft de standaard FALSE. Alleen een GEKEND aantal boven de twee laat de
 * globale schakelaar (`fallback`) beslissen. Een expliciete voorkeur wint altijd
 * van deze standaard — dat is precies waarvoor `record = TRUE` bestaat.
 *
 * ── UITSLUITING VERSMALT ──────────────────────────────────────────────
 * Raken er meerdere rijen aan dezelfde vergadering (org + user, of ruimte +
 * occurrence), dan wint één enkele FALSE. Dat is exact wat de oude unie van
 * org- en user-arrays deed: een org kon uitsluiten en een gebruiker kon daar
 * niet omheen. Pas als geen enkele rakende rij FALSE zegt, telt een TRUE.
 */

'use strict';

const { run, getAll } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');

const PROVIDERS = Object.freeze(['talk', 'gmeet']);
const ID_KINDS = Object.freeze(['room', 'event', 'code']);

/** Tot en met dit aantal deelnemers is opnemen standaard UIT. */
const SMALL_MEETING_MAX = 2;

/** configStore-sleutel die zegt dat de eenmalige backfill klaar is. */
const BACKFILL_KEY = 'meeting_prefs_backfill_v1';

/**
 * De vier oude uitsluitdocumenten, met per document welk veld op welke
 * id-ruimte slaat. Dit is de ENIGE plek die de oude vorm nog kent.
 */
const LEGACY_SOURCES = Object.freeze([
    { prefix: 'user_talk_notes_', provider: 'talk', scope: 'user', fields: [['excludedEventUids', 'event'], ['excludedRoomTokens', 'room']] },
    { prefix: 'org_talk_notes_', provider: 'talk', scope: 'org', fields: [['excludedEventUids', 'event'], ['excludedRoomTokens', 'room']] },
    { prefix: 'user_gmeet_notes_', provider: 'gmeet', scope: 'user', fields: [['excludedEventIds', 'event'], ['excludedMeetingCodes', 'code']] },
    { prefix: 'org_gmeet_notes_', provider: 'gmeet', scope: 'org', fields: [['excludedEventIds', 'event'], ['excludedMeetingCodes', 'code']] },
]);

// ── kleine normalisatoren ────────────────────────────────────────────
function normProvider(v) { return PROVIDERS.includes(v) ? v : null; }
function normKind(v) { return ID_KINDS.includes(v) ? v : null; }
function normId(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function asStrArray(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []; }

/** JSONB komt terug als array (pg parst jsonb) of als string (sommige facades). */
function parseTags(v) {
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    if (typeof v === 'string') {
        try { return parseTags(JSON.parse(v)); } catch (_) { return []; }
    }
    return [];
}

function mapRow(r) {
    if (!r) return null;
    return {
        provider: r.provider,
        idKind: r.id_kind,
        externalId: r.external_id,
        userId: r.user_id || null,
        orgId: r.org_id || null,
        tags: parseTags(r.tags),
        // Alleen een echte boolean is een mening; alles anders is "geen mening".
        record: r.record === true ? true : r.record === false ? false : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        updatedBy: r.updated_by || null,
    };
}

/**
 * Normaliseer een lijst identiteiten. Accepteert [{kind, id}] en gooit lege of
 * onbekende soorten weg. Volgorde blijft behouden: bel met de MEEST SPECIFIEKE
 * eerst (occurrence vóór ruimte/serie) — tags worden in die volgorde verzameld.
 */
function normalizeIds(ids) {
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

/** Talk-identiteiten van een vergadering, meest specifiek eerst. */
function talkIds({ eventUid = null, roomToken = null } = {}) {
    return normalizeIds([{ kind: 'event', id: eventUid }, { kind: 'room', id: roomToken }]);
}

/** Google Meet-identiteiten van een vergadering, meest specifiek eerst. */
function gmeetIds({ eventId = null, meetingCode = null } = {}) {
    return normalizeIds([{ kind: 'event', id: eventId }, { kind: 'code', id: meetingCode }]);
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
    // runDdl meldt SQLSTATE-fouten terug i.p.v. te gooien. Hier is dat niet
    // genoeg: op een half aangelegd schema zou elke lees stilletjes leeg
    // teruggeven — en leeg betekent hier "niemand heeft opnemen uitgezet".
    if (res.failures.length) {
        throw new Error(`meeting_prefs DDL faalde (${res.failures.map(f => f.code).join(', ')}) — zie de [DDL:meetingPrefsStore]-regels`);
    }
    // De backfill hoort BINNEN de init-belofte: elke publieke functie wacht op
    // initDB(), dus geen enkele lezer kan de tabel zien vóór de bestaande
    // uitsluitingen erin staan. Andersom zou een lees in dat venster "geen
    // mening" lezen en dus opnemen wat iemand had uitgezet.
    await backfillFromExclusions();
});

/**
 * Haal de bestaande uitsluitingen uit de vier configStore-documenten en schrijf
 * ze als `record = FALSE`-rijen. Idempotent (ON CONFLICT DO NOTHING) en niet
 * destructief: de oude velden blijven staan.
 *
 * ALLEEN uitsluitingen. Voor vergaderingen die er niet in staan wordt niets
 * geschreven — een `record = true`-rij zou de globale schakelaar bevriezen.
 *
 * Faalt luid. Eén onleesbaar document laat de hele backfill (en daarmee de
 * store-init) falen in plaats van die gebruiker over te slaan: overslaan zou
 * betekenen dat diens uitsluiting stilzwijgend verdwijnt, en dat is precies de
 * fout die deze verhuizing niet mag maken. De init-memo probeert het opnieuw.
 *
 * ── EEN LEGE SCAN IS GEEN BEWIJS ─────────────────────────────────────
 * De marker wordt alleen gezet als de scan ook echt IETS heeft gezien. Voor
 * één document gold dat onderscheid al (onleesbaar ≠ leeg); voor de
 * VERZAMELING gold het niet, en daar zit een echte race: `migrateConfigJson()`
 * in configStore is fire-and-forget (niets await het) en schrijft een
 * achtergebleven data/config.json rij voor rij weg. Draait deze backfill in
 * dat venster, dan levert `listKeysWithPrefix` nul sleutels — en met een
 * onvoorwaardelijke marker sloeg élke latere boot de scan over en waren die
 * uitsluitingen voorgoed weg. Dat is exact de FALSE→TRUE die deze verhuizing
 * niet mag maken, dus: geen documenten gezien = niets bewezen = geen marker.
 * De prijs is vier prefix-scans (index-range reads die niets teruggeven) per
 * boot op een installatie die werkelijk geen vergaderinstellingen heeft.
 *
 * Handmatige herstelweg, als de marker tóch te vroeg blijkt te staan:
 *   node -e "require('./stores/meetingPrefsStore').backfillFromExclusions({force:true}).then(console.log)"
 * (vanuit server/ — `force` slaat de markercontrole over en herleest alles).
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
            // Geen document = niets uit te sluiten. Een document dat GEEN object
            // is, is onleesbaar — en onleesbaar is iets anders dan leeg.
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
        // Niets gezien is niet hetzelfde als niets te vinden. Geen marker, dus
        // de volgende boot kijkt opnieuw.
        return { skipped: false, scanned, inserted, marked: false };
    }
    await configStore.setConfig(BACKFILL_KEY, { completedAt: new Date().toISOString(), scanned, inserted });
    if (inserted > 0) log.info(`[MeetingPrefsStore] backfill: ${inserted} uitsluiting(en) overgenomen uit ${scanned} instellingendocument(en)`);
    return { skipped: false, scanned, inserted, marked: true };
}

/**
 * Eén uitsluitingsrij. Roept GEEN initDB aan — hij draait er zelf binnenin.
 * ON CONFLICT DO NOTHING: een rij die er al staat (bv. omdat de gebruiker sinds
 * de vorige poging opnieuw heeft gekozen) wint van de oude waarde.
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
 * De voorkeurrijen die voor DEZE gebruiker gelden: zijn eigen rijen plus de
 * org-brede rijen van zijn org. Nooit die van iemand anders.
 *
 * @param {{provider?: string, userId?: string|null, orgId?: string|null}} [args]
 * @returns {Promise<Array<{provider,idKind,externalId,userId,orgId,tags,record}>>}
 */
async function listPrefs({ provider, userId = null, orgId = null } = {}) {
    const p = normProvider(provider);
    const uid = normId(userId);
    const oid = normId(orgId);
    if (!p) return [];
    if (!uid && !oid) return [];   // scoopt naar niemand → levert niets, niet alles
    await initDB();

    const params = [p];
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
 * @returns {{record: true|false|null, tags: string[]}} record NULL = geen mening.
 */
function resolvePrefs(rows, ids) {
    const wanted = normalizeIds(ids);
    const out = { record: null, tags: [] };
    if (!wanted.length) return out;

    const list = Array.isArray(rows) ? rows : [];
    let sawTrue = false;
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
 * Aantal deelnemers voor de 1-op-1-standaard, of NULL als het niet te weten is.
 *
 * Accepteert een agenda-vergadering van beide providers (`attendees[]` +
 * organisator) of een expliciete `participantCount`. Een LEGE deelnemerslijst
 * levert NULL: dat is "de agenda vertelde ons niets", niet "nul mensen".
 * Alleen een echte, eindige, niet-negatieve telling geldt als bekend — een
 * string als '3' niet, want gokken is hier hetzelfde als fail-open.
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
        else anon += 1;   // een deelnemer zonder naam is nog steeds een deelnemer
    }
    const organizer = meeting.organizerEmail
        || (meeting.organizer && typeof meeting.organizer === 'object' ? (meeting.organizer.email || meeting.organizer.cn) : meeting.organizer);
    if (organizer) ids.add(String(organizer).trim().toLowerCase());

    const total = ids.size + anon;
    return total > 0 ? total : null;
}

/**
 * Moet deze vergadering opgenomen worden?
 *
 * @param {object} [args]
 * @param {Array} [args.rows]             rijen uit listPrefs (of loadMeetingPrefs)
 * @param {Array} [args.ids]              [{kind, id}] van deze vergadering
 * @param {number|null} [args.participantCount]  NULL/undefined = onbekend
 * @param {boolean} [args.fallback]       de globale autoRecord/autoImport-stand
 * @returns {{record: boolean, reason: string}}
 *   reason: opted_out | opted_in | small_meeting | unknown_size | auto | auto_off
 */
function decideRecord({ rows = [], ids = [], participantCount = null, fallback = false } = {}) {
    const { record: opinion } = resolvePrefs(rows, ids);
    if (opinion === false) return { record: false, reason: 'opted_out' };
    if (opinion === true) return { record: true, reason: 'opted_in' };

    const n = participantCountOf({ participantCount });
    // Onbekend is niet "meer dan twee". Het versmalt, net als twee deelnemers.
    if (n === null) return { record: false, reason: 'unknown_size' };
    if (n <= SMALL_MEETING_MAX) return { record: false, reason: 'small_meeting' };
    return fallback ? { record: true, reason: 'auto' } : { record: false, reason: 'auto_off' };
}

/**
 * Laad de voorkeuren van één gebruiker voor één provider en geef er een kleine
 * beslisser omheen. Eén query per lijst vergaderingen, niet één per rij.
 * @param {{ provider?: string, userId?: string|null, orgId?: string|null }} [opts]
 */
async function loadMeetingPrefs({ provider, userId = null, orgId = null } = {}) {
    const rows = await listPrefs({ provider, userId, orgId });
    return {
        rows,
        /** De expliciete mening: true | false | null (geen mening). */
        opinionFor(ids) { return resolvePrefs(rows, ids).record; },
        /** De tags die op deze vergadering staan (unie, meest specifieke eerst). */
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
 * Bepaal de scope van een schrijfactie. Precies één van beide: een
 * persoonlijke rij (user_id gevuld, org_id '') of een org-brede rij. De CHECK
 * in het schema dwingt hetzelfde af, zodat dezelfde voorkeur nooit als twee
 * rijen kan bestaan.
 */
function _scopeOf(userId, orgId) {
    const uid = normId(userId);
    const oid = normId(orgId);
    if (uid) return { userId: uid, orgId: '' };
    if (oid) return { userId: '', orgId: oid };
    throw new Error('meetingPrefsStore: een voorkeur heeft een userId of een orgId nodig');
}

/**
 * Zet de opnamevoorkeur voor één vergadering. `record` mag TRUE, FALSE of NULL
 * zijn; NULL wist de mening (terug naar erven) zonder de tags aan te raken.
 * Schrijft één rij per meegegeven identiteit.
 *
 * @returns {Promise<number>} aantal geschreven rijen
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
 * Zet de tags voor één vergadering. Raakt `record` NIET aan — een nieuwe rij
 * krijgt `record NULL` (geen mening), zodat tagsetten nooit stilletjes een
 * opnamekeuze maakt.
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
    // schrijven
    setRecord,
    setTags,
    backfillFromExclusions,
};
