/**
 * Every built-in template must be structurally valid — it is loaded verbatim
 * into the builder and must pass the SAME validateDefinition() gate the AI
 * builder's output does, or the user picks a template that can never activate.
 *
 * Also asserts that any restricted-grammar expression a template embeds
 * (condition/switch `expr`, and any `{kind:'expr'}` binding value) actually
 * parses — bind.js silently swallows a parse error to `undefined`, so a bad
 * expr in a template corrupts every run without any validation error.
 *
 * Run: node --test automation/templates.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { listTemplates, getTemplate } = require('./templates');
const { validateDefinition } = require('./validate');
const { getDeliverableEvents } = require('./deliverableEvents');
const { parseExpr } = require('./expr');
const { COMPLETENESS_CODES } = require('./validate/completenessCodes');

const deliverableEvents = getDeliverableEvents();

// Walk a definition collecting every expression that MUST parse under the
// restricted grammar: condition/switch step exprs, and any {kind:'expr'}
// binding value anywhere in a step's inputs/params/fields.
function collectExprs(def) {
    const exprs = [];
    const visitBindings = (obj, where) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.kind === 'expr' && typeof obj.value === 'string') {
            exprs.push({ expr: obj.value, where });
            return;
        }
        for (const k of Object.keys(obj)) visitBindings(obj[k], `${where}.${k}`);
    };
    for (const s of (def.steps || [])) {
        if ((s.type === 'condition' || s.type === 'switch') && typeof s.expr === 'string') {
            exprs.push({ expr: s.expr, where: `${s.id}.expr` });
        }
        // switch cases may carry per-case exprs
        for (const c of (s.cases || [])) if (typeof c?.expr === 'string') exprs.push({ expr: c.expr, where: `${s.id}.case.expr` });
        visitBindings(s.inputs, `${s.id}.inputs`);
        visitBindings(s.params, `${s.id}.params`);
        visitBindings(s.fields, `${s.id}.fields`);
    }
    return exprs;
}

const templates = listTemplates();

test('the template gallery is non-empty', () => {
    assert.ok(templates.length > 0, 'expected at least one built-in template');
});

for (const meta of templates) {
    test(`template "${meta.id}" passes validateDefinition`, () => {
        const t = getTemplate(meta.id);
        assert.ok(t && t.definition, `template ${meta.id} has a definition`);

        /**
         * A template is a STARTING POINT, and some deliberately ship a blank
         * for the user to fill: the Talk digest has no room token, the
         * resolved-tickets one has no knowledge base — the person picking the
         * template picks those, and until they do the automation cannot activate.
         *
         * So the bar is two-part, and both halves matter:
         *   draft    — must be clean. A template that a user cannot even SAVE
         *              after loading it is broken however you look at it.
         *   activate — may only be blocked by COMPLETENESS codes, the ones
         *              that mean "not filled in yet". Anything else is an
         *              integrity problem the user can never fix from the
         *              builder, and it must not ship in a template.
         *
         * This is stricter than the old single activate-stage assertion, which
         * a blank slipped past only because it was an EMPTY STRING rather than
         * a missing key.
         */
        const draft = validateDefinition(t.definition, { deliverableEvents, stage: 'draft' });
        assert.ok(draft.ok, `template ${meta.id} must SAVE cleanly; errors: ${JSON.stringify(draft.errors)}`);

        const live = validateDefinition(t.definition, { deliverableEvents });
        const notFillable = (live.errors || []).filter(e => !COMPLETENESS_CODES.has(e.code));
        assert.deepStrictEqual(
            notFillable, [],
            `template ${meta.id} may only be blocked by "not filled in yet"; got: ${JSON.stringify(notFillable)}`,
        );
    });

    test(`template "${meta.id}" embeds only parseable restricted expressions`, () => {
        const t = getTemplate(meta.id);
        for (const { expr, where } of collectExprs(t.definition)) {
            assert.doesNotThrow(
                () => parseExpr(expr),
                `template ${meta.id}: expression at ${where} must parse under the restricted grammar: ${expr}`,
            );
        }
    });

    test(`template "${meta.id}" uses correct binding shapes (no silent no-ops)`, () => {
        const t = getTemplate(meta.id);
        for (const s of (t.definition.steps || [])) {
            if (s.type === 'notification') {
                // execNotification only interpolates STRING title/body — an
                // object binding wrapper renders as empty.
                for (const k of ['title', 'body']) {
                    if (s[k] !== undefined) {
                        assert.strictEqual(typeof s[k], 'string', `template ${meta.id}: notification "${s.id}".${k} must be a template string, not a binding object (execNotification renders objects as empty)`);
                    }
                }
            }
        }
        // A literal binding whose value contains {{...}} ships verbatim (the
        // braces never interpolate) — it must be kind:'template' instead.
        const checkNoLiteralTemplate = (obj, where) => {
            if (!obj || typeof obj !== 'object') return;
            if (obj.kind === 'literal' && typeof obj.value === 'string' && /\{\{[^}]+\}\}/.test(obj.value)) {
                assert.fail(`template ${meta.id}: literal binding at ${where} contains {{...}} but kind is 'literal' (won't interpolate) — use kind:'template'`);
            }
            for (const k of Object.keys(obj)) checkNoLiteralTemplate(obj[k], `${where}.${k}`);
        };
        for (const s of (t.definition.steps || [])) checkNoLiteralTemplate(s.inputs, `${s.id}.inputs`);
    });
}

// ── nc-form-intake: the Forms → Tables → PDF workflow ──────────────────────
//
// This is the template the Nextcloud integration is judged on, so its
// contract is pinned rather than left to "it validated once".

test('nc-form-intake loads into the builder cleanly', () => {
    const t = getTemplate('nc-form-intake');
    assert.ok(t, 'template exists');
    const res = validateDefinition(t.definition);
    assert.deepStrictEqual(res.errors || [], [],
        'the gallery/create path is lenient — a template must load without errors there');
});

test('nc-form-intake blocks activation until the user picks a table and a board', () => {
    // The ids are intentionally empty literals. Activation runs the strict
    // gate, which turns "you did not choose a table" into a clear pre-flight
    // error instead of an automation that activates, reports healthy, and fails on
    // its first fire. Regressing this to a placeholder number (0) would restore
    // exactly that silent failure.
    const { loadTools, TOOL_REGISTRY } = require('./toolRegistry');
    const availableTools = new Set();
    const toolRequiredParams = {};
    for (const entry of TOOL_REGISTRY) {
        let tools = [];
        try { tools = loadTools(entry) || []; } catch (_) { continue; }
        for (const tool of tools) {
            const fn = tool.function || {};
            availableTools.add(fn.name);
            toolRequiredParams[fn.name] = fn.parameters?.required || [];
        }
    }
    const res = validateDefinition(getTemplate('nc-form-intake').definition,
        { availableTools, toolRequiredParams });
    const missing = (res.errors || []).filter(e => e.code === 'integration_action.param_missing');
    assert.ok(missing.length >= 3, 'tableId, boardId and stackId are all flagged');
    // Everything else must be clean — a template shipping any OTHER activation
    // error is a broken template, not a configuration prompt.
    const other = (res.errors || []).filter(e => e.code !== 'integration_action.param_missing');
    assert.deepStrictEqual(other, [], 'no errors beyond the deliberate configuration prompts');
});

test('nc-form-intake fires: its trigger has a real producer', () => {
    const t = listTemplates().find(x => x.id === 'nc-form-intake');
    assert.strictEqual(t.triggerReadiness, 'ready',
        'forms.submitted is webhook-backed — if this reads "unsupported", deriveTemplateMeta '
        + 'has stopped accounting for WEBHOOK_BACKED events and every Forms/Tables/Calendar '
        + 'template is mislabelled in the gallery');
});

test('templates whose trigger has no producer are labelled, not silently broken', () => {
    // Share is the last family Nextcloud exposes no webhook-compatible event
    // class for (ShareCreatedEvent/ShareDeletedEvent still `extends Event` on
    // server HEAD), and we have no poller for it. It must not read as 'ready'.
    const t = listTemplates().find(x => x.id === 'nc-share-approval');
    if (t) {
        assert.notStrictEqual(t.triggerReadiness, 'ready',
            'nc-share-approval subscribes to an event Nextcloud cannot deliver and must say so');
    }
});

test('the Deck template is ready now that Deck events are webhook-backed', () => {
    // This spent months labelled unsupported on a false premise: our own code
    // said Deck exposed no webhook-compatible events, which stopped being true
    // at Deck v1.18.0 (2026-05-03). If this regresses to 'unsupported', either
    // the Deck registration was dropped from webhookListeners.js EVENTS or
    // deliverableEvents stopped counting it.
    const t = listTemplates().find(x => x.id === 'nc-deck-done-celebrate');
    if (!t) return;
    assert.strictEqual(t.triggerReadiness, 'ready',
        'deck.card.completed is webhook-backed (derived from CardUpdatedEvent)');
});
