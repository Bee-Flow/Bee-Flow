/**
 * Where an action item GOES — the payload builders behind the destination
 * picker (Meeting Notes artboard 1a, plan M3).
 *
 * An action item is a sentence a meeting produced. M3 lets the owner send it
 * somewhere it can actually be worked on, and records where it went:
 *
 *   automation      start a routine with the action as its trigger payload
 *   datatable_row   append a row to one of the owner's own tables
 *   kb              file it as a text source in a knowledge base
 *
 * The server contract for the record itself lives in
 * `server/core/meetingNotes/actionItems.js`; this module only ever produces a
 * shape that contract accepts, so a chip on the card is a chip the server
 * validated.
 *
 * ── EVERY PAYLOAD IS AN ALLOW-LIST, NEVER A SPREAD ──────────────────
 * The one habit this file exists to enforce. `{ ...item }` is one character
 * shorter and would ship `id`, `done`, `destination`, `segmentIndex` — and
 * whatever field M4 or a later stage adds to an action item — into a routine's
 * run payload, a row in a table other people read, and a knowledge base an
 * agent answers from. None of those would be noticed the day the field is
 * added, which is precisely the failure mode BFSF-441 names: build the payload
 * from a list of fields you wrote down, never by removing keys from a record.
 * So `actionFieldValue` is a switch over ACTION_FIELD_IDS, and adding a field
 * to a payload takes an edit here.
 *
 * ── BFSF-441, AND WHY TEXT MAY TRAVEL AT ALL ────────────────────────
 * An action can name a person ("Sandra belt de klant terug"). All three
 * destinations are INSIDE Bee Flow — the user's own routine, their own table,
 * their own knowledge base — so carrying the text there is not an outgoing
 * transfer and the reference-only rule does not apply. The rule DOES apply one
 * link further on: a routine whose steps post to Google Chat or a webhook is
 * an outgoing destination, and that step is where it is gated. What this
 * module records on the note is only ever a REFERENCE (kind + id + the label
 * that was on screen), never a copy of anything the other system holds.
 *
 * ── NO ENGLISH LIVES HERE ───────────────────────────────────────────
 * Labels are the caller's: it has `t()`, this module does not. The knowledge
 * snippet takes its line labels as an argument and falls back to the bare
 * field id (`assignee:`), a machine value rather than untranslatable prose.
 */

/** The destination kinds the server will accept. Anything else is refused. */
export const DESTINATION_KINDS = Object.freeze(['automation', 'datatable_row', 'kb']);

/**
 * THE ALLOW-LIST. Everything an action item is allowed to contribute to a
 * destination, and the only thing `actionFieldValue` can answer for.
 *
 * `done`, `id`, `source`, `segmentIndex` and `destination` are deliberately
 * absent: they are bookkeeping about the action, not the action.
 */
export const ACTION_FIELD_IDS = Object.freeze([
    'text', 'assignee', 'due', 'timestamp', 'meeting_title', 'meeting_date',
]);

/**
 * Datatable column types that can hold one of our values.
 *
 * NARROWED ON PURPOSE. Every value here is a string, and Postgres refuses a
 * string into a numeric or boolean column — a mapping onto `number` would be
 * a 500 the person could not read, from a menu that offered it. `date` and
 * `datetime` stay in because `due` and `meeting_date` are ISO days.
 */
const WRITABLE_COLUMN_TYPES = Object.freeze(['text', 'richtext', 'select', 'date', 'datetime']);

/** Columns the server sets itself; a client may never write them. */
const SYSTEM_COLUMNS = Object.freeze(['id', 'created_at', 'updated_at', 'created_by', 'org_id']);

/** A trimmed string, or '' for anything that is not text. */
function str(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** The meeting day as "YYYY-MM-DD", or ''. */
function meetingDate(meeting) {
    const raw = str(meeting?.createdAt);
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
}

/**
 * ONE allow-listed field of an action, as a string.
 *
 * A switch, not a lookup on the item: an id that is not on the list answers
 * '' instead of reaching into the record for a key of that name.
 */
export function actionFieldValue(fieldId, item, meeting = null) {
    switch (fieldId) {
        case 'text': return str(item?.text);
        case 'assignee': return str(item?.assignee);
        case 'due': return str(item?.due);
        case 'timestamp': return str(item?.timestamp);
        case 'meeting_title': return str(meeting?.title);
        case 'meeting_date': return meetingDate(meeting);
        default: return '';
    }
}

/**
 * The payload a manually-started routine enters with.
 *
 * Shape is FIXED — every key present, '' when the action has no value — so a
 * routine binding to `trigger.output.action.assignee` gets an empty string
 * rather than `undefined` on the one meeting where nobody was named. A binding
 * that silently resolves to undefined is the failure BFSF-408 already cost us
 * once.
 */
export function buildAutomationPayload(item, meeting = null) {
    return {
        source: 'meeting_notes',
        action: {
            text: actionFieldValue('text', item, meeting),
            assignee: actionFieldValue('assignee', item, meeting),
            due: actionFieldValue('due', item, meeting),
            timestamp: actionFieldValue('timestamp', item, meeting),
        },
        meeting: {
            id: str(meeting?.id),
            title: actionFieldValue('meeting_title', item, meeting),
            date: actionFieldValue('meeting_date', item, meeting),
        },
    };
}

/**
 * The columns of a table this picker may write to.
 *
 * Drops computed columns (derived, never written), the five system columns,
 * and every type that cannot hold a string. A table whose only free column is
 * a number therefore offers nothing — which is the honest answer, not an
 * option that 500s.
 */
export function writableColumns(fields) {
    if (!Array.isArray(fields)) return [];
    return fields.filter((f) => f
        && typeof f.key === 'string' && f.key
        && !SYSTEM_COLUMNS.includes(f.key)
        && WRITABLE_COLUMN_TYPES.includes(f.type));
}

/**
 * The mapping a freshly-picked table starts with: the action's text into the
 * first column that can hold a sentence, and nothing else. Guessing further
 * (an "owner" column, a "due" column) means guessing by column NAME, and a
 * wrong guess writes a person's name into a column other people read.
 */
export function defaultRowMapping(fields) {
    const first = writableColumns(fields).find((f) => f.type === 'text' || f.type === 'richtext');
    return first ? { [first.key]: 'text' } : {};
}

/**
 * `{ values }` for `POST /api/datatables/:id/rows`, built from the mapping.
 *
 * Three narrowings, all of them fail-closed:
 *   - a column the schema does not (still) have is skipped — the compiler
 *     answers `unknown field: …` for the WHOLE row, so one stale mapping entry
 *     would lose the other columns too;
 *   - a field id outside the allow-list contributes nothing;
 *   - an empty value is left out rather than written as '' — an empty string
 *     into a `date` column is a Postgres error, and an empty cell is what the
 *     person means anyway.
 */
export function buildRowValues(item, meeting, mapping, fields) {
    const allowed = new Map(writableColumns(fields).map((f) => [f.key, f]));
    const values = {};
    for (const [columnKey, fieldId] of Object.entries(mapping || {})) {
        if (!allowed.has(columnKey)) continue;
        if (!ACTION_FIELD_IDS.includes(fieldId)) continue;
        const value = actionFieldValue(fieldId, item, meeting);
        if (!value) continue;
        values[columnKey] = value;
    }
    return values;
}

/**
 * The body for `POST /api/kb/:id/sources` with `kind:'text'` (the K1 text
 * source).
 *
 * `labels` comes from the caller's `t()`; a missing label falls back to the
 * bare field id, which is a machine value rather than English nobody can
 * translate. The server refuses a body under three characters, so an action
 * with no text produces `null` here instead of a request that 400s.
 */
export function buildKbSource(item, meeting, { labels = {} } = {}) {
    const text = actionFieldValue('text', item, meeting);
    if (text.length < 3) return null;
    const lines = [text];
    for (const fieldId of ['assignee', 'due', 'timestamp', 'meeting_title', 'meeting_date']) {
        const value = actionFieldValue(fieldId, item, meeting);
        if (value) lines.push(`${labels[fieldId] || fieldId}: ${value}`);
    }
    const title = (actionFieldValue('meeting_title', item, meeting) || text).slice(0, 200);
    return { kind: 'text', name: title, config: { title, text: lines.join('\n') } };
}

/**
 * The `destination` record the note stores — the shape
 * `core/meetingNotes/actionItems.js` validates.
 *
 * `ref` is the CONTAINER (the routine, the table, the knowledge base): known
 * before the write is attempted, so it is always there and is what the chip
 * links to. `itemRef` is what the write created inside it (the run, the row,
 * the source) and is OPTIONAL — `POST /api/automation/:id/run` answers 202
 * with no run id when a run outlives its 60-second window, and the run really
 * did start. Recording no itemRef says "sent to this routine"; inventing one
 * would be a lie the chip then linked to.
 *
 * An unknown kind or a missing ref answers `null`: better no chip than a chip
 * no code can resolve.
 */
export function destinationRecord(kind, { ref, label = '', itemRef = '' } = {}) {
    if (!DESTINATION_KINDS.includes(kind)) return null;
    const id = str(ref);
    if (!id) return null;
    const record = { kind, ref: id, label: str(label), at: new Date().toISOString() };
    const item = str(itemRef);
    if (item) record.itemRef = item;
    return record;
}

/**
 * The FULL action list with one item's destination replaced.
 *
 * Full, because `PATCH /api/transcriptions/:id` REPLACES the column: sending
 * only the item that changed would delete every other action on the note —
 * including the ones a person typed themselves, which is the very thing M3
 * exists to protect. An id that is not in the list changes nothing and still
 * answers the whole list, so a stale card can never truncate it either.
 */
export function applyDestination(items, itemId, destination) {
    const list = Array.isArray(items) ? items : [];
    return list.map((item) => {
        if (!item || item.id !== itemId) return item;
        if (!destination) {
            const { destination: _dropped, ...rest } = item;
            return rest;
        }
        return { ...item, destination };
    });
}
