/**
 * Sprint planning — the checks templates.test.js cannot make.
 *
 * The generic suite proves this template canonicalizes, validates and that its
 * seed rows conform to their columns. None of that can catch the failure this
 * template is actually exposed to: the VOCABULARIES DRIFTING APART.
 *
 * State, type and priority are text keys pointing at config tables rather than
 * `select` options — that is what makes them editable by the team instead of by
 * a developer (see the module header). The price is that nothing in the schema
 * ties `work_items.state` to a row in `workflow_states`. A seeded card in a
 * state no column collects does not error: it silently lands in a trailing
 * "(none)"-ish column, and the board looks broken on the very first screen a
 * customer sees. Same for a board column naming a state that does not exist, or
 * a card typed as something the type table has never heard of.
 *
 * So: assert the joins the database cannot.
 *
 * Run: cd server && node --test appStudio/templates/appSprintBoard.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appSprintBoard');
const { canonicalizeAppDefinition } = require('../canonicalize');

const { seed, dataModel, definition } = template;
const { actions } = definition;

const rowsOf = (tableId) => seed[tableId] || [];
const keysOf = (tableId, key) => new Set(rowsOf(tableId).map((r) => r[key]));

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

const NODES = allNodes(canonicalizeAppDefinition(definition).def);
const nodeById = (id) => NODES.find((n) => n.id === id);

// ── The vocabularies agree ──────────────────────────────────────────────────

test('every seeded work item is in a state the workflow defines', () => {
    const states = keysOf('tbl_states1', 'key');
    for (const item of rowsOf('tbl_items01')) {
        assert.ok(states.has(item.state), `work item "${item.title}" is in state "${item.state}", which workflow_states does not define`);
    }
});

test('every seeded work item has a type the type table defines', () => {
    const types = keysOf('tbl_types01', 'key');
    for (const item of rowsOf('tbl_items01')) {
        assert.ok(types.has(item.item_type), `work item "${item.title}" is a "${item.item_type}", which item_types does not define`);
    }
});

test('every board column collects a state that exists', () => {
    const states = keysOf('tbl_states1', 'key');
    for (const col of rowsOf('tbl_bcols01')) {
        assert.ok(states.has(col.state), `a board column collects state "${col.state}", which workflow_states does not define`);
    }
});

/**
 * The other direction, and the one that actually loses work: a card in a state
 * NO column on its board collects is invisible until someone widens the board.
 * Checked per board, because a board deliberately shows a subset of the
 * workflow (the Scrum board here skips 'ready') — the rule is that every card
 * ON a board has a column ON THAT board.
 */
test('no seeded card lands in a state its own board has no column for', () => {
    const columnsByBoard = new Map();
    for (const col of rowsOf('tbl_bcols01')) {
        const board = col.board_id.$ref;
        if (!columnsByBoard.has(board)) columnsByBoard.set(board, new Set());
        columnsByBoard.get(board).add(col.state);
    }
    for (const item of rowsOf('tbl_items01')) {
        const board = item.board_id.$ref;
        const columns = columnsByBoard.get(board);
        assert.ok(columns, `work item "${item.title}" is on board "${board}", which has no columns at all`);
        assert.ok(columns.has(item.state), `work item "${item.title}" is in state "${item.state}" on board "${board}", which has no column for it — the card would vanish from the board`);
    }
});

test('the card colour map and the type table cover the same types', () => {
    const board = nodeById('cmp_bdkb');
    const mapped = new Set(board.props.cardColorMap.map((m) => m.value));
    for (const type of keysOf('tbl_types01', 'key')) {
        assert.ok(mapped.has(type), `type "${type}" has no colour on the board's cards`);
    }
});

// ── The board reads its configuration, not its props ────────────────────────

test('the board groups by the column the config table supplies as its value', () => {
    const board = nodeById('cmp_bdkb');
    assert.equal(board.props.groupByField, 'state');
    assert.equal(board.props.columnsSource.tableId, 'tbl_bcols01');
    // normalizeAxisRows reads `value` from value|state|key — board_columns
    // carries `state`, which is also what a work item stores. If either side is
    // renamed without the other, every card falls into a trailing column.
    const columns = dataModel.tables.find((t) => t.id === 'tbl_bcols01');
    assert.ok(columns.fields.some((f) => f.key === 'state'), 'board_columns must carry a `state` column');
    const items = dataModel.tables.find((t) => t.id === 'tbl_items01');
    assert.ok(items.fields.some((f) => f.key === board.props.groupByField), 'work_items must carry the field the board groups by');
});

test('the board scopes its columns to the selected board, and refuses to guess', () => {
    const board = nodeById('cmp_bdkb');
    const scope = board.props.columnsSource.filter.find((f) => f.field === 'board_id');
    assert.ok(scope, 'the columns binding must be scoped to a board');
    assert.equal(scope.required, true, 'with no board picked it must show nothing, not every column in the workspace');
});

/**
 * One kanban serves BOTH board types. The sprint filter is optional, and an
 * optional filter whose formula resolves to null is omitted entirely — so no
 * sprint selected means "the whole board" (Kanban) and a sprint selected means
 * "just that sprint" (Scrum). If this ever became required:true, the Kanban
 * board would render permanently empty.
 */
test('the sprint scope is optional so the same board serves Kanban and Scrum', () => {
    const board = nodeById('cmp_bdkb');
    const sprint = board.props.source.filter.find((f) => f.field === 'sprint_id');
    assert.ok(sprint, 'the board must be able to narrow to a sprint');
    assert.notEqual(sprint.required, true);
    const boardScope = board.props.source.filter.find((f) => f.field === 'board_id');
    assert.equal(boardScope.required, true, 'the board itself is not optional');
});

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

test('the board is ordered by the same field the drag writes', () => {
    const board = nodeById('cmp_bdkb');
    assert.equal(board.props.rankKey, 'rank');
    assert.deepEqual(board.props.source.sort, [{ field: 'rank', dir: 'asc' }]);
    const update = flatSteps(definition.actions[board.onCardMove]).find((s) => s.kind === 'update_record');
    assert.ok(update.values.rank, 'the drag must persist the rank the board computed');
    assert.equal(update.values.rank.expr, 'form.rank');
    assert.equal(update.values.state.expr, 'form.value');
});

/**
 * The board lanes by `epic_key`, but a card's epic is decided by its PARENT.
 * A cross-lane drop must therefore be refused rather than half-applied: writing
 * form.lane would leave epic_key disagreeing with parent_id, and writing only
 * the rank would persist a slot bracketed by the neighbours of a lane the card
 * is not in — a position that means nothing.
 */
test('a cross-lane drop is refused, not half-applied', () => {
    const board = nodeById('cmp_bdkb');
    const move = definition.actions[board.onCardMove];
    const guard = move.steps.find((s) => s.kind === 'condition');
    assert.ok(guard, 'the drag must be guarded on the lane');
    assert.match(guard.expr, /form\.lane/);
    assert.match(guard.expr, /form\.item\.epic_key/);
    assert.ok(guard.then.some((s) => s.kind === 'update_record'));
    assert.equal(move.steps.some((s) => s.kind === 'update_record'), false);
    assert.ok(guard.else.some((s) => s.kind === 'toast'), 'a refused drag must say why');
});

/**
 * An aggregate binding resolves to the ROWS ARRAY. `pick` is the read-side lens
 * that narrows it to the single number a stat or progress bar is for; without it
 * the tile renders the array and every KPI reads "1".
 */
test('every scalar aggregate carries a pick naming one of its own aliases', () => {
    const offences = [];
    const visit = (obj, path) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach((o, i) => visit(o, path + '[' + i + ']')); return; }
        if (obj.kind === 'aggregate' && !Array.isArray(obj.groupBy)) {
            const aliases = (obj.aggregates || []).map((a) => a.as).filter(Boolean);
            if (!obj.pick) offences.push(path + ': no pick (would render the rows array)');
            else if (!aliases.includes(obj.pick.column)) {
                offences.push(path + ': pick.column "' + obj.pick.column + '" is not one of [' + aliases.join(', ') + ']');
            }
        }
        Object.entries(obj).forEach(([k, v]) => visit(v, path + '.' + k));
    };
    visit(definition.screens, 'screens');
    assert.deepEqual(offences, []);
});

test('the capacity bar measures against the sprint capacity, not a made-up 100', () => {
    const bar = nodeById('cmp_spcap');
    assert.equal(bar.type, 'progress');
    assert.equal(bar.props.max.kind, 'formula');
    assert.match(bar.props.max.expr, /capacity_points/);
});

/**
 * The backlog is the pool you pull FROM. Scoping it to the selected sprint would
 * list only the items already in it, leaving "To sprint" — the one action that
 * matters on this screen — with nothing to act on.
 */
test('the backlog lists the whole board, so "To sprint" has something to move', () => {
    const grid = nodeById('cmp_blgrid');
    const fields = grid.props.source.filter.map((f) => f.field);
    assert.ok(fields.includes('board_id'));
    assert.equal(fields.includes('sprint_id'), false, 'the backlog must not narrow to the selected sprint');
    const toSprint = grid.props.rowActions.find((a) => a.label === 'To sprint');
    assert.ok(toSprint, 'the backlog must offer a way into the sprint');
    const update = flatSteps(definition.actions[toSprint.actionId]).find((s) => s.kind === 'update_record');
    assert.equal(update.values.sprint_id.expr, 'vars.sprint.id');
});

/**
 * New work must not all land on one rank. Tied neighbours have no gap to insert
 * between, so a drag between them cannot express a new position without
 * renumbering them — and there is no atomic multi-row write to do that with.
 */
test('a newly raised item gets a distinct rank, not a shared constant', () => {
    const create = flatSteps(definition.actions.act_blcreate).find((s) => s.kind === 'create_record');
    const rank = create.values.rank;
    assert.equal(rank.kind, 'formula', 'a constant rank would tie every new item');
    assert.match(rank.expr, /now/, 'the distinct value has to come from the clock');
});

/**
 * The header's whole argument is that a lead configures the board from inside
 * the running app. That is only true if Setup can CREATE and REMOVE rows — a
 * grid that edits what someone else seeded is a demo of the idea, not the idea.
 */
test('every configuration table can be added to and removed from', () => {
    const CONFIG_TABLES = ['tbl_boards1', 'tbl_bcols01', 'tbl_states1', 'tbl_types01', 'tbl_member1'];
    const creates = new Set();
    const deletes = new Set();
    for (const action of Object.values(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (step.kind === 'create_record') creates.add(step.tableId);
            if (step.kind === 'delete_record') deletes.add(step.tableId);
        }
    }
    for (const tableId of CONFIG_TABLES) {
        assert.ok(creates.has(tableId), 'nothing can create a row in ' + tableId);
        assert.ok(deletes.has(tableId), 'nothing can delete a row from ' + tableId);
    }
});

test('every destructive action asks first', () => {
    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        if (!steps.some((s) => s.kind === 'delete_record')) continue;
        assert.ok(steps.some((s) => s.kind === 'confirm'), actionId + ' deletes without confirming');
    }
});

test('the seeded Kanban board really exceeds a WIP limit, so the limit is visible on install', () => {
    const doing = rowsOf('tbl_bcols01').find((c) => c.board_id.$ref === 'bd_kanban' && c.state === 'doing');
    assert.ok(doing.wip_limit > 0, 'the Kanban board must ship a real limit');
    const inDoing = rowsOf('tbl_items01').filter((i) => i.board_id.$ref === 'bd_kanban' && i.state === 'doing');
    assert.ok(inDoing.length > doing.wip_limit,
        `expected the seed to breach the ${doing.wip_limit}-card limit so the board shows what a limit does; found ${inDoing.length}`);
});

// ── Hierarchy ───────────────────────────────────────────────────────────────

test('the hierarchy is one self-referencing table, three levels deep in the seed', () => {
    const items = dataModel.tables.find((t) => t.id === 'tbl_items01');
    const parent = items.fields.find((f) => f.key === 'parent_id');
    assert.equal(parent.type, 'relation');
    assert.equal(parent.relation.table, 'tbl_items01', 'parent_id must point at work_items itself');

    // epic → story → task, by alias.
    const byAlias = new Map(rowsOf('tbl_items01').filter((r) => r.$id).map((r) => [r.$id, r]));
    const task = rowsOf('tbl_items01').find((r) => r.item_type === 'task' && r.parent_id);
    const story = byAlias.get(task.parent_id.$ref);
    assert.ok(story, 'a seeded task must hang off a seeded story');
    const epic = byAlias.get(story.parent_id.$ref);
    assert.ok(epic, 'that story must hang off a seeded epic');
    assert.equal(epic.item_type, 'epic');
});

/**
 * There are no joins, so the board's swimlanes read a DENORMALISED copy of the
 * epic. A child whose epic_key disagrees with its parent's would sit in the
 * wrong lane with nothing to explain why.
 */
test('every child carries the same epic_key as its parent', () => {
    const byAlias = new Map(rowsOf('tbl_items01').filter((r) => r.$id).map((r) => [r.$id, r]));
    for (const item of rowsOf('tbl_items01')) {
        if (!item.parent_id) continue;
        const parent = byAlias.get(item.parent_id.$ref);
        assert.ok(parent, `"${item.title}" references a parent alias that is not seeded`);
        assert.equal(item.epic_key, parent.epic_key,
            `"${item.title}" is in epic lane "${item.epic_key}" but its parent is in "${parent.epic_key}"`);
    }
});

test('the board lanes by the denormalised copy, not by the relation it cannot follow', () => {
    const board = nodeById('cmp_bdkb');
    assert.equal(board.props.swimlaneField, 'epic_key');
    const items = dataModel.tables.find((t) => t.id === 'tbl_items01');
    const field = items.fields.find((f) => f.key === 'epic_key');
    assert.equal(field.type, 'text', 'epic_key is a display copy; a relation here could not be grouped by');
});

// ── The logic behind the controls ───────────────────────────────────────────

/**
 * A server step's formula scope has no `screen`, `forms`, `actions`, `records`
 * or `datasets`. A binding naming one of those resolves in the browser preview
 * and writes NULL in production — the worst kind of wrong, because it passes
 * every check an author can run before shipping.
 */
test('no server step reads a scope root the server does not populate', () => {
    const SERVER_KINDS = new Set(['create_record', 'update_record', 'delete_record']);
    const FORBIDDEN = /^(screen|forms|actions|records|datasets)\b/;
    const offences = [];

    const visit = (steps, actionId) => {
        for (const step of steps || []) {
            for (const branch of ['then', 'else', 'steps']) {
                if (Array.isArray(step[branch])) visit(step[branch], actionId);
            }
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
    };
    for (const [actionId, action] of Object.entries(definition.actions)) {
        visit(action.kind === 'sequence' ? action.steps : [action], actionId);
    }
    assert.deepEqual(offences, []);
});

test('every mutation refreshes the table it dirtied', () => {
    const TABLE_OF = { create_record: true, update_record: true, delete_record: true };
    for (const [actionId, action] of Object.entries(definition.actions)) {
        if (action.kind !== 'sequence') continue;
        const flat = [];
        const walk = (steps) => {
            for (const s of steps || []) {
                flat.push(s);
                for (const branch of ['then', 'else', 'steps']) if (Array.isArray(s[branch])) walk(s[branch]);
            }
        };
        walk(action.steps);
        const dirtied = new Set(flat.filter((s) => TABLE_OF[s.kind]).map((s) => s.tableId));
        if (!dirtied.size) continue;
        const refreshed = new Set(flat.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
        for (const tableId of dirtied) {
            assert.ok(refreshed.has(tableId),
                `${actionId} writes ${tableId} but never refreshes it — the change would not appear until something else refetched`);
        }
    }
});

test('picking a board clears the sprint, so a stale scope cannot empty the new board', () => {
    const pick = definition.actions.act_bdpick;
    const sets = pick.steps.filter((s) => s.kind === 'set_variable').map((s) => s.name);
    assert.deepEqual(sets, ['board', 'sprint']);
    const clear = pick.steps.find((s) => s.name === 'sprint');
    assert.deepEqual(clear.value, { kind: 'static', value: null });
});

// ── Runs with and without Nextcloud ─────────────────────────────────────────

/**
 * The template must be identical in both places. It is allowed to BENEFIT from
 * Nextcloud (an embedded viewer resolves to their NC identity, so currentUser
 * is the signed-in Nextcloud user), but it must not REQUIRE it: no connector
 * binding, no NC-only action, nothing that leaves a standalone install broken.
 */
test('nothing in the app requires Nextcloud to be connected', () => {
    const bindingsWith = (obj, out = []) => {
        if (!obj || typeof obj !== 'object') return out;
        if (Array.isArray(obj)) { obj.forEach((o) => bindingsWith(o, out)); return out; }
        if (typeof obj.kind === 'string') out.push(obj.kind);
        Object.values(obj).forEach((v) => bindingsWith(v, out));
        return out;
    };
    const kinds = new Set(bindingsWith(definition));
    assert.equal(kinds.has('connector'), false, 'a connector binding would need an external system configured');
    assert.equal(dataModel.connectors, undefined, 'the data model must not ship a connector');

    const stepKinds = new Set();
    for (const action of Object.values(definition.actions)) {
        const walk = (steps) => {
            for (const s of steps || []) {
                stepKinds.add(s.kind);
                for (const b of ['then', 'else', 'steps']) if (Array.isArray(s[b])) walk(s[b]);
            }
        };
        if (action.kind === 'sequence') walk(action.steps); else stepKinds.add(action.kind);
    }
    assert.equal(stepKinds.has('run_automation'), false, 'a routine dependency would not install cleanly');
});

test('identity is the viewer\'s user id, and something can actually write it', () => {
    // This used to assert the e-mail match, which was true and useless: NOTHING
    // in the app could write an assignee, so "only mine" filtered a column that
    // was empty on every row. The pair that matters is the write and the read
    // agreeing on the same column.
    const items = dataModel.tables.find((t) => t.id === 'tbl_items01');
    assert.ok(items.fields.some((f) => f.key === 'assignee_id'), 'the id column must exist');
    assert.ok(items.fields.some((f) => f.key === 'assignee_name'), 'the denormalised name must exist too — there are no joins');
    // The app declares the directory read that fills the picker.
    assert.equal(dataModel.directory?.orgMembers, true);

    const board = nodeById('cmp_bdkb');
    const mine = board.props.source.filter.find((f) => f.field === 'assignee_id');
    assert.ok(mine, 'the board must be able to narrow to the viewer');
    assert.match(mine.value.expr, /currentUser\.id/);

    // At least one action writes BOTH halves. An action that wrote only the id
    // would store a row whose owner nobody can read.
    const writers = Object.values(actions).filter((a) => JSON.stringify(a).includes('assignee_id'));
    assert.ok(writers.length >= 2, 'creating and assigning must both be possible');
    for (const w of writers) {
        const json = JSON.stringify(w);
        assert.ok(json.includes('assignee_name'), 'an assignee write must carry the display name with it');
    }
});

test('the board screen is full width and fills its height — it is embedded in a Nextcloud page', () => {
    const { def } = canonicalizeAppDefinition(definition);
    const board = def.screens.find((s) => s.id === 'scr_board');
    assert.equal(board.maxWidth, 'full');
    // The fill section stretches its FIRST grid row only, so the board's main
    // section must hold exactly one row of children.
    const main = board.sections.find((s) => s.id === 'sec_bdmain');
    assert.equal(main.style.height, 'fill');
    const spans = main.children.map((c) => c.style.span);
    assert.equal(spans.reduce((a, b) => a + b, 0), 12, 'the fill section must be a single 12-column row');
});
