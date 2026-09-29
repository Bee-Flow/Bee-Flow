// @typecheck
/**
 * "What happens to this meeting?" — and, the same question read backwards,
 * "what breaks if I delete it?" (Bee Flow Builder redesign, Sep 2026, M2).
 *
 * ── ONE DERIVATION, THREE SURFACES ──────────────────────────────────
 * The bar under the tag row, the Used-by tab and the 409 on DELETE all show
 * this list. They are the same question asked in three places, so they are
 * one function: a bar that says a knowledge base is fed by this meeting while
 * the delete dialog says nothing depends on it is worse than either screen
 * being absent.
 *
 * ── NO LINK TABLE, ON PURPOSE ───────────────────────────────────────
 * Nothing "attaches" a meeting to a consumer. A knowledge source watches a
 * TAG, a routine subscribes to an EVENT with a filter, a notebook copied the
 * text once. A link table would have to be written from four places that all
 * already store the truth somewhere else, and the copy that fell behind is
 * exactly the one that would answer "nothing depends on this".
 *
 * ── A SCAN THAT CANNOT ANSWER IS NOT AN EMPTY SCAN ──────────────────
 * `partial` names the kinds that could not be answered — a table or a column
 * that is not on this install, or a query that threw. Callers MUST treat a
 * non-empty `partial` as "I do not know", never as "nothing": the delete
 * guard reads an empty list as permission to remove a meeting that three
 * things still use, and that is unrecoverable. This is the fail-closed point
 * of the whole module.
 *
 * ── THE ROWS ARE THE Used-by CONTRACT ───────────────────────────────
 * `{ kind, id, title, role, siteLabel, lastAt, ownerId }` — what
 * `shared/UsedByTab.jsx` renders and `shared/DangerZone.jsx` counts.
 *
 * ── TWO THINGS THAT LOOK LIKE BUGS AND ARE NOT ──────────────────────
 *
 * 1. THE PROVIDER ID IS `meeting-notes`, WITH A HYPHEN. The spec says
 *    `meeting_notes` in three places; `triggerSources/validate.js`'s
 *    PROVIDER_ID_RE rejects underscores outright, which is why an earlier
 *    attempt at this provider never registered at all. The underscore form
 *    survives only as the CAPABILITY name (`availability.check`). Anything
 *    here that asks for `meeting_notes` finds nothing, silently.
 *
 * 2. THE TAG FILTER IS THE BUS'S, NOT THIS MODULE'S. Until M5 there was no
 *    meeting-notes branch in `triggerBus/filters.js`, so `pickMatcher`
 *    returned the shallow generic `matchFilter` — against which
 *    `{tags:'sales'}` and `{tagIncludes:'sales'}` were FALSE for a payload of
 *    `{tags:['sales','klant']}`, and only an empty filter (or the DSL escape
 *    `expr:`) fired. `matchMeetingProcessedFilter` now answers `tags` and
 *    `reprocessed`, hands every other key back to `matchFilter`, and an empty
 *    tag list means EVERY finished note. So a routine with `{tags:['sales']}`
 *    now really does fire, and this list now really does name it.
 *    None of that needed an edit here, and that is the point: the scan runs
 *    the stored filter through `pickMatcher` + `applyDslFilter` — the exact
 *    pair `dispatch.js` builds — rather than comparing tags itself. A list
 *    built on its own tag rules would show routines that never run, or hide
 *    routines that do. The next change to the matcher lands here for free too.
 *
 * ── THE FAN-OUT IS OWNER-ONLY, WHATEVER THE DECLARATION SAYS ────────
 * `declared/meeting-notes.js` declares `scope: 'org'`, but
 * `emitMeetingProcessed` always passes the owner's `userId` and
 * `triggerBus/dispatch.js` then skips every subscription belonging to anyone
 * else. A colleague's routine on tag `sales` never fires on my meeting. The
 * automation scan is therefore scoped to the meeting's OWNER — showing the
 * org's routines would be a list of things that will not happen. If the
 * dispatch is ever widened to the declared org scope, widen this with it;
 * changing one without the other makes the bar untrue in one direction or
 * the other.
 */

const { pool } = require('../../db');
const log = require('../../telemetry/log');

/** Every kind this can find, in the order the bar and the Used-by tab list them. */
const KINDS = Object.freeze(['kb', 'automation', 'notebook']);

/** The provider/event the meeting bus actually speaks. Hyphen — see the header. */
const MEETING_PROVIDER = 'meeting-notes';
const MEETING_EVENT = 'meeting.processed';

/**
 * The `config` key a per-meeting `meeting` knowledge source stores its id in.
 *
 * The kind does not exist yet — `kb_sources.kind` has `meeting_tag` and no
 * `meeting`, and adding one needs an ALTER of the inline CHECK constraint on
 * every existing database, which is outside this stage's reach. The scan
 * below already looks for it so that landing the kind is a one-file change
 * and not a hunt for every place that would have had to learn about it.
 * Exported so the creating route and this reader cannot pick different keys —
 * a mismatch here returns EMPTY, which is the fail-open this module exists to
 * prevent.
 */
const MEETING_SOURCE_CONFIG_KEY = 'meetingId';

/**
 * Waar een met de hand gefileerde transcriptregel zijn herkomst bewaart (M4).
 *
 * Eén expressie, twee lezers: de scan hieronder telt de regels, en
 * `filedTranscriptSources` haalt ze weg als de eigenaar van de vergadering
 * opruimt. Een tweede, met de hand overgetypte JSON-pad is precies hoe die
 * twee gaan verschillen — en dan telt het ene scherm een regel die het andere
 * niet kan verwijderen.
 */
const FILED_LINE_ORIGIN_SQL = `s.config->'metadata'->>'transcriptionId'`;

async function tableExists(name, client) {
    try {
        const r = await (client || pool).query('SELECT to_regclass($1) AS t', [name]);
        return !!r.rows[0]?.t;
    } catch (_) {
        return false;
    }
}

/**
 * Does `table` have `column` on THIS database?
 *
 * Via `pg_attribute` keyed on `to_regclass`, not `information_schema.columns`
 * filtered by name: the latter matches a same-named table in any schema on
 * the search path, so it can answer "yes" about a table this connection will
 * never read. Both a missing table and a missing column answer false, and so
 * does a probe that throws — every one of those is "I could not check", which
 * the caller records as `partial`.
 */
async function columnExists(table, column, client) {
    try {
        const r = await (client || pool).query(
            `SELECT 1 FROM pg_attribute
              WHERE attrelid = to_regclass($1) AND attname = $2
                AND attnum > 0 AND NOT attisdropped
              LIMIT 1`,
            [table, column],
        );
        return (r.rows || []).length > 0;
    } catch (_) {
        return false;
    }
}

/**
 * Tags, exactly as every other tag consumer sees them.
 *
 * NOTHING in this product normalises a meeting tag. `PATCH /:id` writes
 * `req.body.tags` straight through with no validation, the chip editor only
 * `.trim()`s, `armMeetingSources` compares with `config->>'tag' = ANY($1)`
 * and `listByTag` with jsonb containment of `'["sales"]'` in `tags`. So `Sales`, `sales` and
 * `' sales'` are three different tags to the arming query, and they have to
 * be three different tags here too — lower-casing or trimming in this one
 * place would make the bar claim a knowledge base is fed by a meeting whose
 * tag that base's query will never match.
 *
 * Only non-empty strings survive: the column is unvalidated JSONB, so a
 * number, an object or `null` can be in there, and an empty string would
 * match a source whose tag was saved empty by the same absent validation.
 */
function tagsOf(meeting) {
    const raw = Array.isArray(meeting?.tags) ? meeting.tags : [];
    const seen = new Set();
    for (const t of raw) {
        if (typeof t !== 'string') continue;
        if (t === '') continue;
        seen.add(t);
    }
    return [...seen];
}

/** Every app_event trigger on a definition — the primary one and `triggers[]`. */
function appEventTriggersOf(definition) {
    const all = [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition.triggers : [])];
    return all.filter(t => t && t.kind === 'app_event' && t.appEvent?.provider && t.appEvent?.event);
}

/** The meeting-notes triggers on a definition, in definition order. */
function meetingTriggersOf(definition) {
    return appEventTriggersOf(definition)
        .filter(t => t.appEvent.provider === MEETING_PROVIDER && t.appEvent.event === MEETING_EVENT);
}

/**
 * The payload a dispatch would actually carry for this meeting.
 *
 * Byte-for-byte the shape `emitMeetingProcessed` builds, minus `reprocessed`:
 * a filter that only wants first ingests (`{reprocessed: false}` — whatever
 * a future matcher makes of that) must not be counted in because we invented
 * a re-run that is not happening. Deliberately NOT the summary, the title or
 * the attendees — this object is handed to tenant-written filter expressions
 * and BFSF-441 keeps personal data out of anything that leaves the note.
 */
function syntheticPayload(meeting) {
    return {
        transcriptionId: meeting?.id != null ? String(meeting.id) : null,
        tags: tagsOf(meeting),
        orgId: meeting?.organizationId || null,
    };
}

/**
 * Would this trigger's stored filter fire on this meeting?
 *
 * Runs the REAL dispatch path — `pickMatcher(provider, event)` wrapped in
 * `applyDslFilter`, the exact pair `dispatch.js` builds — so the list and the
 * bus cannot disagree. Returns `null` when the matcher could not decide,
 * which the caller records as `partial` rather than as "no".
 */
function triggerFires(trigger, payload) {
    try {
        const { pickMatcher } = require('../../automation/triggerBus/filters');
        const { applyDslFilter } = require('../../automation/triggers/dslFilters');
        const base = pickMatcher(MEETING_PROVIDER, MEETING_EVENT);
        return applyDslFilter(payload, trigger?.appEvent?.filter ?? null, base) === true;
    } catch (e) {
        log.warn('[MeetingUsage] filter could not be evaluated:', e.message);
        return null;
    }
}

/**
 * What a row says about WHEN a routine fires: `{ siteLabel?, unfiltered? }`.
 *
 * Describes what was CONFIGURED; `triggerFires` decides whether it matches.
 * Two deliberate restraints:
 *   - no English sentence is minted here. "on every meeting" is a phrase the
 *     screen owns and translates; the server says `unfiltered: true` and lets
 *     it. A server-built label arrives untranslated in every locale, and
 *     `UsedByTab` renders `siteLabel` verbatim.
 *   - the only text that travels is the tenant's OWN — the tags they typed,
 *     or their `expr` string — capped. Never a minted English sentence.
 *
 * A tag filter gets a label now that it really fires (M5): a row in Used-by
 * with no word about WHY it is there is the one row in that list nobody can
 * check, and `UsedByTab` renders nothing when `siteLabel` is absent. The tags
 * are the tenant's own strings, so the `expr` rule already covers them.
 */
function triggerLabel(trigger) {
    const f = trigger?.appEvent?.filter;
    if (!f || typeof f !== 'object' || Object.keys(f).length === 0) return { unfiltered: true };
    if (typeof f.expr === 'string' && f.expr.trim()) return { siteLabel: f.expr.trim().slice(0, 80) };
    const tags = Array.isArray(f.tags) ? f.tags : (typeof f.tags === 'string' ? [f.tags] : []);
    const clean = tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim());
    if (clean.length) return { siteLabel: clean.join(', ').slice(0, 80) };
    return {};
}

/**
 * Knowledge sources that collect this meeting.
 *
 * THE TAG COMPARISON IS `armMeetingSources`'s, character for character
 * (`config->>'tag' = ANY($1::text[])`) — see `tagsOf` for why it may not be
 * loosened. What is deliberately NOT copied from that query is its
 * `refresh_mode = 'after_meeting'` clause: a `meeting_tag` source set to
 * `schedule` is not armed by the event but still ingests this meeting on its
 * next pass, so it belongs in "what happens to this meeting" even though it
 * does not belong in "what does this event wake".
 *
 * REACH IS NOT CHECKED, and that is a known widening. `meetingTag.enumerate`
 * reads meetings as the KB's OWNER, so a source in a colleague's base only
 * ingests this meeting if that colleague can already open it. Proving that
 * here would mean resolving every KB owner's orgs and groups on a screen
 * open. So a row states what is verifiable — this base COLLECTS this tag —
 * and the copy says exactly that rather than "contains this meeting".
 *
 * ── THE THIRD PREDICATE: LINES SOMEBODY FILED BY HAND (M4) ──────────
 * `POST /api/kb/:id/sources` with `kind:'text'` stores an allow-listed
 * `config.metadata = { transcriptionId, segmentIndex }` when the snippet came
 * from a transcript line (routes/knowledgeBases/sources.js `shapeTextOrigin`).
 * Those are read back here, so "2 knowledge lines → <KB>" is derived from the
 * SAME scan the outputs bar and the delete guard already use rather than from
 * a second query with its own idea of what counts. One row per knowledge
 * base, carrying `lineCount` — a NUMBER, never a minted English phrase, for
 * the same reason `unfiltered` is a flag: a label built here arrives
 * untranslated in every locale.
 */
async function scanKb(meeting, db) {
    const tags = tagsOf(meeting);
    const id = meeting?.id != null ? String(meeting.id) : null;

    // Three independent predicates, any of which may be absent: a meeting
    // with no tags has nothing for the first, and `kind = 'meeting'` is a kind
    // that does not exist yet (see MEETING_SOURCE_CONFIG_KEY). Built rather
    // than fixed so an empty tag list never reaches Postgres as
    // `= ANY('{}'::text[])`, which the sibling stores document as a `pg`
    // version trap.
    const where = [];
    const params = [];
    if (tags.length > 0) {
        params.push(tags);
        where.push(`(s.kind = 'meeting_tag' AND s.config->>'tag' = ANY($${params.length}::text[]))`);
    }
    if (id) {
        // The config KEY goes in as a bound parameter too. It is a module
        // constant today, but `jsonb ->> text` takes a placeholder perfectly
        // well and the habit is what stands between the next edit and a
        // concatenated identifier.
        params.push(MEETING_SOURCE_CONFIG_KEY);
        const keyIdx = params.length;
        params.push(id);
        where.push(`(s.kind = 'meeting' AND s.config->>$${keyIdx} = $${params.length})`);
        // The filed transcript lines. Same id, one level deeper, and matched
        // on `transcriptionId` ALONE: a source whose origin lost its
        // `segmentIndex` still came out of this meeting, and dropping it here
        // would under-report the count on the one screen that exists to say
        // where this transcript ended up.
        params.push(id);
        where.push(`(s.kind = 'text' AND ${FILED_LINE_ORIGIN_SQL} = $${params.length})`);
    }
    if (where.length === 0) return [];

    const sql = `SELECT s.id AS source_id, s.kind, s.config, s.updated_at AS last_at,
                        kb.id AS kb_id, kb.name AS kb_name, kb.tenant_id AS owner_id
                   FROM kb_sources s
                   JOIN knowledge_bases kb ON kb.id = s.knowledge_base_id
                  WHERE ${where.join(' OR ')}`;
    const r = await db.query(sql, params);

    const rows = [];
    // One row per knowledge base, not one per filed line: five snippets in
    // one base is one thing that holds part of this meeting, and five
    // identical chips would say nothing the count does not.
    const filed = new Map();
    for (const row of r.rows || []) {
        if (row.kind === 'text') {
            const current = filed.get(row.kb_id) || {
                kind: 'kb',
                id: row.kb_id,
                title: row.kb_name || null,
                role: 'contains',
                lineCount: 0,
                lastAt: null,
                ownerId: row.owner_id || null,
            };
            current.lineCount += 1;
            current.lastAt = latest(current.lastAt, row.last_at);
            filed.set(row.kb_id, current);
            continue;
        }
        rows.push({
            kind: 'kb',
            id: row.kb_id,
            title: row.kb_name || null,
            role: 'contains',
            // The tag the base watches — the fact that makes the row checkable.
            // A per-meeting source has no tag to name, so it says nothing.
            siteLabel: row.kind === 'meeting_tag' ? (readTag(row.config) || undefined) : undefined,
            lastAt: row.last_at || null,
            ownerId: row.owner_id || null,
        });
    }
    return [...rows, ...filed.values()];
}

/**
 * De gefileerde transcriptregels van één vergadering, adresseerbaar.
 *
 * `scanKb` klapt ze samen tot één rij per kennisbank met een aantal — precies
 * wat de drie schermen nodig hebben en precies wat je NIET kunt weghalen. Dit
 * is dezelfde verzameling rijen, één per bron, met wat een verwijdering nodig
 * heeft: welke bron, in welke kennisbank, van welke tenant.
 *
 * BEWUST ONGESCOPET, en dat is hier het punt: het gaat om regels die beweren
 * uit DEZE vergadering te komen, ongeacht in wiens kennisbank ze staan. De
 * bevoegdheid zit in de route erboven (alleen de eigenaar van de vergadering),
 * niet in dit predicaat — dat zou juist de rij verbergen die het slachtoffer
 * moet kunnen opruimen.
 *
 * Een query die omvalt gooit; hij mag NOOIT als lege lijst terugkomen, want
 * dan zou "ik kon niet kijken" gelezen worden als "er stond niets" en zou de
 * opruimactie schoon melden terwijl de bewering blijft staan.
 */
async function filedTranscriptSources(meetingId, db = pool) {
    const id = meetingId != null ? String(meetingId) : '';
    if (!id) return [];
    const r = await db.query(
        `SELECT s.id AS source_id, kb.id AS kb_id, kb.tenant_id AS owner_id
           FROM kb_sources s
           JOIN knowledge_bases kb ON kb.id = s.knowledge_base_id
          WHERE s.kind = 'text' AND ${FILED_LINE_ORIGIN_SQL} = $1`,
        [id],
    );
    return (r.rows || []).map(row => ({
        sourceId: row.source_id,
        kbId: row.kb_id,
        tenantId: row.owner_id || null,
    }));
}

/**
 * The later of two timestamps, with anything unparseable losing to a value
 * that IS a time. Never invents one: two unreadable stamps answer the
 * incumbent, which may be null.
 */
function latest(current, candidate) {
    const a = current == null ? NaN : new Date(current).getTime();
    const b = candidate == null ? NaN : new Date(candidate).getTime();
    if (!Number.isFinite(b)) return current;
    if (!Number.isFinite(a)) return candidate;
    return b > a ? candidate : current;
}

/** `config->>'tag'` as it comes back — `config` may already be an object or still be text. */
function readTag(config) {
    if (config && typeof config === 'object') return typeof config.tag === 'string' ? config.tag : null;
    if (typeof config === 'string') {
        try { const o = JSON.parse(config); return typeof o?.tag === 'string' ? o.tag : null; } catch (_) { return null; }
    }
    return null;
}

/**
 * Routines that run on this meeting.
 *
 * Reads `automations.definition_json` rather than
 * `automation_event_subscriptions`, and the difference matters for the delete
 * guard: subscription rows exist only while a routine is ACTIVE (activate
 * writes them, deactivate wipes them all), so the subscription table answers
 * "what will fire tonight" while the definition answers "what is wired to
 * this", drafts and paused routines included. Deleting a meeting out from
 * under a paused routine breaks it just the same, so the guard needs the
 * second question.
 *
 * Scoped to the meeting's OWNER — see the header on the fan-out. Without an
 * owner there is nothing to scope to and the scan says so instead of
 * guessing; an unscoped read here would put every routine in the install into
 * one person's list.
 */
async function scanAutomation(meeting, db) {
    const ownerId = meeting?.ownerId || meeting?.userId || null;
    if (!ownerId) {
        // Not an error and not "none" — the answer is unavailable.
        const err = /** @type {Error & {unscoped?: boolean}} */ (new Error('meeting has no owner to scope routines to'));
        err.unscoped = true;
        throw err;
    }
    const payload = syntheticPayload(meeting);

    // The provider/event go in through jsonpath's VARS argument, never
    // concatenated into the path — the same rule kbUsage follows for a kb id.
    // They are constants here, but the moment one becomes a parameter the
    // habit is the only thing standing between a quote and path syntax.
    const r = await db.query(
        `SELECT id, title, user_id AS owner_id, updated_at AS last_at, definition_json
           FROM automations
          WHERE user_id = $1
            AND kind = 'automation'
            AND jsonb_path_exists(
                    COALESCE(definition_json, '{}'::jsonb),
                    '$.**.appEvent ? (@.provider == $p && @.event == $e)',
                    jsonb_build_object('p', $2::text, 'e', $3::text))`,
        [ownerId, MEETING_PROVIDER, MEETING_EVENT],
    );

    const rows = [];
    let undecided = false;
    for (const row of r.rows || []) {
        const definition = parseDefinition(row.definition_json);
        for (const trig of meetingTriggersOf(definition)) {
            const fires = triggerFires(trig, payload);
            if (fires === null) {
                // A filter the real matcher could not judge. Not listed —
                // a row here is a claim that it runs — but the kind goes
                // into `partial`, so the answer reads as incomplete rather
                // than as "this routine does not run".
                undecided = true;
                continue;
            }
            if (!fires) continue;
            rows.push({
                kind: 'automation',
                id: row.id,
                title: row.title || null,
                role: 'read',
                ...triggerLabel(trig),
                lastAt: row.last_at || null,
                ownerId: row.owner_id || null,
            });
            // One row per routine, not one per trigger: two meeting triggers
            // on the same routine is still one thing that breaks.
            break;
        }
    }
    return { rows, undecided };
}

/** `definition_json` is jsonb on every install, but a text column would parse the same. */
function parseDefinition(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return null; }
    }
    return null;
}

/**
 * Notebooks holding a copy of this meeting.
 *
 * `notebook_sources` has no owner column of its own — the notebook is the
 * only ownership anchor, which is why this joins rather than filtering.
 *
 * ── WHY THIS KIND IS SO OFTEN `partial` ─────────────────────────────
 * `POST /notebooks/:id/sources/meeting` records the text and the name
 * `Meeting Note: <title>`, and nothing else: there is no column saying WHICH
 * meeting it came from. `source_ref_id` is the column that fixes it, it is
 * not on this install yet, and the rows written before it cannot be
 * backfilled — a title is not an id, two meetings share one every week, and
 * renaming a meeting rewrites nothing. So:
 *
 *   - column present  → an exact answer for every row that carries a ref;
 *   - any `type='meeting'` row with a NULL ref → the kind is `partial`,
 *     because those rows might be this meeting and there is no way to tell;
 *   - column absent   → every meeting source is such a row: `partial`, no
 *     rows.
 *
 * Matching on the name instead was considered and rejected: it would claim a
 * notebook holds this meeting on the strength of a title two meetings share,
 * and a wrong row in the delete dialog is a person deciding against a real
 * consequence that is not there.
 */
async function scanNotebook(meeting, db) {
    const id = meeting?.id != null ? String(meeting.id) : null;
    if (!id) return { rows: [], undecided: true };

    const hasRef = await columnExists('notebook_sources', 'source_ref_id', db);
    if (!hasRef) return { rows: [], undecided: true };

    const r = await db.query(
        `SELECT ns.id AS source_id, ns.name AS source_name, ns.updated_at AS last_at,
                nb.id AS notebook_id, nb.name AS notebook_name, nb.user_id AS owner_id
           FROM notebook_sources ns
           JOIN notebooks nb ON nb.id = ns.notebook_id
          WHERE ns.source_ref_id = $1`,
        [id],
    );
    const rows = (r.rows || []).map((row) => ({
        kind: 'notebook',
        id: row.notebook_id,
        title: row.notebook_name || null,
        role: 'contains',
        siteLabel: row.source_name || undefined,
        lastAt: row.last_at || null,
        ownerId: row.owner_id || null,
    }));

    // The unbackfillable remainder: is ANY pre-column meeting source still
    // around? `LIMIT 1` stops at the first hit, so the common case — an
    // install that still has some — is cheap. The expensive case is the happy
    // one (none left), which reads the table to prove a negative; the column
    // migration should carry a partial index
    // `(source_ref_id) WHERE type = 'meeting' AND source_ref_id IS NULL` so
    // this stays an index probe on a large notebook_sources.
    const legacy = await db.query(
        `SELECT 1 FROM notebook_sources WHERE type = 'meeting' AND source_ref_id IS NULL LIMIT 1`,
    );
    return { rows, undecided: (legacy.rows || []).length > 0 };
}

/**
 * Everything that consumes this meeting.
 *
 * @param {object} meeting  `{ id, tags, ownerId, organizationId }` — the note
 *                          as the store returns it. Only these four fields are
 *                          read; passing the whole note is fine.
 * @param {object} [opts]
 * @param {object} [opts.db]  injection seam for the tests
 * @returns {Promise<{ rows: Array, partial: string[] }>}
 *          `partial` names the kinds that could NOT be answered. Non-empty
 *          means "I do not know" — never "nothing".
 */
async function usageForMeeting(meeting, { db = pool } = {}) {
    if (!meeting || meeting.id == null || meeting.id === '') return { rows: [], partial: [] };
    const rows = [];
    const partial = [];

    // kb ─────────────────────────────────────────────────────────────
    try {
        if (!(await tableExists('kb_sources', db)) || !(await tableExists('knowledge_bases', db))) {
            partial.push('kb');
        } else {
            rows.push(...await scanKb(meeting, db));
        }
    } catch (e) {
        log.warn(`[MeetingUsage] kb scan failed for ${meeting.id}:`, e.message);
        partial.push('kb');
    }

    // automation ─────────────────────────────────────────────────────
    try {
        if (!(await tableExists('automations', db))) {
            partial.push('automation');
        } else {
            const { rows: found, undecided } = await scanAutomation(meeting, db);
            rows.push(...found);
            if (undecided) partial.push('automation');
        }
    } catch (e) {
        log.warn(`[MeetingUsage] automation scan failed for ${meeting.id}:`, e.message);
        partial.push('automation');
    }

    // notebook ───────────────────────────────────────────────────────
    try {
        if (!(await tableExists('notebook_sources', db)) || !(await tableExists('notebooks', db))) {
            partial.push('notebook');
        } else {
            const { rows: found, undecided } = await scanNotebook(meeting, db);
            rows.push(...found);
            if (undecided) partial.push('notebook');
        }
    } catch (e) {
        log.warn(`[MeetingUsage] notebook scan failed for ${meeting.id}:`, e.message);
        partial.push('notebook');
    }

    return { rows, partial };
}

/**
 * Narrow the rows to what this person may be told.
 *
 * Same rule as the knowledge-base Used-by tab: a row owned by somebody else
 * keeps its KIND and its ROLE — which is what "what would break" needs — and
 * loses its NAME, so a shared meeting cannot be used to enumerate an
 * organisation's routines and knowledge bases. A row with no owner at all
 * (org-scoped) is nobody's private business and stays whole.
 */
function redactForeign(rows, userId) {
    return (Array.isArray(rows) ? rows : []).map((r) => {
        if (!r?.ownerId) return r;
        if (String(r.ownerId) === String(userId)) return r;
        return { ...r, title: null, siteLabel: undefined, foreign: true };
    });
}

module.exports = {
    usageForMeeting,
    filedTranscriptSources,
    redactForeign,
    tagsOf,
    syntheticPayload,
    triggerFires,
    triggerLabel,
    meetingTriggersOf,
    appEventTriggersOf,
    tableExists,
    columnExists,
    KINDS,
    MEETING_PROVIDER,
    MEETING_EVENT,
    MEETING_SOURCE_CONFIG_KEY,
};
