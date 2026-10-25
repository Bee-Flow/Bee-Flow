// @typecheck
'use strict';

/**
 * Meeting action items, decisions and questions — THE WRITE CONTRACT (M3).
 *
 * Until this module existed, `action_items` was whatever the last writer put
 * there. `PATCH /api/transcriptions/:id` handed `req.body.actionItems` straight
 * to the store, which only checked "is it an array" — routes/transcriptions/
 * tags.js:54-60 documents that as a known wound and defends itself in SQL
 * instead. Everything downstream (the list aggregates, the export, the KB
 * meeting source, the report) reads these objects and assumed a shape nobody
 * enforced.
 *
 * M3 adds three fields to the item, and one of them is a decision the user made
 * about where the action goes:
 *
 *   destination  {kind:'automation'|'datatable_row'|'kb', ref, label, at, itemRef?}
 *   source       'ai' | 'user'
 *   segmentIndex which transcript line the action came from
 *
 * ── THE RULE THIS FILE EXISTS FOR ───────────────────────────────────
 * "Opnieuw" (regenerate) re-runs the extractor and replaces the action items.
 * It must replace ONLY the items the extractor produced. An action a person
 * typed themselves — the one they will look for tomorrow — has to survive a
 * regenerate, and there is no undo if it does not. mergeRegeneratedActionItems
 * is that rule; every write path that re-extracts artifacts goes through it.
 *
 * ── M4 EXTENDS BOTH HALVES TO THE OTHER TWO LISTS ───────────────────
 * The transcript tab gives every line a popover: "Actie" writes an action item
 * anchored to that line, "Besluit" writes a DECISION. So decisions and open
 * questions are no longer produced by the extractor alone, and the rule above
 * had to grow a second copy: they carry a `source` and a `segmentIndex` too,
 * and mergeRegeneratedNotes keeps a person's out of the extractor's way.
 * Without it, "Opnieuw" would have swallowed every decision picked off a line.
 *
 * ── HOW `source` IS DECIDED, AND WHY NOT BY DEFAULTING ──────────────
 * Every row written before M3 has no `source` at all, so a default would have
 * to be wrong for somebody:
 *   - default 'user'  → every legacy AI item survives every regenerate and the
 *                       list doubles, then triples.
 *   - default 'ai'    → nothing to lose today (users could not add items before
 *                       M3), but it makes "unknown" mean "delete me", which is
 *                       the wrong direction the moment any client forgets the
 *                       field.
 * So it is DERIVED from evidence instead: the extractor mints `ai-<n>` ids
 * (core/meetingNotes/summaryHelpers.js), and nothing else ever has. An id in
 * that namespace is AI-produced; anything else with no declared source is
 * treated as a person's and kept. An explicit `source` always wins, and a user
 * item is never allowed to KEEP an `ai-<n>` id (see shapeActionItem) — that
 * invariant is what keeps the derivation honest.
 *
 * ── ALLOW-LIST, NEVER DELETE-KEYS ───────────────────────────────────
 * Items are rebuilt field by field from an allow-list. A key the client invents
 * does not reach the column, so a field added elsewhere next year cannot ride
 * along into a note that other people in the org can read (the same habit
 * BFSF-441 requires of outbound payloads).
 *
 * ── PRIVACY (BFSF-441) ──────────────────────────────────────────────
 * An action's text can name a person. All three destinations are INSIDE Bee
 * Flow — an automation run, a row in the user's own table, a source in the user's
 * own knowledge base — so carrying the text there is not an outgoing transfer.
 * What `destination` stores is a reference (kind + id + the label shown), never
 * a copy of anything from the other system. If an automation writes onward to a
 * third party, that chain is the automation's step to gate, not this record's.
 *
 * Two entry points, deliberately different:
 *   validate*   STRICT — for the PATCH route. Bad input is a 400 with a reason,
 *               never a silently emptied column.
 *   normalize*  LENIENT — for background merges over rows already in the DB.
 *               A legacy row that cannot be shaped is dropped, not thrown: a
 *               regenerate must not 500 because one old item is junk.
 */

const crypto = require('crypto');

/** The only destinations M3 knows. Unknown kind → refused, never stored. */
const DESTINATION_KINDS = Object.freeze(['automation', 'datatable_row', 'kb']);
const ACTION_SOURCES = Object.freeze(['ai', 'user']);

// Caps. Generous on purpose: they exist so one client bug cannot write an
// unbounded JSONB column, not to police what a person may type.
const MAX_ITEMS = 500;
const MAX_TEXT = 2000;
const MAX_ID = 100;
const MAX_REF = 200;
const MAX_LABEL = 200;
const MAX_ASSIGNEE = 120;
const MAX_TIMESTAMP = 12;   // "01:05:30" and then some

/**
 * The extractor's own id namespace — see summaryHelpers.extractMeetingArtifacts,
 * which mints `ai-<n>` for action items (and `d-<n>` / `q-<n>` for the other two
 * artifacts, which is why nothing minted here may look like those either).
 */
const AI_ACTION_ID_RE = /^ai-\d+$/;
/**
 * Same evidence for the other two artifacts (M4). The extractor mints `d-<n>`
 * and `q-<n>`; nothing else ever has, and `validateDecisions`/`validateQuestions`
 * mint `ud-`/`uq-` prefixed UUIDs for anything that arrives without an id. So
 * an id in the extractor's namespace is the model's, and everything else with
 * no declared source is a person's — the same derivation, for the same reason,
 * as action items.
 */
const AI_NOTE_ID_RE = Object.freeze({ decisions: /^d-\d+$/, questions: /^q-\d+$/ });
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A trimmed, capped string — or '' for anything that is not text.
 * @param {number} max
 */
function text(value, max) {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    const s = value.trim();
    // Truncate rather than refuse: a 2000-character "action item" is already a
    // bug, but refusing it would lock the owner out of PATCHing the note at all
    // (toggling any checkbox re-sends the whole array).
    return s.length > max ? s.slice(0, max) : s;
}

/** Server-minted id. Never lands in an extractor namespace. */
function mintId(source) {
    return `${source === 'ai' ? 'ai-gen' : 'u'}-${crypto.randomUUID()}`;
}

/**
 * Who put this action item here.
 *
 * Load-bearing: mergeRegeneratedActionItems deletes exactly the items this
 * answers 'ai' for.
 */
function actionItemSource(item) {
    const declared = item && typeof item.source === 'string' ? item.source.trim() : '';
    if (ACTION_SOURCES.includes(declared)) return declared;
    if (item && typeof item.id === 'string' && AI_ACTION_ID_RE.test(item.id.trim())) return 'ai';
    return 'user';
}

/**
 * The same question for a decision or an open question (M4).
 * @param {string} field
 */
function noteSource(note, field) {
    const declared = note && typeof note.source === 'string' ? note.source.trim() : '';
    if (ACTION_SOURCES.includes(declared)) return declared;
    const re = AI_NOTE_ID_RE[field];
    if (re && note && typeof note.id === 'string' && re.test(note.id.trim())) return 'ai';
    return 'user';
}

/**
 * Which transcript line an artifact was anchored to, or `undefined`.
 *
 * Booleans and null must not become 0 — `Number(null) === 0` would anchor
 * every item to the first line of the meeting, and the transcript would draw
 * a chip there that nobody put there.
 */
function segmentIndexOf(raw) {
    if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
    const seg = Number(raw);
    return Number.isInteger(seg) && seg >= 0 ? seg : undefined;
}

/**
 * A client clock is not a clock. An unusable `at` is stamped here.
 * @param {number} [now]
 */
function isoStamp(raw, now = Date.now()) {
    if (typeof raw === 'string' && raw.trim()) {
        const d = new Date(raw.trim());
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return new Date(now).toISOString();
}

/**
 * `destination` → {kind, ref, label, at, itemRef?}, or an error.
 *
 * TWO REFERENCES, BECAUSE THERE ARE TWO THINGS TO POINT AT:
 *   ref      the container — the automation, the datatable, the knowledge base.
 *            Known before the write is attempted, so it is always present and
 *            is what the chip links to.
 *   itemRef  what the write created inside it — the run, the row, the source.
 *            Optional, and that is not tidiness: `POST /api/automation/:id/run`
 *            answers 202 `{pending:true}` with NO run id when a run outlives its
 *            60-second response window. The run really did start, so refusing to
 *            record the destination (or inventing a run id) would both be lies;
 *            the record simply says "sent to this automation" until there is
 *            more to say.
 *
 * Absent/null is legitimate (most actions have no destination) and answers
 * `{ok:true, value:null}`. An object with an unknown kind or without a ref is
 * NOT the same thing: that is a client sending something this server does not
 * understand, and storing it would put a chip on the card that no code can
 * resolve. Refused.
 */
function shapeDestination(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
    if (!isPlainObject(raw)) return { ok: false, error: 'destination must be an object' };
    const kind = text(raw.kind, 40);
    if (!DESTINATION_KINDS.includes(kind)) {
        return { ok: false, error: `destination.kind must be one of: ${DESTINATION_KINDS.join(', ')}` };
    }
    const ref = text(raw.ref, MAX_REF);
    if (!ref) return { ok: false, error: 'destination.ref is required' };
    /** @type {{ kind: string; ref: string; label: string; at: string; itemRef?: string }} */
    const value = { kind, ref, label: text(raw.label, MAX_LABEL), at: isoStamp(raw.at) };
    const itemRef = text(raw.itemRef, MAX_REF);
    if (itemRef) value.itemRef = itemRef;
    return { ok: true, value };
}

/**
 * One action item, rebuilt from the allow-list.
 *
 * strict:true  → an unusable item is an error the route turns into a 400.
 * strict:false → an unusable item answers {value:null} and the caller drops it.
 */
function shapeActionItem(raw, { strict = false, index = 0 } = {}) {
    /**
     * @param {string} error
     */
    const reject = (error) => (strict ? { ok: false, error } : { ok: true, value: null });
    if (!isPlainObject(raw)) return reject(`actionItems[${index}] must be an object`);

    const body = text(raw.text, MAX_TEXT);
    if (!body) return reject(`actionItems[${index}].text is required`);

    const source = actionItemSource(raw);
    let id = text(raw.id, MAX_ID);
    // A user item must never wear an `ai-<n>` id: that namespace is the only
    // evidence a legacy row leaves behind, so an item wearing it would be
    // deleted by the very next regenerate no matter what `source` said.
    if (!id || (source === 'user' && AI_ACTION_ID_RE.test(id))) id = mintId(source);

    const out = {
        id,
        text: body,
        source,
        // Tolerant on the way in: the aggregate SQL compares `->>'done'` to the
        // string 'true', so a client that sends "true" already counts as done in
        // the library rail. Coercing to false here would silently uncheck it.
        done: raw.done === true || raw.done === 'true',
    };

    // What the MODEL itself wrote (M4). See the header above `hasHumanInput`: this is
    // the reference point against which "someone retyped the text" is measured.
    // It is also kept when it equals `text`, precisely then, because otherwise there is nothing
    // left to measure against at the NEXT correction (the web client sends the whole list back
    // with every toggle).
    const aiText = text(raw.aiText, MAX_TEXT);
    if (aiText) out.aiText = aiText;
    // The point stood in the previous pass, the new one does not yield it, and it is kept because
    // a person had worked on it. The flag travels along so that a toggle does not erase the notice
    // on screen; the merge sets it again (or drops it as soon as the point is matched again).
    if (raw.orphaned === true || raw.orphaned === 'true') out.orphaned = true;

    const assignee = text(raw.assignee, MAX_ASSIGNEE);
    if (assignee) out.assignee = assignee;
    const timestamp = text(raw.timestamp, MAX_TIMESTAMP);
    if (timestamp) out.timestamp = timestamp;
    // Same convention as the extractor: no deadline means no key at all, and a
    // due date that is not a plain ISO day is not a deadline.
    const due = text(raw.due, 10);
    if (DUE_RE.test(due)) out.due = due;

    // Which transcript line this came from — the per-line popover (M4) writes
    // it, and the transcript's third column reads it back.
    const segmentIndex = segmentIndexOf(raw.segmentIndex);
    if (segmentIndex !== undefined) out.segmentIndex = segmentIndex;

    const destination = shapeDestination(raw.destination);
    if (!destination.ok) return reject(`actionItems[${index}]: ${destination.error}`);
    if (destination.value) out.destination = destination.value;

    return { ok: true, value: out };
}

/**
 * Decisions and open questions share everything but the `open` flag.
 *
 * ── WHY THEY NOW CARRY A `source` (M4) ──────────────────────────────
 * M3 left this field off on purpose: "nothing regenerates them selectively, so
 * a provenance field nobody reads would be a promise this stage does not
 * keep." M4 breaks that premise. The transcript's per-line popover writes a
 * DECISION straight from a line a person picked, and regenerate replaced the
 * whole `decisions` column with the extractor's fresh list — so the one thing
 * a person can now write there would be gone the next time they pressed a
 * button that promises to rewrite the SUMMARY. Same wound as action items had,
 * one column over, and mergeRegeneratedNotes is the same rule.
 *
 * The derivation matches action items exactly: an explicit `source` wins, an
 * id in the extractor's `d-<n>`/`q-<n>` namespace is the model's, and anything
 * else is a person's. An id that is missing is minted outside those namespaces
 * (`ud-`/`uq-`), and a user note is never allowed to KEEP an extractor id —
 * that invariant is what keeps the derivation honest, because the id is the
 * only evidence a row written before M4 leaves behind.
 */
function shapeNote(raw, { strict = false, index = 0, field = 'decisions', prefix = 'ud' }) {
    /**
     * @param {string} error
     */
    const reject = (error) => (strict ? { ok: false, error } : { ok: true, value: null });
    if (!isPlainObject(raw)) return reject(`${field}[${index}] must be an object`);
    const body = text(raw.text, MAX_TEXT);
    if (!body) return reject(`${field}[${index}].text is required`);
    const source = noteSource(raw, field);
    const aiIdRe = AI_NOTE_ID_RE[field];
    let id = text(raw.id, MAX_ID);
    if (!id || (source === 'user' && aiIdRe && aiIdRe.test(id))) id = `${prefix}-${crypto.randomUUID()}`;
    const out = { id, text: body, source };
    const timestamp = text(raw.timestamp, MAX_TIMESTAMP);
    if (timestamp) out.timestamp = timestamp;
    // Which transcript line the person picked this off (M4).
    const segmentIndex = segmentIndexOf(raw.segmentIndex);
    if (segmentIndex !== undefined) out.segmentIndex = segmentIndex;
    if (field === 'questions') out.open = raw.open !== false;
    return { ok: true, value: out };
}

/**
 * @param {string} field
 */
function collect(raw, field, shape, mint) {
    if (!Array.isArray(raw)) return { ok: false, error: `${field} must be an array` };
    if (raw.length > MAX_ITEMS) return { ok: false, error: `${field}: at most ${MAX_ITEMS} entries` };
    const items = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i++) {
        const shaped = shape(raw[i], i);
        if (!shaped.ok) return shaped;
        if (!shaped.value) continue;
        // Two items with one id makes every id-keyed client operation (toggle,
        // edit, set a destination) hit both of them.
        if (seen.has(shaped.value.id)) shaped.value.id = mint(shaped.value);
        seen.add(shaped.value.id);
        items.push(shaped.value);
    }
    return { ok: true, items };
}

/** STRICT — the PATCH route. `{ok:true, items}` or `{ok:false, error}`. */
function validateActionItems(raw) {
    return collect(raw, 'actionItems',
        (item, index) => shapeActionItem(item, { strict: true, index }),
        (item) => mintId(item.source));
}

function validateDecisions(raw) {
    return collect(raw, 'decisions',
        (item, index) => shapeNote(item, { strict: true, index, field: 'decisions', prefix: 'ud' }),
        () => `ud-${crypto.randomUUID()}`);
}

function validateQuestions(raw) {
    return collect(raw, 'questions',
        (item, index) => shapeNote(item, { strict: true, index, field: 'questions', prefix: 'uq' }),
        () => `uq-${crypto.randomUUID()}`);
}

/** LENIENT — rows already in the database. Unusable entries are dropped. */
function normalizeActionItems(raw) {
    const result = collect(Array.isArray(raw) ? raw.slice(0, MAX_ITEMS) : [], 'actionItems',
        (item, index) => shapeActionItem(item, { strict: false, index }),
        (item) => mintId(item.source));
    return result.ok ? result.items : [];
}

/**
 * The same, for one of the two note lists. `field` picks which.
 * @param {string} field
 */
function normalizeNotes(raw, field) {
    const prefix = field === 'questions' ? 'uq' : 'ud';
    const result = collect(Array.isArray(raw) ? raw.slice(0, MAX_ITEMS) : [], field,
        (item, index) => shapeNote(item, { strict: false, index, field, prefix }),
        () => `${prefix}-${crypto.randomUUID()}`);
    return result.ok ? result.items : [];
}

/**
 * Re-extraction replaces the AI's items and NOTHING ELSE.
 *
 * `existing` is what the note holds now, `fresh` is what the extractor just produced. Everything a
 * person put there themselves is carried over, in front of the new list, with its done-state, its
 * destination and its due date intact. This is the whole point of M3: a user who adds an action and
 * then presses "Regenerate" must still have it afterwards.
 *
 * ── WHAT COUNTS AS "A PERSON PUT IT THERE" ──────────────────────────
 *
 * `source: 'user'` is the obvious half, and on its own it protected almost nothing: nothing in the
 * product CREATES such an item yet (that is M4), while everything a person does today, giving an action
 * a destination, happens on an item the model extracted, which keeps `source: 'ai'`. The rule read well
 * and guarded an empty set, and the one act that leaves a trace outside this note was the act it dropped.
 *
 * So a DESTINATION also makes an item a person's. It is not a preference: it is the receipt for something
 * that already happened, an automation that ran, a row that was written, a source that was filed.
 * Re-running the extractor cannot undo any of those, so throwing the reference away does not remove the
 * effect, it only removes the record of it.
 *
 * ── AND WHAT `done` AND AN OVERTYPED TEXT COUNT (M4) ────────────────
 * M3 left that question explicitly open. The answer is: both are acts of a human, and human input beats regeneration.
 *   - Ticking can only be done by a human; the extractor always sets `done: false`.
 *     Ticking a point is moreover, just like a destination, the report of something that
 *     ALREADY happened: extracting again does not undo it.
 *   - A text that deviates from what the model wrote (`aiText`) has been retyped by a human. Being
 *     reset to the AI version undoes the correction, without undo and without a notice.
 * See `hasHumanInput` and `anchorKey` below for the proof and the key.
 *
 * `transcriptChanged` is for /reprocess, which re-transcribes the audio: the surviving items keep their
 * text but lose their anchors into a transcript that no longer exists, because a `segmentIndex` pointing
 * at a line that has moved is worse than none (it would highlight, and seek to, the wrong sentence).
 */
function isPersonsItem(item) {
    return item.source === 'user' || !!item.destination;
}

/**
 * Has a person retyped the TEXT of this AI point?
 *
 * `aiText` is the text that the model itself wrote (set by the extractor and by the merge below).
 * The two edit paths in the client do not touch it: the checkbox writes `done`, the inline editor
 * writes `text`. So if `text` deviates from it, that is a correction by a human.
 *
 * NO `aiText` is NO evidence, and then the ordinary rule applies: the point belongs to the model and
 * is replaced. That is not "fail open" but precisely the side that this file already chooses for rows
 * without `source` ("a legacy AI item is still replaced, not duplicated": otherwise the list grows with
 * every regeneration, and a frozen row that is never refreshed again is loss as well). Without aiText
 * there is nothing by which you can tell "corrected" from "the model phrased it differently this time".
 * The price is tightly bounded: only corrections that were made before the extractor started stamping
 * `aiText` lack this evidence; every correction after that carries it.
 */
function textWasRetyped(item) {
    return typeof item.aiText === 'string' && !!item.aiText && item.aiText !== item.text;
}

/** What a person has done to an AI point, and which regeneration must therefore not wipe. */
function hasHumanInput(item) {
    return item.done === true || textWasRetyped(item);
}

/**
 * ── THE KEY: HOW DO YOU RECOGNISE THE SAME POINT? ───────────────────
 *
 * A regeneration yields a completely new list. To know which fresh point is the same point as a stored
 * point, a key is needed, and the two obvious candidates are both no good:
 *
 *   NOT THE ID. The extractor mints `ai-<n>` per index, so the id is the POSITION in the output of THIS
 *   pass. If the model leaves out one point, everything shifts: `ai-3` is then a DIFFERENT point from
 *   the `ai-3` of last time. Comparing on id moves a tick silently to an action that nobody ticked.
 *
 *   NOT THE TEXT. The text is precisely the field that a person may have retyped; matching on it recognises
 *   only the points that nobody worked on.
 *
 * What both passes DO share is the transcript. `POST /:id/regenerate-summary` does not re-transcribe: it runs
 * the extractor again over exactly the same `transcription.transcript`. That is why the anchor in that
 * transcript is the key:
 *
 *   timestamp  taken literally by the model from the line where it was discussed, and then verified against
 *              the clocks of the transcript itself (`sanitizeTimestamp` / `extractTranscriptClocks` in
 *              summaryHelpers.js). What survives is therefore a real line of this meeting, not an invention of this pass.
 *   assignee   the person responsible, from that same conversation.
 *
 * Together they say "the action for this person, discussed at this moment": a property of the MEETING, not
 * of an extraction round. And neither of the two is reachable from the two acts that the key must survive:
 * ticking writes `done`, the inline editor writes `text`.
 *
 * ── NO STAMP IS NO ANCHOR ───────────────────────────────────────────
 * The stamp is the WHOLE content of the key; `assignee` falls back to the CONSTANT "Unassigned" (summaryHelpers.js
 * even asks for it explicitly in the prompt), so it distinguishes nothing as soon as nobody is named.
 * And `sanitizeTimestamp` returns '' for every stamp that cannot be parsed or lies beyond the end of the
 * meeting. Without this rule, all points without a usable stamp and without a named owner got LITERALLY THE
 * SAME key, the whole list fell into one bucket, and the merge matched on ORDER: exactly the `ai-<n>` trap
 * that the header above says to avoid. Proven: a list whose fresh pass left out the first point moved the tick
 * to the action beneath it, and a retyped text landed on a completely different action.
 *
 * Hence: no stamp → `null` → no key → no match. Such a point becomes an ORPHAN (kept, marked, visible)
 * instead of being quietly stuck onto another action.
 *
 * ── AND A BUCKET WITH MORE THAN ONE CANDIDATE IS NOT EVIDENCE EITHER ─
 * Here it used to say that colliding points matched on order within their bucket, "the narrowest possible
 * place where position still plays a part". That held only as long as a collision was rare. But
 * transcriptArtifacts.js itself describes the degradation in which a transcript has only ONE line start
 * (a solo dictation, or a run in which diarisation falls back to a single label), and then every point gets the
 * same verified stamp and the whole list is one bucket again. A bucket with more than one candidate, on the
 * fresh side or on the stored side, is not evidence, so nothing is matched. Unknown narrows.
 *
 * For `transcriptChanged` (/reprocess) there is no shared anchor: the audio has been transcribed anew, and this
 * function itself gives the anchors for that reason. Unknown then narrows: nothing is matched, and everything a
 * person worked on remains as an orphan. Better a duplicate line that the screen names than a tick that lands
 * on another action by luck.
 *
 * @returns {string|null} the key, or null if this point has no anchor
 */
function anchorKey(item) {
    const timestamp = String(item?.timestamp || '').trim();
    if (!timestamp) return null;
    return `${timestamp}\u0000${String(item?.assignee || '').trim().toLowerCase()}`;
}

/** Rebuild without the anchors into a transcript that no longer exists. */
function withoutStaleAnchors(item) {
    // Rebuilt from the allow-list WITHOUT the two anchors into the old
    // transcript — same habit as everywhere else here: name what is
    // kept, never delete what is not.
    const out = { id: item.id, text: item.text, source: item.source, done: item.done };
    // (source is carried verbatim: an item that survives because it
    // carries a destination is still the model's text, and relabelling
    // it 'user' would claim someone typed it.)
    if (item.assignee) out.assignee = item.assignee;
    if (item.due) out.due = item.due;
    if (item.destination) out.destination = item.destination;
    if (item.aiText) out.aiText = item.aiText;
    if (item.orphaned) out.orphaned = true;
    return out;
}

function mergeRegeneratedActionItems(existing, fresh, { transcriptChanged = false, keepAiItems = false } = {}) {
    // Force the source rather than trust it: a caller handing us raw extractor output is the normal case,
    // and an item that came out of the model is 'ai' whatever it says. `aiText` follows the same rule:
    // what the model just delivered IS by definition the AI text of this point, and that stamp is the
    // reference point for the next correction.
    const regenerated = normalizeActionItems(fresh).map((item) => ({ ...item, source: 'ai', aiText: item.text }));

    // Three heaps from what is NOW in the column:
    //   survivors  from a person (or with a destination): kept unchanged at the front.
    //   touched    from the model, but a person has worked on it.
    //   (the rest) pure model output; that is replaced by the new pass, and that is
    //              precisely what "Regenerate" should do.
    const survivors = [];
    const touched = [];
    for (const item of normalizeActionItems(existing)) {
        // `keepAiItems` is for a FAILED extraction pass: there is then nothing with which to replace the model's
        // items, so every stored row counts as a survivor. Four empty lists from a pass that never ran are not
        // a meeting in which nothing was agreed.
        if (keepAiItems || isPersonsItem(item)) survivors.push(item);
        else if (hasHumanInput(item)) touched.push(item);
    }

    // Which fresh point is which stored point? Buckets on anchor, and only a bucket with exactly ONE candidate
    // on EACH side counts as evidence. Points without an anchor take no part (anchorKey then gives null).
    const freshByAnchor = new Map();
    if (!transcriptChanged) {
        regenerated.forEach((item, index) => {
            const key = anchorKey(item);
            if (key === null) return;
            if (!freshByAnchor.has(key)) freshByAnchor.set(key, []);
            freshByAnchor.get(key).push(index);
        });
    }
    // How many STORED points fall into the same bucket? With two, it cannot be said from this side either
    // which is which.
    const touchedPerAnchor = new Map();
    for (const item of touched) {
        const key = anchorKey(item);
        if (key === null) continue;
        touchedPerAnchor.set(key, (touchedPerAnchor.get(key) || 0) + 1);
    }
    const carried = new Map();
    const orphans = [];
    for (const item of touched) {
        const key = anchorKey(item);
        const queue = key === null ? null : freshByAnchor.get(key);
        const unambiguous = !!queue && queue.length === 1 && touchedPerAnchor.get(key) === 1;
        const index = unambiguous ? queue.shift() : undefined;
        // NO LONGER RECOGNISABLE. Deleting and re-creating would wipe the human input after all, so the point stays
        // as it is, with a flag, because silently keeping it would let the screen claim that the AI has just
        // delivered this point.
        if (index === undefined) orphans.push({ ...item, orphaned: true });
        else carried.set(index, item);
    }

    // The fresh point is the new truth for id, text, who and when, except for the two fields on which
    // a person has done something.
    const rebuilt = regenerated.map((item, index) => {
        const kept = carried.get(index);
        if (!kept) return item;
        const out = { ...item };
        if (kept.done) out.done = true;
        if (textWasRetyped(kept)) out.text = kept.text;
        return out;
    });

    const front = transcriptChanged
        ? [...survivors, ...orphans].map(withoutStaleAnchors)
        : [...survivors, ...orphans];
    const takenIds = new Set(rebuilt.map((item) => item.id));
    return [
        // An orphan still carries the `ai-<n>` id of the previous pass, and that can collide with a fresh point;
        // it is then re-minted within its own namespace, so that `actionItemSource` still reads it as the model's point.
        ...front.map((item) => (takenIds.has(item.id) ? { ...item, id: mintId(item.source) } : item)),
        ...rebuilt,
    ];
}

/**
 * The same rule for decisions and open questions (M4).
 *
 * ── WHY THIS EXISTS, AND WHY IT DID NOT BEFORE ──────────────────────
 * Until M4 the only way a decision reached the column was the extractor, so
 * "replace the whole list" and "replace the AI's list" were the same write.
 * The transcript's per-line popover changes that: "Besluit" on a line writes a
 * decision a PERSON chose, and the next regenerate would have overwritten the
 * column with the extractor's fresh list. Nothing would have said so — the
 * card simply has one fewer row than it had a second ago, and there is no undo.
 *
 * A note has no destination to be the receipt of something outside the note,
 * so `source: 'user'` is the whole test here. That is not the empty set M3's
 * rule turned out to guard: the popover mints these, and `PATCH
 * /api/transcriptions/:id` has accepted a hand-written decision since M3.
 *
 * `transcriptChanged` is for /reprocess, which re-transcribes the audio: a
 * survivor keeps its text and gives up its anchors into a transcript that no
 * longer exists (a `segmentIndex` pointing at a line that has moved is worse
 * than none — it would chip, and seek to, the wrong sentence).
 */
function isPersonsNote(note) {
    return note.source === 'user';
}

function mergeRegeneratedNotes(existing, fresh, { field = 'decisions', transcriptChanged = false, keepAiNotes = false } = {}) {
    const prefix = field === 'questions' ? 'uq' : 'ud';
    const survivors = normalizeNotes(existing, field)
        // Same rule as for the action items: on a failed pass every stored row survives,
        // because there is no fresh list with which to replace it.
        .filter((note) => keepAiNotes || isPersonsNote(note))
        .map((note) => {
            if (!transcriptChanged) return note;
            // Rebuilt from the allow-list WITHOUT the two anchors — name what
            // is kept, never delete what is not.
            const out = { id: note.id, text: note.text, source: note.source };
            if (field === 'questions') out.open = note.open !== false;
            return out;
        });
    // Forced rather than trusted: the normal caller hands us raw extractor
    // output, and what came out of the model is 'ai' whatever it says.
    const regenerated = normalizeNotes(fresh, field).map((note) => ({ ...note, source: 'ai' }));
    const takenIds = new Set(regenerated.map((note) => note.id));
    return [
        ...survivors.map((note) => (takenIds.has(note.id) ? { ...note, id: `${prefix}-${crypto.randomUUID()}` } : note)),
        ...regenerated,
    ];
}

module.exports = {
    isPersonsItem,
    isPersonsNote,
    hasHumanInput,
    anchorKey,
    DESTINATION_KINDS,
    ACTION_SOURCES,
    MAX_ITEMS,
    actionItemSource,
    noteSource,
    validateActionItems,
    validateDecisions,
    validateQuestions,
    normalizeActionItems,
    normalizeNotes,
    mergeRegeneratedActionItems,
    mergeRegeneratedNotes,
};

/** @typedef {{ kind: string; ref: string; label: string; at: string; itemRef?: string }} Destination */

/**
 * @typedef {{ id: string, text: string, source: string, done: boolean, aiText?: string, orphaned?: boolean,
 *   assignee?: string, timestamp?: string, due?: string, segmentIndex?: number, destination?: Destination }} ActionItem
 */

/** @typedef {{ id: string, text: string, source: string, timestamp?: string, segmentIndex?: number, open?: boolean }} Note */

/**
 * @template T
 * @typedef {{ ok: boolean, value?: T | null, error?: string }} Shaped
 */
