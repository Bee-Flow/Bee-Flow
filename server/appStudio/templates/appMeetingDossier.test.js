/**
 * Meeting dossier — the checks templates.test.js cannot make.
 *
 * The generic suite proves this template canonicalizes, validates, and that its
 * seed rows conform to their columns. None of that can catch the two failures
 * this template is actually exposed to.
 *
 * THE FIRST is the one the whole app exists to prevent: a model quietly
 * assigning work. Nothing in the schema stops an `ai_extract` mapping from
 * pointing at `owner_name`, and nothing in the validator would complain — the
 * column exists, the schema field exists, the write succeeds. The app would
 * then look identical and mean the opposite: a machine handing out tasks with a
 * human rubber-stamp bolted on afterwards. So the mapping is asserted against an
 * ALLOWLIST of evidence columns, and `confirmation: 'suggested'` is asserted to
 * be a writeTo CONSTANT (constants are applied after the mapped values, so
 * nothing the model returns can reach it).
 *
 * THE SECOND is retention. A decision or action that outlives its recording is
 * only defensible if it can still be checked, so every extracted row must carry
 * the sentence it came from — and the purge must actually clear BOTH the file
 * and the transcript, not just the file. The seed ships a recording that has
 * already been purged and one that is past its retention date, so both halves
 * of that story are visible on the first screen a customer sees.
 *
 * Plus the usual structural ones: the vocabularies agreeing across tables that
 * cannot be joined, the denormalised copies agreeing with what they copied, no
 * server step reading a scope root the server leaves empty, and every mutation
 * refreshing the table it dirtied.
 *
 * Run: cd server && node --test appStudio/templates/appMeetingDossier.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appMeetingDossier');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SYSTEM_COLUMNS } = require('../dataModel');

const { seed, dataModel, definition } = template;

const rowsOf = (tableId) => seed[tableId] || [];
const keysOf = (tableId, key) => new Set(rowsOf(tableId).map((r) => r[key]));
const tableOf = (tableId) => dataModel.tables.find((t) => t.id === tableId);
const fieldKeys = (tableId) => new Set((tableOf(tableId).fields || []).map((f) => f.key));

/** Every node in the definition, flattened. */
function allNodes(def) {
    const out = [];
    const walk = (children) => {
        for (const child of children || []) {
            out.push(child);
            if (Array.isArray(child.children)) walk(child.children);
        }
    };
    for (const screen of def.screens || []) {
        for (const section of screen.sections || []) walk(section.children);
    }
    return out;
}

const CANON = canonicalizeAppDefinition(definition).def;
const NODES = allNodes(CANON);
const nodeById = (id) => NODES.find((n) => n.id === id);

/** Every step in an action, including the ones inside condition branches. */
function flatSteps(action) {
    const out = [];
    const walk = (steps) => {
        for (const s of steps || []) {
            out.push(s);
            for (const branch of ['then', 'else', 'steps']) if (Array.isArray(s[branch])) walk(s[branch]);
        }
    };
    walk(action.kind === 'sequence' ? action.steps : [action]);
    return out;
}

const allSteps = () => {
    const out = [];
    for (const [actionId, action] of Object.entries(definition.actions)) {
        for (const step of flatSteps(action)) out.push({ actionId, step });
    }
    return out;
};

const extractSteps = () => allSteps().filter(({ step }) => step.kind === 'ai_extract');

// ===========================================================================
// THE ONE DECISION: an extracted item is a suggestion until a person owns it.
// ===========================================================================

/**
 * The columns a model is allowed to fill. Everything here is EVIDENCE — what
 * the transcript said — and nothing here is a commitment by a named person.
 * `owner_name`, `owner_email`, `due_date`, `decided_by`, `decided_on`,
 * `confirmed_by` and `confirmed_at` are deliberately absent: those are the
 * columns a human fills in on the Review screen, and an extraction that wrote
 * them would turn a suggestion into an assignment without anyone noticing.
 */
const MODEL_MAY_WRITE = new Set([
    'statement', 'rationale', 'title', 'detail',
    'decided_by_hint', 'owner_hint', 'due_hint',
    'source_quote', 'source_timecode',
]);

test('the extraction has at least one pass over decisions and one over actions', () => {
    const targets = extractSteps().map(({ step }) => step.writeTo.tableId).sort();
    assert.deepEqual(targets, ['tbl_mdact', 'tbl_mddec'],
        'the app claims to read both decisions and actions out of a transcript');
});

test('a model never writes an owner, a due date or who took a decision', () => {
    const offences = [];
    for (const { actionId, step } of extractSteps()) {
        for (const column of Object.keys(step.writeTo.mapping || {})) {
            if (!MODEL_MAY_WRITE.has(column)) offences.push(`${actionId} maps a model output onto ${step.writeTo.tableId}.${column}`);
        }
    }
    assert.deepEqual(offences, []);
});

test('every extracted row lands as a suggestion, stamped by a constant the model cannot reach', () => {
    for (const { actionId, step } of extractSteps()) {
        const constants = step.writeTo.constants || {};
        assert.deepEqual(constants.confirmation, { kind: 'static', value: 'suggested' },
            `${actionId} must stamp confirmation:'suggested' as a writeTo constant`);
        assert.deepEqual(constants.origin, { kind: 'static', value: 'extracted' },
            `${actionId} must record that a model produced the row`);
        // The mapping must not name the column the constant owns — constants are
        // applied last, but an author reading the mapping should never think a
        // model gets a say in it.
        assert.equal('confirmation' in (step.writeTo.mapping || {}), false);
    }
});

test('the deadline the transcript said out loud is kept as words, never as a date', () => {
    const actionsExtract = extractSteps().find(({ step }) => step.writeTo.tableId === 'tbl_mdact');
    const dueHint = actionsExtract.step.schema.find((f) => f.name === 'due_hint');
    assert.ok(dueHint, 'the action extraction must capture any deadline that was said');
    assert.equal(dueHint.type, 'string', 'a model converting "before the next board" into a date is the guess this app refuses');
    assert.match(dueHint.description, /not convert/i, 'the schema description IS the instruction — ai_extract has no prompt field');

    const column = (tableOf('tbl_mdact').fields || []).find((f) => f.key === 'due_hint');
    assert.equal(column.type, 'text', 'a date column here would force the conversion the schema refuses to make');
    const real = (tableOf('tbl_mdact').fields || []).find((f) => f.key === 'due_date');
    assert.equal(real.type, 'date', 'the date a person picks is a real date');
});

test('the hint columns are never read back as if they were the record', () => {
    const offences = [];
    for (const { actionId, step } of allSteps()) {
        if (!['create_record', 'update_record'].includes(step.kind)) continue;
        for (const [column, binding] of Object.entries(step.values || {})) {
            if (binding && typeof binding.expr === 'string' && /_hint\b/.test(binding.expr)) {
                offences.push(`${actionId} writes ${column} from ${binding.expr} — a hint must be typed over, not copied`);
            }
        }
    }
    assert.deepEqual(offences, []);
});

/**
 * Pre-filling is fine — it is what makes agreeing one click. Writing is not. The
 * hint reaches the input through `valueFrom`, and what gets SAVED is whatever
 * the person left in the box (`form.*`).
 */
test('confirming reads the owner from the form, with the hint only pre-filling the field', () => {
    const ownerInput = nodeById('cmp_rvaf1');
    assert.equal(ownerInput.props.valueFrom.kind, 'formula');
    assert.match(ownerInput.props.valueFrom.expr, /owner_hint/, 'the suggestion should pre-fill');
    assert.equal(ownerInput.props.required, true, 'confirming without an owner is not confirming');

    const confirm = flatSteps(definition.actions.act_rvactok).find((s) => s.kind === 'update_record');
    assert.equal(confirm.values.owner_name.expr, 'form.owner_name');
    assert.equal(confirm.values.confirmation.value, 'confirmed');
    assert.equal(confirm.values.confirmed_by.expr, 'currentUser.name');

    // The due date is NOT pre-filled: turning "before the next board" into a
    // date is precisely the judgement being asked for.
    const dueInput = nodeById('cmp_rvaf3');
    assert.deepEqual(dueInput.props.valueFrom, { kind: 'static', value: null });
    assert.equal(dueInput.props.required, true);
});

test('confirming a decision records who took it, from the form', () => {
    const confirm = flatSteps(definition.actions.act_rvdecok).find((s) => s.kind === 'update_record');
    assert.equal(confirm.values.decided_by.expr, 'form.decided_by');
    assert.equal(confirm.values.decided_on.expr, 'form.decided_on');
    assert.equal(confirm.values.confirmation.value, 'confirmed');
});

test('a rejected suggestion is marked discarded, never deleted', () => {
    for (const actionId of ['act_rvdecno', 'act_rvactno']) {
        const steps = flatSteps(definition.actions[actionId]);
        assert.equal(steps.some((s) => s.kind === 'delete_record'), false,
            `${actionId} must keep the row — what a model proposed and a person rejected is a record too`);
        const update = steps.find((s) => s.kind === 'update_record');
        assert.equal(update.values.confirmation.value, 'discarded');
    }
});

/** The payoff of the whole distinction: the tracking screens ignore suggestions. */
test('the board and the log show confirmed rows only; the queue shows suggestions only', () => {
    const board = nodeById('cmp_ackb');
    const boardScope = board.props.source.filter.find((f) => f.field === 'confirmation');
    assert.equal(boardScope.value, 'confirmed');

    const log = nodeById('cmp_dcgrid');
    assert.equal(log.props.source.filter.find((f) => f.field === 'confirmation').value, 'confirmed');

    for (const id of ['cmp_rvdecs', 'cmp_rvacts']) {
        const queue = nodeById(id);
        assert.equal(queue.props.source.filter.find((f) => f.field === 'confirmation').value, 'suggested');
    }
});

test('the by-hand path produces confirmed rows directly — there is nothing to review', () => {
    for (const [actionId, tableId] of [['act_mddecadd', 'tbl_mddec'], ['act_mdactadd', 'tbl_mdact']]) {
        const create = flatSteps(definition.actions[actionId]).find((s) => s.kind === 'create_record');
        assert.equal(create.tableId, tableId);
        assert.equal(create.values.confirmation.value, 'confirmed');
        assert.equal(create.values.origin.value, 'manual', 'the two routes must stay distinguishable afterwards');
        assert.equal(create.values.confirmed_by.expr, 'currentUser.name');
    }
});

// ===========================================================================
// PROVENANCE AND RETENTION
// ===========================================================================

test('every extraction demands the sentence it based the row on', () => {
    for (const { actionId, step } of extractSteps()) {
        const quote = step.schema.find((f) => f.name === 'source_quote');
        assert.ok(quote, `${actionId} must capture the transcript sentence`);
        assert.equal(quote.required, true, 'a row nobody can check against the transcript is not reviewable');
        assert.equal(step.writeTo.mapping.source_quote, 'source_quote', 'and it must actually be stored');
    }
});

test('every extraction stamps which meeting the rows came out of', () => {
    for (const { actionId, step } of extractSteps()) {
        const constants = step.writeTo.constants || {};
        for (const column of ['meeting_id', 'meeting_title', 'meeting_date', 'extracted_at']) {
            assert.ok(constants[column], `${actionId} writes rows with no ${column} — they would be orphans nobody could show in context`);
        }
        assert.equal(constants.extracted_at.expr, 'now');
    }
});

/**
 * The retention story in one step. Clearing the file but leaving the transcript
 * would be the worst of both worlds: the words everyone said, kept, with the
 * audit trail claiming the recording was deleted.
 */
test('purging clears the file AND the transcript, and leaves a tombstone', () => {
    const purge = flatSteps(definition.actions.act_mdpurge);
    assert.ok(purge.some((s) => s.kind === 'confirm'), 'an irreversible deletion asks first');

    const update = purge.find((s) => s.kind === 'update_record');
    assert.equal(update.tableId, 'tbl_mdrec');
    // Explicit static nulls: a bare null in a binding prop is wrapped by
    // canonicalize, which is a structural repair.
    assert.deepEqual(update.values.media, { kind: 'static', value: null });
    assert.deepEqual(update.values.transcript_text, { kind: 'static', value: null });
    assert.deepEqual(update.values.purged, { kind: 'static', value: true });
    assert.equal(update.values.purged_on.expr, 'today');

    assert.equal(purge.some((s) => s.kind === 'delete_record'), false,
        'the row stays: "there was a recording and it was deleted on the 2nd" has to remain answerable');
});

test('the transcript is one field on one row, so a purge is one write', () => {
    const recordings = tableOf('tbl_mdrec');
    assert.ok(recordings.fields.some((f) => f.key === 'transcript_text' && f.type === 'richtext'));
    // A transcript_segments-shaped child table would need a bulk delete the
    // platform has no step for — see the module header.
    const segmentish = dataModel.tables.filter((t) => t.id !== 'tbl_mdrec'
        && (t.fields || []).some((f) => /transcript|segment/.test(f.key)));
    assert.deepEqual(segmentish.map((t) => t.key), [],
        'no second table may hold transcript text — retention could not reach it in one write');
});

test('the seed ships a purged recording whose decisions and actions survived it', () => {
    const purged = rowsOf('tbl_mdrec').find((r) => r.purged === true);
    assert.ok(purged, 'the retention story has to be visible on install, not just described');
    assert.equal(purged.media, undefined, 'a purged recording must carry no file');
    assert.equal(purged.transcript_text, undefined, 'nor a transcript');
    assert.ok(purged.purged_on, 'the tombstone needs a date');

    const meetingAlias = purged.meeting_id.$ref;
    const survivors = [...rowsOf('tbl_mddec'), ...rowsOf('tbl_mdact')]
        .filter((r) => r.meeting_id && r.meeting_id.$ref === meetingAlias);
    assert.ok(survivors.length, 'the purged meeting must still have its minute');
    for (const row of survivors) {
        assert.ok(row.source_quote, `"${row.statement || row.title}" outlived its recording with nothing to check it against`);
    }
});

test('the seed leaves one recording past its retention date, so the tile is not zero', () => {
    const tile = nodeById('cmp_mmst3');
    const clauses = tile.props.value.filter;
    assert.equal(clauses.find((c) => c.field === 'retention_until').value.expr, 'today',
        'the tile must be true on the day it is read, not the day it was authored');
    assert.equal(clauses.find((c) => c.field === 'purged').value, false);

    // The seeded dates are fixed, so compare them to the seeded meeting dates
    // rather than to the wall clock: the newest meeting here is 2026-08-11, and
    // a recording whose retention ran out before that is overdue by the app's
    // own calendar however long this template sits in the gallery.
    const latestMeeting = rowsOf('tbl_mdmeet').map((m) => m.meeting_date).sort().pop();
    const overdue = rowsOf('tbl_mdrec').filter((r) => !r.purged && r.retention_until && r.retention_until < latestMeeting);
    assert.ok(overdue.length >= 1, 'nothing in the seed is overdue, so the retention tile reads 0 and the feature is invisible');
});

test('a recording carries its own retention date, because there is no join to the meeting', () => {
    const recordings = tableOf('tbl_mdrec');
    assert.ok(recordings.fields.some((f) => f.key === 'retention_until' && f.type === 'date'));
    const add = flatSteps(definition.actions.act_mdrecadd).find((s) => s.kind === 'create_record');
    assert.equal(add.values.retention_until.expr, 'vars.meeting.retention_until',
        'the copy has to be written when the row is created — nothing else maintains it');
});

// ===========================================================================
// THE VOCABULARIES AGREE ACROSS TABLES NOTHING CAN JOIN
// ===========================================================================

test('every seeded action is in a status the status table defines', () => {
    const statuses = keysOf('tbl_mdstat', 'key');
    for (const row of rowsOf('tbl_mdact')) {
        assert.ok(statuses.has(row.status), `action "${row.title}" is in status "${row.status}", which action_statuses does not define — the card would fall into a trailing column`);
    }
});

test('every seeded meeting has a kind the kind table defines', () => {
    const kinds = keysOf('tbl_mdkind', 'key');
    for (const row of rowsOf('tbl_mdmeet')) {
        assert.ok(kinds.has(row.kind), `meeting "${row.title}" is a "${row.kind}", which meeting_kinds does not define`);
    }
});

/**
 * The kanban drag hardcodes the terminal status key, because a server step
 * cannot read a column's `category` out of action_statuses — there is no join.
 * If that key were ever renamed on Setup without changing the action, dragging
 * to Done would silently stop stamping a completion date.
 */
test('the terminal status the drag special-cases really exists, and really counts as done', () => {
    const move = definition.actions.act_acmove;
    const guard = move.steps.find((s) => s.kind === 'condition');
    const key = guard.expr.match(/'([a-z0-9_]+)'/)[1];

    const status = rowsOf('tbl_mdstat').find((s) => s.key === key);
    assert.ok(status, `the drag stamps completed_at for status "${key}", which the seeded vocabulary does not contain`);
    assert.equal(status.category, 'done');

    const done = guard.then.find((s) => s.kind === 'update_record');
    assert.equal(done.values.completed_at.expr, 'now');
    const notDone = guard.else.find((s) => s.kind === 'update_record');
    assert.deepEqual(notDone.values.completed_at, { kind: 'static', value: null },
        'dragging back out of Done must clear the completion date, not leave a stale one');
});

test('the status an extraction stamps is one the board has a column for', () => {
    const statuses = keysOf('tbl_mdstat', 'key');
    const actionsExtract = extractSteps().find(({ step }) => step.writeTo.tableId === 'tbl_mdact');
    assert.ok(statuses.has(actionsExtract.step.writeTo.constants.status.value));
});

test('the board reads its columns from the status table, and groups by what an action stores', () => {
    const board = nodeById('cmp_ackb');
    assert.equal(board.props.groupByField, 'status');
    assert.equal(board.props.columnsSource.tableId, 'tbl_mdstat');
    // normalizeAxisRows reads the column value from value|state|key and the
    // label from label|name. action_statuses carries `key` and `name`; renaming
    // either side without the other drops every card into a trailing column.
    assert.ok(fieldKeys('tbl_mdstat').has('key'));
    assert.ok(fieldKeys('tbl_mdstat').has('name'));
    assert.ok(fieldKeys('tbl_mdact').has(board.props.groupByField));
});

/**
 * There are no joins, so the decision log reads DENORMALISED copies of the
 * meeting. A copy that disagrees with its source is worse than no copy: the log
 * would attribute a decision to a meeting it was not taken in.
 */
test('every denormalised meeting copy agrees with the meeting it copied', () => {
    const byAlias = new Map(rowsOf('tbl_mdmeet').filter((m) => m.$id).map((m) => [m.$id, m]));
    const checks = [
        ['tbl_mddec', ['meeting_title', 'title'], ['meeting_date', 'meeting_date']],
        ['tbl_mdact', ['meeting_title', 'title'], ['meeting_date', 'meeting_date']],
        ['tbl_mdrec', ['meeting_title', 'title'], ['retention_until', 'retention_until']],
    ];
    for (const [tableId, ...pairs] of checks) {
        for (const row of rowsOf(tableId)) {
            if (!row.meeting_id) continue;
            const meeting = byAlias.get(row.meeting_id.$ref);
            assert.ok(meeting, `${tableId} row references alias "${row.meeting_id.$ref}", which is not seeded`);
            for (const [copy, source] of pairs) {
                if (row[copy] === undefined) continue;
                assert.equal(row[copy], meeting[source],
                    `${tableId}.${copy} says ${JSON.stringify(row[copy])} but its meeting says ${JSON.stringify(meeting[source])}`);
            }
        }
    }
});

test('a superseding decision carries a copy of what it replaced', () => {
    const byAlias = new Map(rowsOf('tbl_mddec').filter((d) => d.$id).map((d) => [d.$id, d]));
    const replacement = rowsOf('tbl_mddec').find((d) => d.supersedes_id);
    assert.ok(replacement, 'the seed must show the chain, not just allow it');
    const old = byAlias.get(replacement.supersedes_id.$ref);
    assert.ok(old, 'a superseding decision must point at a seeded earlier row');
    assert.equal(replacement.supersedes_statement, old.statement,
        'the copy is what a reader sees — there is no join to fetch the original wording');
    assert.equal(old.state, 'superseded', 'the replaced decision must actually be marked as replaced');

    const save = flatSteps(definition.actions.act_dcsupsave);
    const create = save.find((s) => s.kind === 'create_record');
    assert.equal(create.values.supersedes_statement.expr, 'vars.decision.statement');
    const mark = save.find((s) => s.kind === 'update_record');
    assert.equal(mark.values.state.value, 'superseded');
});

test('a decision is superseded, never deleted — by anybody', () => {
    for (const [actionId, action] of Object.entries(definition.actions)) {
        for (const step of flatSteps(action)) {
            assert.notEqual(step.tableId === 'tbl_mddec' && step.kind === 'delete_record', true,
                `${actionId} deletes a decision; the log stops being a record the moment that is possible`);
        }
    }
    const grants = tableOf('tbl_mddec').access.roles;
    for (const [role, grant] of Object.entries(grants)) {
        assert.equal(grant.delete, false, `role "${role}" may delete decisions`);
    }
});

// ===========================================================================
// THE SEED IS COHERENT WITH THE RULE THE APP ENFORCES
// ===========================================================================

test('no seeded suggestion has an owner, a due date or a confirmation', () => {
    const OWNED = ['owner_name', 'owner_email', 'due_date', 'decided_by', 'decided_on', 'confirmed_by', 'confirmed_at'];
    for (const tableId of ['tbl_mddec', 'tbl_mdact']) {
        for (const row of rowsOf(tableId)) {
            if (row.confirmation !== 'suggested') continue;
            for (const key of OWNED) {
                assert.equal(row[key], undefined,
                    `a suggested row ("${row.statement || row.title}") already carries ${key} — the seed contradicts the rule the app is built on`);
            }
        }
    }
});

test('every seeded confirmed row records who confirmed it and when', () => {
    for (const tableId of ['tbl_mddec', 'tbl_mdact']) {
        for (const row of rowsOf(tableId)) {
            if (row.confirmation !== 'confirmed') continue;
            assert.ok(row.confirmed_by, `"${row.statement || row.title}" is confirmed by nobody`);
            assert.ok(row.confirmed_at, `"${row.statement || row.title}" is confirmed at no time`);
        }
    }
    for (const row of rowsOf('tbl_mdact')) {
        if (row.confirmation !== 'confirmed') continue;
        assert.ok(row.owner_name, `confirmed action "${row.title}" has no owner — confirming IS taking it on`);
    }
});

test('every seeded extracted row quotes the transcript; every hand-written one does not pretend to', () => {
    for (const tableId of ['tbl_mddec', 'tbl_mdact']) {
        for (const row of rowsOf(tableId)) {
            if (row.origin === 'extracted') {
                assert.ok(row.source_quote, `extracted row "${row.statement || row.title}" has no quote to check it against`);
                assert.ok(row.extracted_at, `extracted row "${row.statement || row.title}" has no extraction timestamp`);
            } else {
                assert.equal(row.owner_hint, undefined, 'a hand-written row has no model hint to carry');
                assert.equal(row.decided_by_hint, undefined);
            }
        }
    }
});

test('the review queue is not empty on install, and one suggestion names nobody at all', () => {
    const suggestions = [...rowsOf('tbl_mddec'), ...rowsOf('tbl_mdact')].filter((r) => r.confirmation === 'suggested');
    assert.ok(suggestions.length >= 3, 'a reviewer opening the app must have something to review');
    // The case the whole design is for: the transcript named nobody, so the
    // extraction leaves the hint empty rather than picking whoever spoke.
    assert.ok(suggestions.some((r) => !r.owner_hint && !r.decided_by_hint),
        'the seed must show what an honest empty hint looks like');
});

test('the seed shows a route with no audio and no AI at all', () => {
    const typed = rowsOf('tbl_mdrec').find((r) => r.source === 'notes');
    assert.ok(typed, 'the template claims it works by typing notes in — the seed has to show it');
    assert.ok(typed.transcript_text, 'and that route has to produce something readable');
    assert.equal(typed.transcription_status, 'none');

    const byHand = rowsOf('tbl_mdact').filter((r) => r.origin === 'manual' && r.confirmation === 'confirmed');
    assert.ok(byHand.length, 'and it has to end in tracked work like every other route');
});

// ===========================================================================
// DEGRADING SENSIBLY WITH NOTHING SELECTED
// ===========================================================================

test('the home screen shows everything with no selection at all', () => {
    assert.equal(CANON.homeScreenId, 'scr_meetings');
    const list = nodeById('cmp_mmlist');
    for (const clause of list.props.source.filter || []) {
        assert.notEqual(clause.required, true,
            'the first list a visitor sees must not depend on a selection they have not made yet');
    }
});

/**
 * The Dossier is ABOUT one meeting, so it refuses to guess: required:true means
 * it shows its emptyText until a meeting is picked, rather than mixing four
 * meetings' recordings into one list. The queue, the board and the log are the
 * opposite — an optional filter resolving to null is omitted entirely, so with
 * nothing selected they show everything, which is what those screens are for.
 */
test('the dossier scopes hard to one meeting; the queue, board and log widen to all of them', () => {
    for (const id of ['cmp_mdrecs', 'cmp_mdspkg']) {
        const scope = nodeById(id).props.source.filter.find((f) => f.field === 'meeting_id');
        assert.equal(scope.required, true, `${id} must show nothing rather than every meeting's media at once`);
    }
    for (const id of ['cmp_rvdecs', 'cmp_rvacts', 'cmp_ackb', 'cmp_dcgrid']) {
        const scope = nodeById(id).props.source.filter.find((f) => f.field === 'meeting_id');
        assert.ok(scope, `${id} must be able to narrow to a meeting`);
        assert.notEqual(scope.required, true, `${id} would render permanently empty with no meeting selected`);
    }
});

test('every component that can be empty says something useful instead', () => {
    const offences = [];
    for (const node of NODES) {
        if (!('emptyText' in (node.props || {}))) continue;
        const text = node.props.emptyText;
        if (typeof text !== 'string' || text.length < 12) offences.push(`${node.id}: ${JSON.stringify(text)}`);
    }
    assert.deepEqual(offences, []);
});

test('clearing the meeting is a control, not a dead end', () => {
    const clear = definition.actions.act_mmclear;
    const names = clear.steps.filter((s) => s.kind === 'set_variable').map((s) => s.name);
    assert.deepEqual(names, ['meeting', 'rec']);
    for (const step of clear.steps) assert.deepEqual(step.value, { kind: 'static', value: null });

    // Picking a different meeting must clear the recording too, or the Dossier
    // shows the previous meeting's transcript under the new meeting's title.
    const pick = definition.actions.act_mmpick;
    const stale = pick.steps.find((s) => s.name === 'rec');
    assert.deepEqual(stale.value, { kind: 'static', value: null });
});

/** Every button that needs a selection is either hidden or guarded, never both-and-broken. */
test('every write that needs a selection says which screen to go to when there is none', () => {
    for (const actionId of ['act_mdrecadd', 'act_mdspkadd', 'act_mddecadd', 'act_mdactadd', 'act_mdtrans', 'act_mdextract', 'act_mdpurge']) {
        const action = definition.actions[actionId];
        const guard = action.steps.find((s) => s.kind === 'condition');
        assert.ok(guard, `${actionId} writes without checking there is something to write against`);
        assert.ok(Array.isArray(guard.else) && guard.else.some((s) => s.kind === 'toast'),
            `${actionId} fails silently when nothing is selected`);
        assert.equal(action.steps.some((s) => ['create_record', 'update_record', 'ai_extract'].includes(s.kind)), false,
            `${actionId} has an unguarded write outside the condition`);
    }
});

// ===========================================================================
// ACCESS — the recording is not the same artefact as the minute
// ===========================================================================

test('the media is readable by the secretary only', () => {
    for (const tableId of ['tbl_mdrec', 'tbl_mdspk']) {
        const roles = tableOf(tableId).access.roles;
        assert.equal(tableOf(tableId).access.default, 'role', `${tableId} must not fall back to app-wide access`);
        assert.equal(roles.secretary.read, 'all');
        assert.equal(roles.member.read, 'none', `${tableId}: a team member must not be able to read the tape`);
        assert.equal(roles.auditor.read, 'none', `${tableId}: an auditor checks the decision log, not the recording`);
    }
});

test('the minute is readable by everyone, and the meeting metadata with it', () => {
    for (const tableId of ['tbl_mddec', 'tbl_mdact', 'tbl_mdmeet']) {
        const roles = tableOf(tableId).access.roles;
        for (const role of ['secretary', 'member', 'auditor']) {
            assert.equal(roles[role].read, 'all', `${tableId}: role "${role}" cannot read what the app is for`);
        }
    }
});

/**
 * ai_extract writes its rows as the VIEWER. Without create:true on the role that
 * presses the button, "Read decisions and actions out of it" answers 403 for
 * everyone except the app owner — and does so only in production, where the
 * viewer is not the owner.
 */
test('the role that runs the extraction may create the rows it produces', () => {
    for (const { step } of extractSteps()) {
        const roles = tableOf(step.writeTo.tableId).access.roles;
        assert.equal(roles.secretary.create, true,
            `${step.writeTo.tableId}: the extraction runs as the viewer, so the secretary needs create`);
    }
    // And the auditor must not be able to write the log they audit.
    assert.equal(tableOf('tbl_mddec').access.roles.auditor.create, false);
    assert.equal(tableOf('tbl_mdact').access.roles.auditor.update, false);
});

test('every table states its access explicitly rather than defaulting to app-wide', () => {
    for (const table of dataModel.tables) {
        assert.equal(table.access.default, 'role', `${table.key} falls back to app-wide access`);
        const roles = Object.keys(table.access.roles);
        assert.deepEqual(roles.sort(), ['auditor', 'member', 'secretary'],
            `${table.key} does not say what every role may do`);
    }
});

// ===========================================================================
// THE PLATFORM RULES THE VALIDATOR DOES NOT ENFORCE
// ===========================================================================

/**
 * A server step's formula scope has no `screen`, `forms`, `actions`, `records`
 * or `datasets`. A binding naming one of those resolves in the browser preview
 * and writes NULL in production — the worst kind of wrong, because it passes
 * every check an author can run before shipping. ai_extract is included here:
 * its writeTo constants and its promptContext filters resolve server-side too.
 */
test('no server step reads a scope root the server does not populate', () => {
    const SERVER_KINDS = new Set(['create_record', 'update_record', 'delete_record', 'ai_extract', 'ai_generate']);
    const FORBIDDEN = /^(screen|forms|actions|records|datasets)\b/;
    const offences = [];

    const check = (where, expr) => {
        if (typeof expr === 'string' && FORBIDDEN.test(expr.trim())) offences.push(`${where}: ${expr}`);
    };

    for (const { actionId, step } of allSteps()) {
        if (!SERVER_KINDS.has(step.kind)) continue;
        if (step.recordId) check(`${actionId}.recordId`, step.recordId.expr);
        if (step.expectedUpdatedAt) check(`${actionId}.expectedUpdatedAt`, step.expectedUpdatedAt.expr);
        if (step.source) check(`${actionId}.source`, step.source.expr);
        for (const [key, binding] of Object.entries(step.values || {})) {
            if (binding) check(`${actionId}.values.${key}`, binding.expr);
        }
        for (const [key, binding] of Object.entries((step.writeTo || {}).constants || {})) {
            if (binding) check(`${actionId}.writeTo.constants.${key}`, binding.expr);
        }
        for (const clause of (step.promptContext || {}).filter || []) {
            if (clause.value) check(`${actionId}.promptContext.${clause.field}`, clause.value.expr);
        }
    }
    assert.deepEqual(offences, []);
});

test('every mutation refreshes the table it dirtied', () => {
    const MUTATING = new Set(['create_record', 'update_record', 'delete_record', 'ai_extract']);
    for (const [actionId, action] of Object.entries(definition.actions)) {
        if (action.kind !== 'sequence') continue;
        const flat = flatSteps(action);
        const dirtied = new Set(flat.filter((s) => MUTATING.has(s.kind))
            .map((s) => (s.kind === 'ai_extract' ? (s.writeTo || {}).tableId : s.tableId))
            .filter(Boolean));
        if (!dirtied.size) continue;
        const refreshed = new Set(flat.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
        for (const tableId of dirtied) {
            assert.ok(refreshed.has(tableId),
                `${actionId} writes ${tableId} but never refreshes it — the change would not appear until something else refetched`);
        }
    }
});

test('every destructive action asks first', () => {
    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        if (!steps.some((s) => s.kind === 'delete_record')) continue;
        assert.ok(steps.some((s) => s.kind === 'confirm'), `${actionId} deletes without confirming`);
    }
});

/**
 * NO JOINS. Every read compiles to FROM one table, and a filter or sort may only
 * name that table's own columns. A clause naming a related table's field is an
 * error at query time, not at authoring time.
 */
test('no filter or sort names a column its own table does not have', () => {
    const offences = [];
    const visit = (obj, path) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach((o, i) => visit(o, `${path}[${i}]`)); return; }
        if ((obj.kind === 'records' || obj.kind === 'aggregate') && obj.tableId) {
            const keys = fieldKeys(obj.tableId);
            const known = (k) => keys.has(k) || SYSTEM_COLUMNS.includes(k);
            for (const clause of obj.filter || []) {
                if (clause && clause.field && !known(clause.field)) offences.push(`${path}: ${obj.tableId} has no column "${clause.field}"`);
            }
            for (const s of obj.sort || []) {
                if (s && s.field && !known(s.field)) offences.push(`${path}: ${obj.tableId} cannot sort by "${s.field}"`);
            }
            for (const g of obj.groupBy || []) {
                if (g && g.field && !known(g.field)) offences.push(`${path}: ${obj.tableId} cannot group by "${g.field}"`);
            }
        }
        Object.entries(obj).forEach(([k, v]) => visit(v, `${path}.${k}`));
    };
    visit(CANON.screens, 'screens');
    visit(definition.actions, 'actions');
    assert.deepEqual(offences, []);
});

/**
 * An aggregate binding resolves to the ROWS ARRAY. `pick` is the read-side lens
 * that narrows it to the single number a tile is for; without it the tile
 * renders the array and every KPI reads "1".
 */
test('every scalar aggregate carries a pick naming one of its own aliases', () => {
    const offences = [];
    const visit = (obj, path) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach((o, i) => visit(o, `${path}[${i}]`)); return; }
        if (obj.kind === 'aggregate' && !Array.isArray(obj.groupBy)) {
            const aliases = (obj.aggregates || []).map((a) => a.as).filter(Boolean);
            if (!obj.pick) offences.push(`${path}: no pick (would render the rows array)`);
            else if (!aliases.includes(obj.pick.column)) offences.push(`${path}: pick.column "${obj.pick.column}" is not one of [${aliases.join(', ')}]`);
            if (!obj.limit) offences.push(`${path}: no explicit limit (silently capped at 50)`);
        }
        Object.entries(obj).forEach(([k, v]) => visit(v, `${path}.${k}`));
    };
    visit(CANON.screens, 'screens');
    assert.deepEqual(offences, []);
});

test('every inline-editable grid is selectable:none, or its edits never reach the action', () => {
    for (const node of NODES) {
        if (node.type !== 'data_grid') continue;
        const editable = (node.props.columns || []).some((c) => c.editable);
        if (!editable) continue;
        assert.equal(node.props.selectable, 'none',
            `${node.id} edits inline, but with a selection mode set onRowSelect fires with { selected: rows } instead of the edited row`);
        assert.ok(node.onRowSelect, `${node.id} has editable cells wired to nothing`);
    }
});

test('a list selection formula is a bare string, not a binding object', () => {
    for (const node of NODES) {
        if (node.type !== 'list' || node.props.selectedWhen === null) continue;
        assert.equal(typeof node.props.selectedWhen, 'string', `${node.id}.selectedWhen must be a bare formula string`);
    }
});

test('there is exactly one filter bar per screen, and no variable named filters', () => {
    for (const screen of CANON.screens) {
        const bars = allNodes({ screens: [screen] }).filter((n) => n.type === 'filter_bar');
        assert.ok(bars.length <= 1, `${screen.id} has ${bars.length} filter bars; they all publish into the same vars.filters`);
    }
    assert.equal(CANON.variables.some((v) => v.name === 'filters'), false,
        '`filters` is reserved by filter_bar — declaring it is a validation error');
});

test('every fill section is a single 12-column row', () => {
    for (const screen of CANON.screens) {
        for (const section of screen.sections) {
            if (section.style.height !== 'fill') continue;
            const total = section.children.reduce((a, c) => a + (c.style.span || 0), 0);
            assert.equal(total, 12,
                `${screen.id}/${section.id} spans ${total} columns — a fill section stretches its FIRST grid row only`);
        }
    }
});

// ===========================================================================
// RUNS WITH AND WITHOUT NEXTCLOUD, AND WITH AND WITHOUT A ROUTINE
// ===========================================================================

test('nothing in the app requires Nextcloud or any connector to be configured', () => {
    const kinds = new Set();
    const collect = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(collect); return; }
        if (typeof obj.kind === 'string') kinds.add(obj.kind);
        Object.values(obj).forEach(collect);
    };
    collect(definition);
    assert.equal(kinds.has('connector'), false, 'a connector binding would need an external system configured');
    assert.equal(kinds.has('send_email'), false, 'mailing the minute would need a mailbox connector');
    assert.equal(dataModel.connectors, undefined, 'the data model must not ship a connector');
});

/**
 * The routine hop is deliberate and it is exactly one. Anywhere else,
 * automationId:null would be an unfinished button; here it is the honest edge of
 * what an app step can do — and the UI says so on two screens.
 */
test('exactly one step needs a routine, it is the transcription hop, and the app says so', () => {
    const unwired = allSteps().filter(({ step }) => step.kind === 'run_automation');
    assert.equal(unwired.length, 1, 'every other capability in this app must work with nothing wired');
    assert.equal(unwired[0].actionId, 'act_mdtrans');
    assert.equal(unwired[0].step.automationId, null);

    // And the app owns the half it can do itself: the queue flag.
    const queue = flatSteps(definition.actions.act_mdtrans).find((s) => s.kind === 'update_record');
    assert.equal(queue.values.transcription_status.value, 'queued',
        'the routine picks work up from a queue, which is the only contract that survives it running on a schedule');

    for (const id of ['cmp_mdnote', 'cmp_stnote']) {
        assert.match(nodeById(id).props.text, /routine/i, `${id} must warn that this one button needs wiring`);
    }
});

test('extraction is an app step, not a routine — it needs nothing configured', () => {
    for (const { actionId, step } of extractSteps()) {
        assert.equal(step.kind, 'ai_extract', `${actionId} must not route the extraction through an automation`);
        assert.deepEqual(step.knowledgeBaseIds, [], 'a knowledge base id would be a dangling reference on a fresh install');
    }
});

test('identity is matched on e-mail, which resolves the same embedded and standalone', () => {
    assert.ok(fieldKeys('tbl_mdppl').has('email'));
    assert.ok(fieldKeys('tbl_mdact').has('owner_email'));
    const board = nodeById('cmp_ackb');
    const mine = board.props.source.filter.find((f) => f.field === 'owner_email');
    assert.ok(mine, 'the board must be able to narrow to the viewer');
    assert.match(mine.value.expr, /currentUser\.email/);
    // A toggle that is OFF must not filter to "owned by nobody".
    assert.match(mine.value.expr, /\?/);
    assert.notEqual(mine.required, true);
});

test('the working screens are full width — they are embedded in a Nextcloud page', () => {
    for (const id of ['scr_dossier', 'scr_review', 'scr_actions']) {
        assert.equal(CANON.screens.find((s) => s.id === id).maxWidth, 'full');
    }
});
