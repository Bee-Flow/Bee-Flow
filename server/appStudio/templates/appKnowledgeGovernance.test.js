/**
 * Knowledge base governance — the checks templates.test.js cannot make.
 *
 * The generic suite proves this template canonicalizes, validates, and that its
 * seed rows conform to their columns. None of that can catch what this template
 * is actually exposed to, which is a register that AGREES WITH ITSELF.
 *
 * Two failure families, and both are silent:
 *
 *  1. THE DENORMALISED COPIES DRIFT. There are no joins, so `review_stage` is a
 *     copy of the chosen review state's category, and `base_name` /
 *     `source_title` are copies of labels on other tables. Nothing in the schema
 *     ties a copy to its original. A source whose state is `approved` but whose
 *     stage says `intake` does not error — it simply never appears on the
 *     Register, sits forever in the Review queue, and the one row a customer
 *     most needs to see is the one row that is invisible.
 *
 *  2. THE REGISTER CONTRADICTS ITSELF. A confirmed removal pointing at a source
 *     still marked `indexed` is the app asserting both "this is out" and "this
 *     is answering". The whole product claim is that this register catches that
 *     in the customer's data; shipping it in our own seed would be the most
 *     embarrassing possible bug.
 *
 * On top of those: this is a privacy product, and the seed must not itself be a
 * copy of the personal data it describes. There is a test for that too.
 *
 * Run: cd server && node --test appStudio/templates/appKnowledgeGovernance.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appKnowledgeGovernance');
const { canonicalizeAppDefinition } = require('../canonicalize');

const { seed, dataModel, definition } = template;

/**
 * The day the seed was written against. Used ONLY where a test needs "and this
 * one was NOT overdue on install" — an assertion that would otherwise start
 * failing on its own as the calendar moves past the seeded dates. Everything
 * that asserts a row IS overdue uses the real clock, because that direction only
 * ever becomes more true.
 */
const AUTHORED_TODAY = '2026-08-15';

const rowsOf = (tableId) => seed[tableId] || [];
const byAlias = (tableId) => new Map(rowsOf(tableId).filter((r) => r.$id).map((r) => [r.$id, r]));
const tableOf = (id) => dataModel.tables.find((t) => t.id === id);

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

/** Flatten an action's steps, following condition/loop/switch branches. */
function flatSteps(action) {
    const out = [];
    const walk = (steps) => {
        for (const s of steps || []) {
            out.push(s);
            for (const branch of ['then', 'else', 'steps']) {
                if (Array.isArray(s[branch])) walk(s[branch]);
            }
            for (const c of Array.isArray(s.cases) ? s.cases : []) {
                if (Array.isArray(c.steps)) walk(c.steps);
            }
        }
    };
    if (action.kind === 'sequence') walk(action.steps);
    else out.push(action);
    return out;
}

/** Every binding filter entry in the definition, with where it came from. */
function allFilterEntries(value, path = 'def', out = []) {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) {
        value.forEach((v, i) => allFilterEntries(v, `${path}[${i}]`, out));
        return out;
    }
    if (Array.isArray(value.filter) && typeof value.kind === 'string') {
        value.filter.forEach((entry, i) => {
            if (entry && typeof entry === 'object') out.push({ entry, path: `${path}.filter[${i}]` });
        });
    }
    for (const [k, v] of Object.entries(value)) allFilterEntries(v, `${path}.${k}`, out);
    return out;
}

const FILTERS = allFilterEntries(CANON);
const filterExpr = (entry) => (entry.value && entry.value.kind === 'formula' ? entry.value.expr : null);

// ── The denormalised copies agree with their originals ──────────────────────

/**
 * THE invariant of the whole template. `review_stage` is a copy of the chosen
 * state's `category`, written by act_setstate in the same step as the key. Every
 * "is this live", "is this closed" and "is this still in the queue" query in the
 * app reads the copy, because the category lives on another table and there are
 * no joins. A source where the two disagree is invisible to whichever screen it
 * ought to be on.
 */
test('every seeded source carries the stage its own review state declares', () => {
    const categoryOfState = new Map(rowsOf('tbl_rstate1').map((s) => [s.key, s.category]));
    for (const src of rowsOf('tbl_source1')) {
        const expected = categoryOfState.get(src.review_state);
        assert.ok(expected, `"${src.title}" is in state "${src.review_state}", which review_states does not define`);
        assert.equal(src.review_stage, expected,
            `"${src.title}" is in state "${src.review_state}" (which counts as "${expected}") but its denormalised stage says "${src.review_stage}" — it would be missing from every screen that queries the stage`);
    }
});

test('every seeded source names a legal basis the register recognises', () => {
    const bases = new Set(rowsOf('tbl_lbasis1').map((b) => b.key));
    for (const src of rowsOf('tbl_source1')) {
        if (src.legal_basis == null) continue;
        assert.ok(bases.has(src.legal_basis),
            `"${src.title}" claims legal basis "${src.legal_basis}", which legal_bases does not define`);
    }
});

test('every denormalised base_name matches the base the row actually points at', () => {
    const bases = byAlias('tbl_kbases1');
    const check = (tableId, label) => {
        for (const row of rowsOf(tableId)) {
            if (!row.base_id) continue;
            const base = bases.get(row.base_id.$ref);
            assert.ok(base, `${label} row references base alias "${row.base_id.$ref}", which is not seeded`);
            assert.equal(row.base_name, base.name,
                `a ${label} row is filed under "${row.base_name}" but points at "${base.name}" — the grid would name the wrong base`);
        }
    };
    check('tbl_source1', 'source');
    check('tbl_grant01', 'access grant');
});

test('every finding and retirement names the source it actually points at', () => {
    const sources = byAlias('tbl_source1');
    for (const tableId of ['tbl_finds01', 'tbl_retire1']) {
        for (const row of rowsOf(tableId)) {
            const src = sources.get(row.source_id.$ref);
            assert.ok(src, `a ${tableId} row references source alias "${row.source_id.$ref}", which is not seeded`);
            assert.equal(row.source_title, src.title,
                `a ${tableId} row is labelled "${row.source_title}" but points at "${src.title}"`);
            assert.equal(row.base_name, src.base_name,
                `a ${tableId} row is filed under base "${row.base_name}" but its source lives in "${src.base_name}"`);
        }
    }
});

/**
 * The copies are only trustworthy because ONE action writes them, and writes
 * both halves together. A branch that set the key without the stage would leave
 * the source in a state it is not, on every screen.
 */
test('setting a review state writes the key and the stage from the same clicked row', () => {
    const writes = flatSteps(definition.actions.act_setstate).filter((s) => s.kind === 'update_record');
    assert.ok(writes.length >= 2, 'both branches of the condition must write');
    for (const w of writes) {
        assert.equal(w.tableId, 'tbl_source1');
        assert.equal(w.values.review_state.expr, 'item.key');
        assert.equal(w.values.review_stage.expr, 'item.category',
            'the stage must come from the SAME state row as the key, never from a second lookup');
    }
    // Only the branch that lands on a live rung stamps who approved it.
    const stamped = writes.filter((w) => w.values.approved_by);
    assert.equal(stamped.length, 1, 'exactly one branch may record an approval');
    assert.match(stamped[0].values.approved_by.expr, /currentUser\.name/);
});

/**
 * The approval control is the config table, not a dropdown of authored options
 * — that is the whole reason review states are keys rather than a select field.
 * A hardcoded options list here would quietly re-freeze the vocabulary.
 */
test('the approval ladder on the source screen is bound to the config table', () => {
    const picker = nodeById('cmp_sostates');
    assert.equal(picker.type, 'list');
    assert.equal(picker.props.source.tableId, 'tbl_rstate1');
    assert.equal(picker.onRowClick, 'act_setstate');
    // selectedWhen is type formula = a BARE STRING, not a {kind,expr} wrapper.
    assert.equal(typeof picker.props.selectedWhen, 'string');
    assert.match(picker.props.selectedWhen, /vars\.source\.review_state/);
});

// ── The three columns are allowed to disagree, and the app looks for it ─────

/**
 * The one design decision, asserted. If a later edit ever collapsed the three
 * facts into one status column, this filter would have to change — and the
 * register would stop being able to express its own reason for existing.
 */
test('the register headline reads all three columns, not one status', () => {
    const grid = nodeById('cmp_rggrid');
    const fields = grid.props.source.filter.map((f) => f.field);
    assert.ok(fields.includes('review_stage'), 'the human decision');
    assert.ok(fields.includes('index_state'), 'where the pipeline has it');
    assert.ok(fields.includes('review_due'), 'when the decision expired');
    const due = grid.props.source.filter.find((f) => f.field === 'review_due');
    assert.equal(due.op, 'lt');
    assert.equal(due.value.expr, 'today',
        '"past its review date" must be evaluated at read time — a stored flag would be stale the day after it was written');

    const sources = tableOf('tbl_source1');
    for (const key of ['review_state', 'review_stage', 'index_state', 'review_due']) {
        assert.ok(sources.fields.some((f) => f.key === key), `sources must carry ${key} as its own column`);
    }
});

test('the seed really contains the dangerous row, so the first screen is not empty theatre', () => {
    const now = new Date().toISOString().slice(0, 10);
    const dangerous = rowsOf('tbl_source1').filter(
        (s) => s.review_stage === 'live' && s.index_state === 'indexed' && s.review_due && s.review_due < now,
    );
    assert.ok(dangerous.length >= 2,
        `expected the seed to ship sources that are approved, indexed and past review; found ${dangerous.length}`);
});

test('the seed also ships healthy live sources, so the register is not uniformly red on install', () => {
    const healthy = rowsOf('tbl_source1').filter(
        (s) => s.review_stage === 'live' && s.index_state === 'indexed' && s.review_due && s.review_due > AUTHORED_TODAY,
    );
    assert.ok(healthy.length >= 2,
        `a register where every row is a failure teaches nothing; found ${healthy.length} in-date live sources as authored`);
});

test('the seed ships sources indexed with no scan date at all — the gap the findings table cannot describe', () => {
    const unscanned = rowsOf('tbl_source1').filter((s) => s.index_state === 'indexed' && !s.scanned_on);
    assert.ok(unscanned.length >= 1,
        'a source admitted without a personal-data scan is the interesting gap; the seed must contain one');
    // And the queue's pairing: something waiting for approval that nobody scanned.
    const queuedUnscanned = rowsOf('tbl_source1').filter(
        (s) => ['intake', 'in_review'].includes(s.review_stage) && !s.scanned_on,
    );
    assert.ok(queuedUnscanned.length >= 1, 'the Review queue puts "never scanned" next to the approve button — it needs a member');
});

// ── The register never contradicts itself ──────────────────────────────────

test('the seed ships the failure the app exists to prevent: closed in the register, live in the index', () => {
    const zombies = rowsOf('tbl_source1').filter((s) => s.review_stage === 'closed' && s.index_state === 'indexed');
    assert.ok(zombies.length >= 1, 'a retired source still answering questions is the headline failure — seed one');
    // Each of them must have an OUTSTANDING removal in the log, otherwise the
    // Retirements screen offers no way to close the loop the app just flagged.
    const openRetirements = new Set(
        rowsOf('tbl_retire1').filter((r) => r.index_removed === false).map((r) => r.source_id.$ref),
    );
    for (const z of zombies) {
        assert.ok(z.$id && openRetirements.has(z.$id),
            `"${z.title}" is closed but still indexed with no unconfirmed retirement to act on — the app would flag it and offer no way to fix it`);
    }
});

test('a confirmed removal never points at a source the register still calls indexed', () => {
    const sources = byAlias('tbl_source1');
    for (const r of rowsOf('tbl_retire1')) {
        if (r.index_removed !== true) continue;
        const src = sources.get(r.source_id.$ref);
        assert.notEqual(src.index_state, 'indexed',
            `the log says "${r.source_title}" was removed from the index on ${r.removed_on}, but the source still reads "indexed" — the register would be asserting both at once`);
    }
});

test('confirming a removal writes BOTH tables, because either half alone leaves a lie', () => {
    const steps = flatSteps(definition.actions.act_confirmrm);
    const writes = steps.filter((s) => s.kind === 'update_record');
    const tables = writes.map((w) => w.tableId).sort();
    assert.deepEqual(tables, ['tbl_retire1', 'tbl_source1']);

    const logWrite = writes.find((w) => w.tableId === 'tbl_retire1');
    assert.deepEqual(logWrite.values.index_removed, { kind: 'static', value: true });

    // The relation column carries the source's record id — this is how one row
    // action reaches a second table without a join.
    const srcWrite = writes.find((w) => w.tableId === 'tbl_source1');
    assert.equal(srcWrite.recordId.expr, 'item.source_id');
    assert.deepEqual(srcWrite.values.index_state, { kind: 'static', value: 'not_indexed' });
});

/**
 * Proposing a removal must NOT claim the material has stopped being retrieved.
 * `removal_pending` is the honest state; writing `not_indexed` here would make
 * the register report a removal that nobody has actually performed.
 */
test('proposing a removal marks the source pending, never already removed', () => {
    for (const actionId of ['act_reqretire', 'act_soretire']) {
        const writes = flatSteps(definition.actions[actionId]).filter((s) => s.kind === 'update_record');
        const srcWrite = writes.find((w) => w.tableId === 'tbl_source1');
        assert.ok(srcWrite, `${actionId} must mark the source`);
        assert.deepEqual(srcWrite.values.index_state, { kind: 'static', value: 'removal_pending' },
            `${actionId} must not claim the index has dropped the material before anyone confirmed it`);
        const log = flatSteps(definition.actions[actionId]).find((s) => s.kind === 'create_record');
        assert.equal(log.tableId, 'tbl_retire1');
        assert.deepEqual(log.values.index_removed, { kind: 'static', value: false });
    }
});

// ── The app degrades sensibly with nothing selected ─────────────────────────

/**
 * `base` is a FACET and `source` is an OPEN RECORD, and the two demand opposite
 * treatment. Every filter on the base must be optional, so a cold open shows the
 * whole organisation instead of an empty app; every filter on the open source
 * must be required, so an unopened detail screen shows an empty state instead of
 * some other source's findings under this source's heading.
 */
test('every base filter is optional, so nothing selected means everything', () => {
    const scoped = FILTERS.filter(({ entry }) => /^vars\.base\b/.test(filterExpr(entry) || ''));
    assert.ok(scoped.length >= 8, 'the base facet should be reachable from most screens');
    for (const { entry, path } of scoped) {
        assert.notEqual(entry.required, true,
            `${path} is required:true on the base facet — the screen would render empty until somebody picks a base`);
    }
});

test('every open-source filter is required, so an unopened detail screen shows nothing rather than the wrong thing', () => {
    const scoped = FILTERS.filter(({ entry }) => /^vars\.source\b/.test(filterExpr(entry) || ''));
    assert.ok(scoped.length >= 4);
    for (const { entry, path } of scoped) {
        assert.equal(entry.required, true,
            `${path} reads the open source but is optional — with nothing open the clause drops out and the component lists every row in the table`);
    }
});

test('the home screen shows real content on first open, before anything is selected', () => {
    assert.equal(CANON.homeScreenId, 'scr_register');
    const home = CANON.screens.find((s) => s.id === CANON.homeScreenId);
    const required = allFilterEntries(home).filter(({ entry }) => entry.required === true);
    assert.deepEqual(required, [], 'nothing on the home screen may wait for a selection that a first-time visitor has not made');
});

/**
 * A binding filter formula may only read currentUser / vars / forms / screen /
 * today. Reading form.*, item.*, records.* or now makes the fetch layer and the
 * read-side cache key diverge, and the component loads forever.
 */
test('no binding filter reads a scope the fetch layer cannot see', () => {
    const FORBIDDEN = /^(form|item|records|datasets|actions|now|index|value)\b/;
    const offences = FILTERS
        .map(({ entry, path }) => [path, filterExpr(entry)])
        .filter(([, expr]) => expr && FORBIDDEN.test(expr.trim()))
        .map(([path, expr]) => `${path}: ${expr}`);
    assert.deepEqual(offences, []);
});

// ── The logic behind the controls ──────────────────────────────────────────

/**
 * A server step's formula scope has no `screen`, `forms`, `actions`, `records`
 * or `datasets`. A binding naming one resolves in the browser preview and writes
 * NULL in production — on an audit register, a retirement row with no source on
 * it is worse than no row at all.
 */
test('no server step reads a scope root the server does not populate', () => {
    const SERVER_KINDS = new Set(['create_record', 'update_record', 'delete_record']);
    const FORBIDDEN = /^(screen|forms|actions|records|datasets)\b/;
    const offences = [];
    for (const [actionId, action] of Object.entries(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (!SERVER_KINDS.has(step.kind)) continue;
            const exprs = [];
            if (step.recordId && step.recordId.expr) exprs.push(['recordId', step.recordId.expr]);
            if (step.expectedUpdatedAt && step.expectedUpdatedAt.expr) exprs.push(['expectedUpdatedAt', step.expectedUpdatedAt.expr]);
            for (const [key, binding] of Object.entries(step.values || {})) {
                if (binding && binding.expr) exprs.push([`values.${key}`, binding.expr]);
            }
            for (const [where, expr] of exprs) {
                if (FORBIDDEN.test(expr.trim())) offences.push(`${actionId}.${where}: ${expr}`);
            }
        }
    }
    assert.deepEqual(offences, []);
});

test('every mutation refreshes every table it dirtied', () => {
    const MUTATING = new Set(['create_record', 'update_record', 'delete_record']);
    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        const dirtied = new Set(steps.filter((s) => MUTATING.has(s.kind)).map((s) => s.tableId));
        if (!dirtied.size) continue;
        const refreshed = new Set(steps.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
        for (const tableId of dirtied) {
            assert.ok(refreshed.has(tableId),
                `${actionId} writes ${tableId} but never refreshes it — the change would not appear until something else refetched`);
        }
    }
});

/**
 * The source detail must be a LIVE read. `vars.source` is a snapshot from the
 * click, and update_record returns { id, updated, changes } rather than the row,
 * so nothing can refresh it in place — a detail panel bound to the variable
 * would still be showing the old state right after an approval, on the one
 * screen where the state is the entire point.
 */
test('the source screen re-reads the open record instead of trusting the snapshot', () => {
    const detail = nodeById('cmp_sodet');
    assert.equal(detail.props.source.kind, 'records');
    assert.equal(detail.props.source.tableId, 'tbl_source1');
    const idFilter = detail.props.source.filter.find((f) => f.field === 'id');
    assert.ok(idFilter, 'the panel must look the row up by id');
    assert.equal(idFilter.required, true);
    // ...and act_setstate must invalidate exactly that query.
    const refreshes = flatSteps(definition.actions.act_setstate).filter((s) => s.kind === 'refresh');
    assert.ok(refreshes.some((r) => r.tableId === 'tbl_source1'));
});

/**
 * onRowSelect only carries the edited row when there is no selection mode; with
 * `selectable` set it fires with { selected: rows } instead and every inline
 * save would write nothing.
 */
test('every inline-editing grid disables row selection', () => {
    for (const node of NODES) {
        if (node.type !== 'data_grid') continue;
        const editable = (node.props.columns || []).some((c) => c.editable);
        if (!editable && !node.onRowSelect) continue;
        assert.equal(node.props.selectable, 'none',
            `${node.id} edits inline but has selectable="${node.props.selectable}" — onRowSelect would carry a selection instead of the edited row`);
    }
});

test('the review state is never editable as a grid cell, because moving a rung writes a pair', () => {
    for (const node of NODES) {
        if (node.type !== 'data_grid') continue;
        for (const col of node.props.columns || []) {
            if (['review_state', 'review_stage'].includes(col.key)) {
                assert.equal(col.editable, false,
                    `${node.id} lets "${col.key}" be edited in a cell — a cell edit cannot write the key and the stage together`);
            }
        }
    }
});

// ── The customer's vocabularies are actually the customer's ────────────────

/**
 * THE CLAIM THE WHOLE MODELLING DECISION RESTS ON. `review_state` and
 * `legal_basis` are text keys into config tables rather than `select` options
 * for one stated reason: a select's options live in the DATA MODEL, so shipping
 * them as options would mean a developer editing a live schema every time the
 * policy moved — "with keys, a steward adds a row on Setup".
 *
 * That sentence is only true if something in the app can create the row. Three
 * inline-editable grids with no way to add to them make it false, and quietly:
 * every screen still works, the register still reads correctly, and the one
 * thing the customer was promised — that the approval ladder is theirs — needs
 * the builder after all.
 */
test('every configuration table can be added to from the Setup screen', () => {
    const CONFIG_TABLES = ['tbl_kbases1', 'tbl_rstate1', 'tbl_lbasis1'];
    const creates = new Set();
    for (const action of Object.values(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (step.kind === 'create_record') creates.add(step.tableId);
        }
    }
    for (const tableId of CONFIG_TABLES) {
        assert.ok(creates.has(tableId),
            `nothing in the app can create a row in ${tableId} — the steward would need the builder, which is the exact thing text keys were chosen to avoid`);
    }
});

/**
 * A create that leaves the dialog open, the form full or the table stale is a
 * button that looks broken. And the refresh matters more here than anywhere
 * else: the Source screen's approval control IS this table, so a new rung that
 * does not appear until the next refetch reads as "adding a state did nothing".
 */
test('each add dialog closes, resets and refreshes the table it wrote', () => {
    const PAIRS = [
        { open: 'act_sukbopen', add: 'act_sukbadd', modalId: 'cmp_sukbmod', form: 'newbase', tableId: 'tbl_kbases1' },
        { open: 'act_sursopen', add: 'act_sursadd', modalId: 'cmp_sursmod', form: 'newstate', tableId: 'tbl_rstate1' },
        { open: 'act_sulbopen', add: 'act_sulbadd', modalId: 'cmp_sulbmod', form: 'newbasis', tableId: 'tbl_lbasis1' },
    ];
    for (const { open, add, modalId, form, tableId } of PAIRS) {
        assert.deepEqual(definition.actions[open], { kind: 'open_modal', modalId },
            `${open} must open ${modalId}`);

        const modal = nodeById(modalId);
        assert.ok(modal && modal.type === 'modal', `${modalId} is not a modal in the definition`);
        const formNode = (modal.children || []).find((c) => c.type === 'form');
        assert.ok(formNode, `${modalId} holds no form`);
        assert.equal(formNode.props.name, form);
        assert.equal(formNode.onSubmit, add);
        assert.ok((formNode.children || []).length >= 3,
            `${modalId}'s form has no inputs to submit`);

        const steps = flatSteps(definition.actions[add]);
        const create = steps.find((s) => s.kind === 'create_record');
        assert.ok(create, `${add} never creates anything`);
        assert.equal(create.tableId, tableId);
        assert.ok(steps.some((s) => s.kind === 'close_modal' && s.modalId === modalId), `${add} leaves ${modalId} open`);
        assert.ok(steps.some((s) => s.kind === 'reset_form' && s.form === form), `${add} leaves the form full`);
        assert.ok(steps.some((s) => s.kind === 'refresh' && s.tableId === tableId), `${add} never refreshes ${tableId}`);
    }
});

/**
 * The dialogs are HOISTED into their own section. Nested inside the tabs they
 * would be section → tabs → tab → modal → form → input — six levels, exactly
 * MAX_DEPTH. That still validates today, which is what makes it a trap rather
 * than an error: it leaves zero headroom, so the first person who wraps two
 * fields in a container to tidy the dialog gets `shape.too_deep` on every input
 * inside it. Hoisted, the same dialog has two levels spare.
 */
test('the add dialogs live outside the tabs, where the layout has room to grow', () => {
    const setup = CANON.screens.find((s) => s.id === 'scr_setup');
    const tabsSection = setup.sections.find((s) => (s.children || []).some((c) => c.type === 'tabs'));
    const nested = [];
    const walk = (children) => {
        for (const child of children || []) {
            if (child.type === 'modal') nested.push(child.id);
            walk(child.children);
        }
    };
    walk(tabsSection.children);
    assert.deepEqual(nested, [], 'a dialog inside the tab strip would sit exactly on the depth ceiling, with nothing left to spend');

    for (const modalId of ['cmp_sukbmod', 'cmp_sursmod', 'cmp_sulbmod']) {
        const section = setup.sections.find((s) => (s.children || []).some((c) => c.id === modalId));
        assert.ok(section, `${modalId} must be a direct child of one of the Setup sections`);
    }
});

/**
 * A `delete` with no matching `create` is a one-way door. Deleting the last
 * knowledge base used to make "Add a source" permanently unusable — its guard
 * needs a selected base and nothing in the app could make one — so anything
 * this app can delete, it must also be able to create.
 */
test('nothing can be deleted that cannot also be created again', () => {
    const creates = new Set();
    const deletes = new Set();
    for (const action of Object.values(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (step.kind === 'create_record') creates.add(step.tableId);
            if (step.kind === 'delete_record') deletes.add(step.tableId);
        }
    }
    for (const tableId of deletes) {
        assert.ok(creates.has(tableId), `${tableId} can be emptied from the app but never refilled from it`);
    }
});

/**
 * The append-only tables are append-only in the CONTROLS too, not only in the
 * access matrix. Findings and retirements are the evidence that a scan flagged
 * something and that a removal was decided; a row action offering to delete one
 * would be a button the server refuses, which teaches a steward the wrong thing
 * about what this register guarantees.
 */
test('no action deletes evidence, and every delete asks first', () => {
    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        const deletes = steps.filter((s) => s.kind === 'delete_record');
        if (!deletes.length) continue;
        for (const step of deletes) {
            assert.equal(['tbl_finds01', 'tbl_retire1'].includes(step.tableId), false,
                `${actionId} deletes from ${step.tableId} — an audit trail you can edit away is not an audit trail`);
        }
        assert.ok(steps.some((s) => s.kind === 'confirm'), `${actionId} deletes without confirming`);
    }
});

/**
 * Deleting a knowledge base is deliberately NOT offered. Sources, grants,
 * findings and retirements all carry `base_id` plus a denormalised `base_name`,
 * and there are no joins — so nothing can tell whether a base still holds
 * anything before removing it. The sources would stay exactly as they are:
 * indexed, answering, and attached to a base no list on any screen can reach.
 */
test('the Setup screen never offers to delete a knowledge base', () => {
    assert.deepEqual(nodeById('cmp_sukb').props.rowActions, []);
    for (const action of Object.values(definition.actions)) {
        for (const step of flatSteps(action)) {
            assert.notEqual(
                step.kind === 'delete_record' ? step.tableId : null,
                'tbl_kbases1',
                'deleting a base would orphan every source, grant and finding that names it');
        }
    }
});

// ── Access ─────────────────────────────────────────────────────────────────

test('every table denies by default and grants per role explicitly', () => {
    for (const table of dataModel.tables) {
        assert.equal(table.access.default, 'role', `${table.key} must not fall back to app-wide access`);
        assert.ok(table.access.roles, `${table.key} needs an explicit role matrix`);
    }
});

/**
 * The auditor seat is the point of the exercise: a DPO or external assessor
 * reads every row and changes none of it. A single write grant anywhere makes
 * their read of the register something they could have caused.
 */
test('the auditor can read everything and write nothing, on every table', () => {
    for (const table of dataModel.tables) {
        const auditor = table.access.roles.auditor;
        assert.ok(auditor, `${table.key} has no auditor grant — the DPO would be denied by default`);
        assert.equal(auditor.read, 'all');
        assert.equal(auditor.create, false);
        assert.equal(auditor.update, false);
        assert.equal(auditor.delete, false);
    }
});

test('a contributor may propose material but never rule on it or grant access', () => {
    const sources = tableOf('tbl_source1').access.roles.contributor;
    assert.equal(sources.create, true, 'a base only contributors may read is a base nobody feeds');
    assert.equal(sources.update, 'own', 'a contributor must not walk somebody else\'s source up the ladder');

    for (const tableId of ['tbl_finds01', 'tbl_grant01']) {
        const grant = tableOf(tableId).access.roles.contributor;
        assert.equal(grant.create, false, `${tableId}: ruling on personal data and granting access are steward decisions`);
        assert.equal(grant.update, false);
    }
});

/** Deleting the evidence is the act this register exists to make impossible. */
test('nobody may delete a finding or a retirement, including the steward', () => {
    for (const tableId of ['tbl_finds01', 'tbl_retire1']) {
        for (const [roleKey, grant] of Object.entries(tableOf(tableId).access.roles)) {
            assert.equal(grant.delete, false,
                `${tableId}: role "${roleKey}" may delete an audit row — an audit trail you can edit away is not an audit trail`);
        }
    }
});

test('revoking access keeps the grant as a record rather than deleting it', () => {
    const steps = flatSteps(definition.actions.act_agrevoke);
    assert.equal(steps.some((s) => s.kind === 'delete_record'), false);
    const write = steps.find((s) => s.kind === 'update_record');
    assert.deepEqual(write.values.is_active, { kind: 'static', value: false });
});

test('the seed ships a grant that expired and was never switched off', () => {
    const stale = rowsOf('tbl_grant01').filter((g) => g.is_active === true && g.expires_on && g.expires_on < AUTHORED_TODAY);
    assert.ok(stale.length >= 1,
        'the access-side twin of "retired but still indexed" needs a member, or the Access screen ships with nothing to notice');
});

// ── This is a privacy product; the register must not become the leak ────────

/**
 * A finding records WHAT was flagged, never the value. A register that quotes
 * the e-mail address or the identifier it detected has made a second copy of
 * exactly the data it exists to control — and that copy would ship to every
 * customer who installs the template.
 */
test('no seeded finding quotes the personal data it describes', () => {
    const EMAILISH = /[\w.+-]+@[\w-]+\.[\w.]+/;
    const IDENTIFIERISH = /\d{6,}/;
    for (const f of rowsOf('tbl_finds01')) {
        for (const field of ['finding', 'location', 'rationale']) {
            const text = f[field];
            if (!text) continue;
            assert.equal(EMAILISH.test(text), false, `finding.${field} contains something shaped like an e-mail address: ${text}`);
            assert.equal(IDENTIFIERISH.test(text), false, `finding.${field} contains something shaped like an identifier: ${text}`);
        }
    }
});

test('special-category findings are flagged as such and still have open ones to triage', () => {
    const special = rowsOf('tbl_finds01').filter((f) => f.is_special_category === true);
    assert.ok(special.length >= 2, 'the Art. 9 counter on the findings screen needs members');
    assert.ok(special.some((f) => f.decision === 'open'), 'at least one must still be waiting for a ruling');
    // A health or biometric finding that is NOT flagged special-category is the
    // mislabel that would quietly zero the counter a DPO watches.
    for (const f of rowsOf('tbl_finds01')) {
        if (['health', 'biometric'].includes(f.category)) {
            assert.equal(f.is_special_category, true,
                `a "${f.category}" finding is not flagged as special category — the Art. 9 count would under-report`);
        }
    }
});

test('the personal-data screen never offers to delete a finding', () => {
    const grid = nodeById('cmp_pigrid');
    assert.deepEqual(grid.props.rowActions, []);
    const decision = grid.props.columns.find((c) => c.key === 'decision');
    assert.equal(decision.editable, true, 'an accepted finding must be recorded as a decision, not as an absence');
});

// ── Runs with and without Nextcloud ─────────────────────────────────────────

/**
 * The template must be identical in both places. It may BENEFIT from Nextcloud
 * (an embedded viewer resolves to their NC identity, so "approved by" is a real
 * name), but it must not REQUIRE it: no connector binding, nothing NC-only.
 */
test('nothing in the app requires Nextcloud or any external system to be connected', () => {
    const kinds = new Set();
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(walk); return; }
        if (typeof obj.kind === 'string') kinds.add(obj.kind);
        Object.values(obj).forEach(walk);
    };
    walk(definition);
    assert.equal(kinds.has('connector'), false, 'a connector binding would need an external system configured');
    assert.equal(dataModel.connectors, undefined, 'the data model must not ship a connector');
});

/**
 * There is exactly ONE run_automation, it is deliberately unset, and the screen
 * that fires it says so. A second one — or a silent one — would leave a customer
 * pressing a button that does nothing without ever being told why.
 */
test('the only routine is the personal-data scan, shipped unset and explained on screen', () => {
    const automations = [];
    for (const [actionId, action] of Object.entries(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (step.kind === 'run_automation') automations.push([actionId, step]);
        }
    }
    assert.equal(automations.length, 1);
    const [actionId, step] = automations[0];
    assert.equal(actionId, 'act_runscan');
    assert.equal(step.automationId, null);

    const note = nodeById('cmp_pinote');
    assert.match(note.props.text, /Automations/, 'the screen must tell the user where to wire the routine up');
    const toast = flatSteps(definition.actions.act_runscan).find((s) => s.kind === 'toast');
    assert.match(toast.message, /connect the routine/i);
});

test('identity is recorded from currentUser, which resolves the same embedded and standalone', () => {
    const stamps = [];
    for (const action of Object.values(definition.actions)) {
        for (const step of flatSteps(action)) {
            for (const binding of Object.values(step.values || {})) {
                if (binding && binding.expr && /currentUser/.test(binding.expr)) stamps.push(binding.expr);
            }
        }
    }
    assert.ok(stamps.length >= 4, 'approvals, decisions, grants and removals must all record who did them');
    // Server-side currentUser carries id/name/email/roleKey/isOwner/roles and
    // nothing else — anything further resolves to an empty column, silently.
    for (const expr of stamps) {
        assert.match(expr, /currentUser\.(id|name|email|roleKey|isOwner|roles)\b/);
    }
});

// ── Layout ──────────────────────────────────────────────────────────────────

/**
 * A height:'fill' section stretches its FIRST grid row only, so a fill section
 * whose children do not add up to exactly one 12-column row leaves everything
 * after the first row squashed to nothing.
 */
test('every fill section is exactly one 12-column row', () => {
    for (const screen of CANON.screens) {
        for (const section of screen.sections) {
            if (section.style.height !== 'fill') continue;
            const spans = section.children.map((c) => (c.style && c.style.span) || 12);
            assert.equal(spans.reduce((a, b) => a + b, 0), 12,
                `${screen.id}/${section.id} is a fill section with spans [${spans.join(', ')}] — anything past the first row would collapse`);
        }
    }
});

test('every screen leads with an auto-height header and has at most one fill section', () => {
    for (const screen of CANON.screens) {
        const fills = screen.sections.filter((s) => s.style.height === 'fill');
        assert.ok(fills.length <= 1, `${screen.id} has ${fills.length} fill sections`);
        assert.notEqual(screen.sections[0].style.height, 'fill', `${screen.id} starts with a fill section — its header would stretch`);
    }
});

test('there is one filter bar per screen, and no variable named "filters"', () => {
    for (const screen of CANON.screens) {
        const bars = allNodes({ screens: [screen] }).filter((n) => n.type === 'filter_bar');
        assert.ok(bars.length <= 1, `${screen.id} has ${bars.length} filter bars, and they would all publish to the same vars.filters`);
    }
    assert.equal(definition.variables.some((v) => v.name === 'filters'), false,
        '"filters" is reserved by filter_bar; declaring it is an error');
});
