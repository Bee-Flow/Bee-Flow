/**
 * Processing register — the checks templates.test.js cannot make.
 *
 * The generic suite proves this template canonicalizes, validates, and that its
 * seed rows conform to their columns. None of that can catch what a REGISTER is
 * actually exposed to, which is not a crash — it is a document that quietly
 * stops being true:
 *
 *  • a deadline that does not follow from the review it claims to follow from,
 *  • an entry on legitimate interests reading "not applicable" because a third
 *    writer set the basis without re-deriving the status,
 *  • a denormalised name that no longer matches the row it was copied from,
 *  • an activity holding Art. 9 data that does not say so,
 *  • an append-only log somebody can edit.
 *
 * Every one of those passes validation and reads fine on screen. So: assert the
 * arithmetic, the derivations and the joins the database cannot.
 *
 * The formulas are evaluated with the REAL expression engine rather than
 * re-implemented here — a test that re-implements the rule it is checking only
 * proves the author typed it twice.
 *
 * Run: cd server && node --test appStudio/templates/appProcessingRegister.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appProcessingRegister');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { tryEvaluate } = require('../../shared/expr/engine.mjs');

const { seed, dataModel, definition } = template;

const rowsOf = (tableId) => seed[tableId] || [];
const keysOf = (tableId, key) => new Set(rowsOf(tableId).map((r) => r[key]));
const tableOf = (tableId) => dataModel.tables.find((t) => t.id === tableId);
const fieldOf = (tableId, key) => (tableOf(tableId).fields || []).find((f) => f.key === key);

/** Alias → row, for the $ref graph. */
const byAlias = new Map(
    Object.values(seed).flat().filter((r) => typeof r.$id === 'string').map((r) => [r.$id, r]),
);

/** Every node in the canonical definition, flattened, with its screen. */
function allNodes(def) {
    const out = [];
    const walk = (children, screen) => {
        for (const child of children || []) {
            out.push({ node: child, screen });
            if (Array.isArray(child.children)) walk(child.children, screen);
        }
    };
    for (const screen of def.screens || []) {
        for (const section of screen.sections || []) walk(section.children, screen);
    }
    return out;
}

const CANON = canonicalizeAppDefinition(definition).def;
const NODES = allNodes(CANON);
const nodeById = (id) => (NODES.find((n) => n.node.id === id) || {}).node;

/** Flatten one action's steps, including condition/loop/switch branches. */
function flatSteps(action) {
    const out = [];
    const walk = (steps) => {
        for (const s of steps || []) {
            out.push(s);
            for (const branch of ['then', 'else', 'steps']) if (Array.isArray(s[branch])) walk(s[branch]);
            for (const c of Array.isArray(s.cases) ? s.cases : []) walk(c.steps);
        }
    };
    if (action.kind === 'sequence') walk(action.steps); else out.push(action);
    return out;
}

const ALL_STEPS = Object.entries(definition.actions)
    .flatMap(([id, action]) => flatSteps(action).map((step) => ({ id, step })));

/** Walk every object in a value, depth-first. */
function deepObjects(value, out = []) {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) { value.forEach((v) => deepObjects(v, out)); return out; }
    out.push(value);
    Object.values(value).forEach((v) => deepObjects(v, out));
    return out;
}

const evaluate = (expr, scope) => {
    const { value, error } = tryEvaluate(expr, scope);
    assert.equal(error, null, `"${expr}" failed to evaluate: ${error}`);
    return value;
};

// ── The vocabularies agree ──────────────────────────────────────────────────

test('every entry names a legal basis the vocabulary defines', () => {
    const bases = keysOf('tbl_lbase1', 'key');
    for (const a of rowsOf('tbl_act001')) {
        assert.ok(bases.has(a.legal_basis),
            `"${a.name}" cites legal basis "${a.legal_basis}", which legal_bases does not define`);
    }
});

test('every entry names a department the vocabulary defines', () => {
    const depts = keysOf('tbl_dept01', 'key');
    for (const a of rowsOf('tbl_act001')) {
        assert.ok(depts.has(a.department),
            `"${a.name}" sits in department "${a.department}", which departments does not define`);
    }
});

test('the authored dropdowns cover the seeded vocabularies exactly', () => {
    // The one seam in the config-as-data story, called out on the Vocabularies
    // screen: these option lists live in the definition, the tables live in the
    // database. They must at least AGREE on install, or the register ships
    // showing a basis no form can select.
    const basisSelect = nodeById('cmp_nwf05');
    assert.deepEqual(
        basisSelect.props.options.map((o) => o.value).sort(),
        [...keysOf('tbl_lbase1', 'key')].sort(),
    );
    const deptSelect = nodeById('cmp_nwf03');
    assert.deepEqual(
        deptSelect.props.options.map((o) => o.value).sort(),
        [...keysOf('tbl_dept01', 'key')].sort(),
    );
});

test('every badge tone map covers every value it can be handed', () => {
    const riskValues = new Set(fieldOf('tbl_act001', 'risk_tier').options.map((o) => o.value));
    for (const list of ['cmp_rgover', 'cmp_rglia']) {
        const mapped = new Set(nodeById(list).props.badgeToneMap.map((m) => m.value));
        for (const v of riskValues) {
            assert.ok(mapped.has(v), `risk tier "${v}" has no tone on ${list} — it would render as a grey pill and stop carrying its warning`);
        }
    }
    const dpaValues = new Set(fieldOf('tbl_proc01', 'dpa_status').options.map((o) => o.value));
    const procMapped = new Set(nodeById('cmp_prlist').props.badgeToneMap.map((m) => m.value));
    for (const v of dpaValues) assert.ok(procMapped.has(v), `DPA status "${v}" has no tone on the processor list`);
});

// ── The denormalised copies match what they were copied from ────────────────

test('every child row carries its activity’s real name', () => {
    for (const tableId of ['tbl_aproc1', 'tbl_acat01', 'tbl_trans1', 'tbl_dpia01', 'tbl_rlog01']) {
        for (const row of rowsOf(tableId)) {
            const parent = byAlias.get(row.activity_id.$ref);
            assert.ok(parent, `${tableId}: activity_id points at unseeded alias "${row.activity_id.$ref}"`);
            assert.equal(row.activity_name, parent.name,
                `${tableId}: row says "${row.activity_name}" but its activity is "${parent.name}" — there is no join to correct it with`);
        }
    }
});

test('every engagement and sub-processor carries its processor’s real name', () => {
    for (const row of rowsOf('tbl_aproc1')) {
        const p = byAlias.get(row.processor_id.$ref);
        assert.equal(row.processor_name, p.name);
    }
    for (const row of rowsOf('tbl_subp01')) {
        const p = byAlias.get(row.processor_id.$ref);
        assert.equal(row.processor_name, p.name);
    }
});

test('every linked data category matches the vocabulary, flag included', () => {
    const vocab = new Map(rowsOf('tbl_dcat01').map((c) => [c.key, c]));
    for (const row of rowsOf('tbl_acat01')) {
        const cat = vocab.get(row.category_key);
        assert.ok(cat, `"${row.activity_name}" links category "${row.category_key}", which the vocabulary does not define`);
        assert.equal(row.category_name, cat.name);
        // The Art. 9 flag is copied because a filter cannot follow the link.
        // A copy that disagrees hides special-category processing from the one
        // query that is meant to find it.
        assert.equal(Boolean(row.is_special), Boolean(cat.is_special),
            `"${row.activity_name}" says category "${row.category_key}" is${row.is_special ? '' : ' not'} special, the vocabulary disagrees`);
    }
});

// ── Article 9: the declaration and the links agree ──────────────────────────

test('an entry linked to an Article 9 category declares that it holds one', () => {
    const declared = new Map(rowsOf('tbl_act001').map((a) => [a.$id, a]));
    for (const row of rowsOf('tbl_acat01')) {
        if (!row.is_special) continue;
        const activity = declared.get(row.activity_id.$ref);
        assert.equal(activity.special_category, 'present',
            `"${activity.name}" links the special category "${row.category_key}" but declares special_category "${activity.special_category}"`);
    }
});

test('linking an Article 9 category promotes the declaration, and only then', () => {
    const steps = flatSteps(definition.actions.act_addcat);
    const guard = steps.find((s) => s.kind === 'condition');
    assert.ok(guard, 'the promotion must be conditional — linking an ordinary category may not declare Art. 9 processing');
    assert.equal(guard.expr, 'item.is_special');
    const promote = flatSteps({ kind: 'sequence', steps: guard.then }).find((s) => s.kind === 'update_record');
    assert.equal(promote.tableId, 'tbl_act001');
    assert.deepEqual(promote.values.special_category, { kind: 'static', value: 'present' });
    // Deliberately no demotion anywhere: removing a category must not answer
    // "no special-category data" on the controller's behalf.
    const remove = flatSteps(definition.actions.act_delcat);
    assert.equal(remove.some((s) => s.kind === 'update_record'), false);
});

// ── The balancing test: one rule, exactly two writers ───────────────────────

/** The rule as the app itself states it, lifted out of the action. */
const LIA_EXPR = definition.actions.act_editsave.steps
    .find((s) => s.kind === 'update_record').values.lia_status.expr;

test('creating and editing an entry derive lia_status with the identical rule', () => {
    const created = definition.actions.act_newsave.steps
        .find((s) => s.kind === 'create_record').values.lia_status.expr;
    assert.equal(created, LIA_EXPR,
        'the two writers must share one expression, or an entry created clean can be edited into a false clean bill');
});

test('no third action writes legal_basis, which is what keeps the rule true', () => {
    const writers = ALL_STEPS
        .filter(({ step }) => step.values && Object.prototype.hasOwnProperty.call(step.values, 'legal_basis'))
        .map(({ id }) => id)
        .sort();
    assert.deepEqual(writers, ['act_editsave', 'act_newsave']);
    // …and both of them also write the derived column in the same step.
    for (const id of writers) {
        const step = flatSteps(definition.actions[id]).find((s) => s.values && s.values.legal_basis);
        assert.ok(step.values.lia_status, `${id} sets a legal basis without re-deriving lia_status`);
    }
});

test('the seeded lia_status is what the app’s own rule computes', () => {
    for (const a of rowsOf('tbl_act001')) {
        const expected = evaluate(LIA_EXPR, {
            form: { legal_basis: a.legal_basis, lia_summary: a.lia_summary || '' },
        });
        assert.equal(a.lia_status, expected,
            `"${a.name}" is stored as "${a.lia_status}" but the rule says "${expected}"`);
    }
});

test('the register ships with a real balancing-test finding, and a real counter-example', () => {
    const li = rowsOf('tbl_act001').filter((a) => a.legal_basis === 'legitimate_interests');
    const missing = li.filter((a) => a.lia_status === 'missing');
    const recorded = li.filter((a) => a.lia_status === 'recorded');
    assert.ok(missing.length >= 2, 'the front screen’s second finding list must have something in it on install');
    assert.ok(recorded.length >= 1, 'and one entry must show what a balancing test written down actually looks like');
    for (const a of recorded) {
        assert.ok((a.lia_summary || '').length > 200,
            `"${a.name}" claims a recorded balancing test in ${a.lia_summary ? a.lia_summary.length : 0} characters — the example has to show the real shape of one`);
    }
});

// ── The statutory deadline ──────────────────────────────────────────────────

/** The deadline expression the review action actually uses. */
const NEXT_REVIEW_EXPR = definition.actions.act_revsave.steps
    .find((s) => s.kind === 'update_record').values.next_review_date.expr;

test('the review measures the next deadline from the review, not from today', () => {
    // Back-dating a review must not buy the organisation extra time. Reading
    // `today` here would do exactly that, and nothing on screen would say so.
    assert.match(NEXT_REVIEW_EXPR, /form\.reviewed_on/);
    assert.doesNotMatch(NEXT_REVIEW_EXPR, /\btoday\b/);
    assert.match(NEXT_REVIEW_EXPR, /form\.review_interval_days/);
    // Date-only, because the column is a `date`; an ISO timestamp would sort
    // and compare against `today` inconsistently.
    assert.match(NEXT_REVIEW_EXPR, /formatDate\(/);
});

test('the review writes the deadline, the interval and the log in one action', () => {
    const steps = flatSteps(definition.actions.act_revsave);
    const update = steps.find((s) => s.kind === 'update_record' && s.tableId === 'tbl_act001');
    assert.ok(update.values.last_reviewed && update.values.next_review_date && update.values.review_interval_days,
        'a review that moves the deadline without recording when it happened is unauditable');
    const log = steps.find((s) => s.kind === 'create_record' && s.tableId === 'tbl_rlog01');
    assert.ok(log, 'every review must leave a log entry');
    // The log repeats the SAME arithmetic, so the cadence can be reconstructed
    // from the log alone without trusting the current row.
    assert.equal(log.values.next_review_date.expr, update.values.next_review_date.expr);
});

test('every seeded deadline is exactly its review plus its interval', () => {
    for (const a of rowsOf('tbl_act001')) {
        const expected = evaluate(NEXT_REVIEW_EXPR, {
            form: { reviewed_on: a.last_reviewed, review_interval_days: a.review_interval_days },
        });
        assert.equal(a.next_review_date, expected,
            `"${a.name}": reviewed ${a.last_reviewed} + ${a.review_interval_days} days is ${expected}, but the register says ${a.next_review_date}`);
    }
});

test('the review log agrees with the entry it belongs to, and never runs ahead of it', () => {
    const logsByAlias = new Map();
    for (const row of rowsOf('tbl_rlog01')) {
        const alias = row.activity_id.$ref;
        if (!logsByAlias.has(alias)) logsByAlias.set(alias, []);
        logsByAlias.get(alias).push(row);
    }
    for (const a of rowsOf('tbl_act001')) {
        const logs = logsByAlias.get(a.$id) || [];
        assert.ok(logs.length, `"${a.name}" claims to have been reviewed on ${a.last_reviewed} with nothing in the log to show for it`);
        assert.ok(
            logs.some((l) => l.reviewed_on === a.last_reviewed && l.next_review_date === a.next_review_date),
            `"${a.name}" has no log entry matching its own review (${a.last_reviewed} → ${a.next_review_date})`,
        );
        for (const l of logs) {
            assert.ok(l.reviewed_on <= a.last_reviewed,
                `"${a.name}" has a log entry dated ${l.reviewed_on}, later than the last review the entry admits to`);
        }
    }
});

test('the register ships overdue entries, so the first finding is not an empty box', () => {
    // Monotone-safe: every seeded date is in the past, so this count only grows
    // as real time passes. It can never quietly become zero.
    const todayIso = new Date().toISOString().slice(0, 10);
    const overdue = rowsOf('tbl_act001').filter((a) => a.status === 'active' && a.next_review_date < todayIso);
    assert.ok(overdue.length >= 3,
        `expected the seed to ship at least three overdue entries so the front screen shows what an overdue review looks like; found ${overdue.length}`);
});

// ── Risk and DPIA ───────────────────────────────────────────────────────────

test('a risk tier can never be blank', () => {
    const field = fieldOf('tbl_act001', 'risk_tier');
    assert.equal(field.required, true);
    assert.ok(field.options.some((o) => o.value === field.default), 'the default must be one of the tiers, or "required" is unsatisfiable on create');
    for (const a of rowsOf('tbl_act001')) {
        assert.ok(field.options.some((o) => o.value === a.risk_tier),
            `"${a.name}" has risk tier ${JSON.stringify(a.risk_tier)} — an unrated entry is one nobody has to argue about`);
    }
    // And every control that can set it is required too, so the form cannot
    // submit an empty tier past the column's default.
    for (const id of ['cmp_nwf06', 'cmp_acttf2']) {
        assert.equal(nodeById(id).props.required, true);
    }
});

test('the DPIA’s residual risk uses the register’s own three tiers', () => {
    // The triage copies risk_tier straight into residual_risk. Two vocabularies
    // would make "did the assessment lower the risk?" unanswerable.
    const tiers = fieldOf('tbl_act001', 'risk_tier').options.map((o) => o.value);
    const residual = fieldOf('tbl_dpia01', 'residual_risk').options.map((o) => o.value);
    assert.deepEqual(residual, tiers);
    const copy = flatSteps(definition.actions.act_startdpia).find((s) => s.kind === 'create_record');
    assert.equal(copy.values.residual_risk.expr, 'item.risk_tier');
});

test('starting an assessment also tells the register it started', () => {
    for (const id of ['act_startdpia', 'act_dpiahere']) {
        const steps = flatSteps(definition.actions[id]);
        assert.ok(steps.some((s) => s.kind === 'create_record' && s.tableId === 'tbl_dpia01'));
        const back = steps.find((s) => s.kind === 'update_record' && s.tableId === 'tbl_act001');
        assert.ok(back, `${id} would leave the entry reading "not screened" while an assessment was running`);
        assert.deepEqual(back.values.dpia_status, { kind: 'static', value: 'in_progress' });
    }
});

test('no seeded entry has an assessment while still claiming to be unscreened', () => {
    const assessed = new Set(rowsOf('tbl_dpia01').map((d) => d.activity_id.$ref));
    for (const a of rowsOf('tbl_act001')) {
        if (!assessed.has(a.$id)) continue;
        assert.notEqual(a.dpia_status, 'not_assessed', `"${a.name}" has a DPIA on file but the register says it was never screened`);
    }
    // …and the triage queue still has work in it, or the screen opens empty.
    const queue = rowsOf('tbl_act001').filter((a) => a.status === 'active' && a.dpia_status === 'not_assessed');
    assert.ok(queue.length >= 3, `the screening queue must have something in it on install; found ${queue.length}`);
});

// ── Transfers: the Schrems II question ──────────────────────────────────────

test('the seed ships the gap a supervisory authority asks about first', () => {
    const transfers = rowsOf('tbl_trans1');
    const gap = transfers.filter((t) => t.safeguard === 'sccs' && !t.tia_done);
    assert.ok(gap.length >= 1, 'clauses with no transfer impact assessment is THE finding — the register has to show one');
    const good = transfers.filter((t) => t.safeguard === 'sccs' && t.tia_done && t.assessed_on);
    assert.ok(good.length >= 1, 'and one that was done properly, so the column means something');
    for (const t of transfers) {
        const options = fieldOf('tbl_trans1', 'safeguard').options.map((o) => o.value);
        assert.ok(options.includes(t.safeguard), `transfer to ${t.country} cites unknown safeguard "${t.safeguard}"`);
        assert.ok(t.country && t.recipient, 'a transfer with no destination or recipient is not a record of anything');
    }
});

test('a processor with no signed agreement is visible on install', () => {
    const unsigned = rowsOf('tbl_proc01').filter((p) => p.dpa_status !== 'signed');
    assert.ok(unsigned.length >= 2, 'Art. 28 gaps are the other thing an audit finds; the DPA register must open on some');
    // The engagement rows snapshot the DPA state, so the entry screen can show
    // it without a join. The snapshot must be a legal value of the live column.
    const live = new Set(fieldOf('tbl_proc01', 'dpa_status').options.map((o) => o.value));
    for (const e of rowsOf('tbl_aproc1')) {
        assert.ok(live.has(e.dpa_status), `engagement snapshot "${e.dpa_status}" is not a DPA status the processors table can hold`);
    }
});

// ── The open entry is never rendered from the snapshot ──────────────────────

test('every panel on the entry screen reads the live row, not the selection', () => {
    const screen = CANON.screens.find((s) => s.id === 'scr_activity');
    const nodes = allNodes({ screens: [screen] }).map((n) => n.node);
    const bindings = deepObjects(nodes.map((n) => n.props))
        .filter((o) => o.kind === 'record' || o.kind === 'records');
    assert.ok(bindings.length >= 15, 'the entry screen should be built out of live reads');
    for (const b of bindings) {
        assert.ok(b.tableId, 'a data binding must name its table');
    }
    // The detail panel and the header in particular: a formula over
    // vars.activity here is the stale-review-date bug the app exists to avoid.
    const detail = nodeById('cmp_actdet');
    assert.equal(detail.props.source.kind, 'record');
    assert.equal(detail.props.source.tableId, 'tbl_act001');
    const header = nodeById('cmp_acthdr');
    assert.equal(header.props.titleFrom.kind, 'record');
    assert.equal(header.props.titleFrom.path, 'name');
    // …and every prefilled control on the edit form, too.
    const form = nodeById('cmp_editform');
    for (const input of form.children) {
        assert.equal(input.props.valueFrom.kind, 'record',
            `${input.id} prefills from something other than the live row — a second edit would restore the first save`);
    }
});

test('all those bindings share one cache key, so it is one fetch', () => {
    // dataCacheKey hashes tableId + filter + sort + limit and ignores `path`.
    // If the filters ever diverged, the entry screen would issue a query per
    // field instead of one.
    const screen = CANON.screens.find((s) => s.id === 'scr_activity');
    const nodes = allNodes({ screens: [screen] }).map((n) => n.node);
    const shapes = new Set(
        deepObjects(nodes.map((n) => n.props))
            .filter((o) => o.kind === 'record' && o.tableId === 'tbl_act001')
            .map((o) => JSON.stringify({ f: o.filter, s: o.sort ?? null, l: o.limit ?? null })),
    );
    assert.equal(shapes.size, 1, `the open-entry reads must all use one query shape; found ${shapes.size}`);
});

test('with nothing selected the entry screen shows empty text, not the whole register', () => {
    const screen = CANON.screens.find((s) => s.id === 'scr_activity');
    const nodes = allNodes({ screens: [screen] }).map((n) => n.node);
    for (const binding of deepObjects(nodes.map((n) => n.props))) {
        if (binding.kind !== 'record' && binding.kind !== 'records') continue;
        for (const clause of binding.filter || []) {
            const expr = clause.value && clause.value.expr;
            if (typeof expr !== 'string' || !expr.includes('vars.activity')) continue;
            assert.equal(clause.required, true,
                `a scoping filter on ${binding.tableId} is optional — with no entry open it would be dropped and the component would list every row in the table`);
        }
    }
});

// ── The logic behind the controls ───────────────────────────────────────────

/**
 * A server step's formula scope has no `screen`, `forms`, `actions`, `records`
 * or `datasets`. A binding naming one resolves in the browser preview and
 * writes NULL in production — the worst kind of wrong, because it passes every
 * check an author can run before shipping.
 */
test('no server step reads a scope root the server does not populate', () => {
    const SERVER_KINDS = new Set(['create_record', 'update_record', 'delete_record']);
    const FORBIDDEN = /^(screen|forms|actions|records|datasets)\b/;
    const offences = [];
    for (const { id, step } of ALL_STEPS) {
        if (!SERVER_KINDS.has(step.kind)) continue;
        const exprs = [];
        for (const key of ['recordId', 'expectedUpdatedAt']) {
            if (step[key] && step[key].expr) exprs.push([key, step[key].expr]);
        }
        for (const [col, binding] of Object.entries(step.values || {})) {
            if (binding && binding.expr) exprs.push([`values.${col}`, binding.expr]);
        }
        for (const [where, expr] of exprs) {
            if (FORBIDDEN.test(expr.trim())) offences.push(`${id}.${where}: ${expr}`);
        }
    }
    assert.deepEqual(offences, []);
});

test('nothing anywhere reads screen.params — the app navigates by variable', () => {
    const hits = deepObjects(definition)
        .filter((o) => o.kind === 'formula' && typeof o.expr === 'string' && /\bscreen\b/.test(o.expr));
    assert.deepEqual(hits.map((h) => h.expr), []);
});

test('every mutation refreshes the table it dirtied', () => {
    const MUTATES = new Set(['create_record', 'update_record', 'delete_record']);
    for (const [id, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        const dirtied = new Set(steps.filter((s) => MUTATES.has(s.kind)).map((s) => s.tableId));
        if (!dirtied.size) continue;
        const refreshed = new Set(steps.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
        for (const tableId of dirtied) {
            assert.ok(refreshed.has(tableId),
                `${id} writes ${tableId} but never refreshes it — on this app that means a review that visibly did not happen`);
        }
    }
});

test('each triage control writes only the column it owns', () => {
    // onChange hands the action the WHOLE form, so one shared action would
    // re-write the siblings from whatever they happen to hold — and a silently
    // blanked risk tier is the failure this register exists to prevent.
    const owned = {
        act_setstat: 'status',
        act_setrisk: 'risk_tier',
        act_setspec: 'special_category',
        act_setdpia: 'dpia_status',
    };
    for (const [id, column] of Object.entries(owned)) {
        const step = flatSteps(definition.actions[id]).find((s) => s.kind === 'update_record');
        assert.deepEqual(Object.keys(step.values), [column],
            `${id} writes more than its own column`);
        assert.equal(step.values[column].expr, `form.${column}`);
    }
    // …and the four controls on screen are wired to those four actions.
    const form = nodeById('cmp_acttf');
    assert.deepEqual(form.children.map((c) => c.onChange).sort(), Object.keys(owned).sort());
    assert.deepEqual(form.children.map((c) => c.props.name).sort(), Object.values(owned).sort());
    assert.equal(form.props.showSubmit, false, 'a save button next to controls that already save is a button that does nothing');
});

test('every inline-editable grid can refuse a stale write', () => {
    for (const id of ['act_procsave', 'act_subsave', 'act_trsave', 'act_dpiasave', 'act_lbsave', 'act_dcsave', 'act_deptsave']) {
        const step = flatSteps(definition.actions[id]).find((s) => s.kind === 'update_record');
        assert.ok(step.expectedUpdatedAt, `${id} would overwrite a colleague's edit without a word`);
        assert.equal(step.expectedUpdatedAt.expr, 'form.updated_at');
        assert.equal(step.recordId.expr, 'form.id');
    }
});

test('inline editing is only possible where onRowSelect can carry the edited row', () => {
    // With `selectable` set, onRowSelect fires with { selected: rows } instead
    // of the row that was edited — so an editable grid MUST be selectable
    // 'none' or the save silently writes nothing.
    for (const { node } of NODES) {
        if (node.type !== 'data_grid') continue;
        const editable = (node.props.columns || []).some((c) => c.editable);
        if (!editable && !node.onRowSelect) continue;
        assert.equal(node.props.selectable, 'none',
            `${node.id} has inline editing with selectable "${node.props.selectable}"`);
        if (editable) assert.ok(node.onRowSelect, `${node.id} has editable columns but nothing to save them`);
    }
});

// ── What may be edited, and by whom ─────────────────────────────────────────

test('the register grid is read-only; the vocabularies are not', () => {
    const register = nodeById('cmp_rggrid');
    assert.equal(register.onRowSelect, undefined, 'a statutory record is amended through a recorded change, not by typing in a cell');
    assert.equal(register.props.columns.some((c) => c.editable), false);
    for (const id of ['cmp_sulb', 'cmp_sudc', 'cmp_sudp']) {
        const grid = nodeById(id);
        assert.ok(grid.props.columns.some((c) => c.editable), `${id} is configuration and must be editable in the running app`);
        // …except the key, which is what the register STORES. Renaming it here
        // would orphan every entry pointing at it.
        const key = grid.props.columns.find((c) => c.key === 'key');
        assert.equal(key.editable, false, `${id} lets someone rename a key that entries point at`);
    }
});

test('the review log is append-only for every role, including the DPO', () => {
    const log = tableOf('tbl_rlog01');
    assert.equal(log.access.default, 'role');
    const roles = Object.entries(log.access.roles);
    assert.ok(roles.length >= 3, 'every declared role must have an explicit grant on the evidence table');
    for (const [role, grant] of roles) {
        assert.equal(grant.update, false, `${role} may edit the review log — evidence you can rewrite is not evidence`);
        assert.equal(grant.delete, false, `${role} may delete review log entries`);
    }
    // Nothing in the app even tries.
    const writes = ALL_STEPS.filter(({ step }) => step.tableId === 'tbl_rlog01');
    assert.deepEqual([...new Set(writes.map(({ step }) => step.kind))].sort(), ['create_record', 'refresh']);
});

test('every table names an explicit grant per declared role', () => {
    const declared = dataModel.roles.map((r) => r.key).sort();
    for (const table of dataModel.tables) {
        assert.equal(table.access.default, 'role', `${table.key} falls back to app-wide access instead of deciding`);
        assert.deepEqual(Object.keys(table.access.roles).sort(), declared,
            `${table.key} does not say what every role may do`);
        assert.equal(table.access.roles.auditor.create, false, `${table.key}: an auditor must not be able to write to the register`);
        assert.equal(table.access.roles.auditor.update, false);
        assert.equal(table.access.roles.auditor.delete, false);
    }
    // A visitor nobody has placed reads the register and changes nothing.
    assert.equal(dataModel.roleMapping.default, 'auditor');
});

test('the definition’s roles and the data model’s roles are the same three', () => {
    assert.deepEqual(
        definition.roles.map((r) => r.id).sort(),
        dataModel.roles.map((r) => r.key).sort(),
    );
});

// ── Runs with and without Nextcloud ─────────────────────────────────────────

/**
 * The template must be identical in both places. It may BENEFIT from Nextcloud
 * (an embedded viewer resolves to their NC identity, so "only my reviews" works
 * without a second identity model) but it must not REQUIRE it.
 */
test('nothing in the app requires Nextcloud, a connector or a knowledge base', () => {
    const kinds = new Set(deepObjects(definition).map((o) => o.kind).filter(Boolean));
    assert.equal(kinds.has('connector'), false);
    assert.equal(dataModel.connectors, undefined);

    const stepKinds = new Set(ALL_STEPS.map(({ step }) => step.kind));
    for (const ai of ['ai_extract', 'ai_generate', 'kb_query', 'send_email', 'file_intake']) {
        assert.equal(stepKinds.has(ai), false, `${ai} would make a register of sensitive data depend on a model call`);
    }
    assert.equal(NODES.some(({ node }) => node.type === 'ai_chat' || node.type === 'connector_status'), false);
});

test('the single run_automation is unset on purpose, and the screen says so', () => {
    const automations = ALL_STEPS.filter(({ step }) => step.kind === 'run_automation');
    assert.equal(automations.length, 1, 'one deliberate hook, not a scattering of them');
    assert.equal(automations[0].step.automationId, null);
    assert.equal(automations[0].id, 'act_remind');
    // A button that silently does nothing is the loudest sign an app was
    // generated rather than designed, so the screen explains the gap.
    const note = nodeById('cmp_rvnote');
    assert.equal(note.type, 'callout');
    assert.match(note.props.text, /routine/i);
    assert.match(note.props.text, /not wired|nothing is wired/i);
});

test('identity is matched on e-mail, which resolves the same embedded and standalone', () => {
    assert.ok(fieldOf('tbl_act001', 'reviewer_email'));
    const calendar = nodeById('cmp_rvcal');
    const mine = calendar.props.source.filter.find((f) => f.field === 'reviewer_email');
    assert.ok(mine, 'the calendar must be able to narrow to the viewer');
    assert.match(mine.value.expr, /currentUser\.email/);
    // A toggle that is off must not mean "assigned to nobody": the formula has
    // to resolve to null so the clause is dropped entirely.
    assert.match(mine.value.expr, /:\s*null/);
    assert.notEqual(mine.required, true);
});

// ── Layout invariants ───────────────────────────────────────────────────────

test('every fill section is exactly one 12-column row', () => {
    // A height:'fill' section stretches its FIRST grid row only; a second row
    // inside one is invisible below the fold.
    for (const screen of CANON.screens) {
        for (const section of screen.sections) {
            if (section.style.height !== 'fill') continue;
            const spans = section.children.map((c) => c.style.span ?? 12);
            assert.equal(spans.reduce((a, b) => a + b, 0), 12,
                `${screen.id}/${section.id} is a fill section with ${spans.length} children spanning ${spans.reduce((a, b) => a + b, 0)} columns`);
        }
    }
});

test('every screen has a fill section, so no screen ends in dead space', () => {
    for (const screen of CANON.screens) {
        assert.ok(screen.sections.some((s) => s.style.height === 'fill'),
            `${screen.id} has nothing that takes the leftover height`);
    }
});

test('one filter bar per screen, and "filters" is never declared', () => {
    for (const screen of CANON.screens) {
        const bars = allNodes({ screens: [screen] }).filter(({ node }) => node.type === 'filter_bar');
        assert.ok(bars.length <= 1, `${screen.id} has ${bars.length} filter bars, and they all publish to the one reserved variable`);
    }
    assert.equal(definition.variables.some((v) => v.name === 'filters'), false);
});

test('every action is reachable and every declared variable is used', () => {
    const wired = new Set();
    for (const { node } of NODES) {
        for (const ev of ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange']) {
            if (typeof node[ev] === 'string') wired.add(node[ev]);
        }
        for (const listKey of ['rowActions', 'itemActions']) {
            for (const entry of node.props[listKey] || []) if (entry.actionId) wired.add(entry.actionId);
        }
    }
    // Navigations and modal opens reach further actions transitively; the
    // top-level entry points are what matters here.
    for (const id of Object.keys(definition.actions)) {
        assert.ok(wired.has(id), `action "${id}" is not wired to anything a user can do`);
    }
    const text = JSON.stringify(definition);
    for (const v of definition.variables) {
        assert.ok(text.includes(`vars.${v.name}`), `variable "${v.name}" is declared and never read`);
    }
});
