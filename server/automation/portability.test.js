'use strict';

/**
 * Unit tests for portability.js — the WS6 automation import/export layer.
 *
 * Run: node automation/portability.test.js   (from server/)
 *
 * Pure module, no DB/network; plain assert like the sibling tests.
 * validateDefinition is pulled in read-only to prove re-keyed fixtures
 * (including ones WITH inline layers) still validate.
 */

const assert = require('assert');
const { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION, buildExport, sanitizeImport, rekeyDefinition } = require('./portability');
const { validateDefinition } = require('./validate');

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// Root + one inline layer; the layer deliberately REUSES the ids `trg` and
// `s1` so per-graph rename scoping is actually exercised (a layer binding to
// steps.s1 must follow the LAYER's map, not the root's).

function makeDefinition() {
    return {
        schemaVersion: 2,
        // The trigger carries a pin too (BFSF-408): a sample payload the author
        // saved so builder runs enter with data. It is the author's own inbox
        // content, so export has to strip it exactly as it strips a step's.
        trigger: {
            id: 'trg', type: 'trigger', kind: 'manual',
            pinnedOutput: { from: 'boekhouding@klant-bv.nl', subject: 'FACTUUR-9912' },
            pinnedAt: '2026-08-30T09:00:00.000Z',
            pinnedSource: 'captured',
        },
        // An ADDITIONAL entry point, pinned as well — definition.triggers[] was
        // the other half of the sweep's blind spot.
        triggers: [{
            id: 'trg2', type: 'trigger', kind: 'webhook',
            pinnedOutput: { hook: 'WEBHOOK-SAMPLE-BODY' },
            pinnedAt: '2026-08-30T09:05:00.000Z',
            pinnedSource: 'edited',
        }],
        steps: [
            {
                id: 's1', type: 'integration_action', tool: 'gmail_search',
                inputs: { q: { kind: 'literal', value: 'invoices {{steps.s1}}' } }, // literal ships verbatim — must NOT be rewritten
                pinnedOutput: { count: 2, items: [{ subject: 'inv-1', from: 'a@b.c', date: '2026-06-01', amount: 12 }] },
                pinnedAt: '2026-08-30T08:00:00.000Z',
                pinnedSource: 'captured',
            },
            { id: 'cond1', type: 'condition', expr: 'steps.s1.output.count > 0 && steps.s1.output.label != "steps.s1 failed"' },
            { id: 'n1', type: 'notification', title: 'Found {{steps.s1.output.count}}', body: 'First: {{ steps.s1.output.items[0].subject }}' },
            {
                id: 'loop1', type: 'loop', itemVar: 'item', overRef: 'steps.s1.output.items', maxIterations: 100,
                body: [
                    {
                        id: 'lb1', type: 'set',
                        fields: {
                            subj: { kind: 'ref', path: 'loop.item.subject' },
                            parent: { kind: 'ref', path: 'steps.s1.output.count' },
                        },
                        pinnedOutput: { subj: 'pinned-in-loop' },
                    },
                ],
            },
            {
                id: 'par1', type: 'parallel',
                branches: [[
                    { id: 'pb1', type: 'datetime', op: 'parse', input: 'steps.s1.output.items[0].date' },
                ]],
            },
            { id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: { email: { kind: 'ref', path: 'steps["s1"].output.items[0].from' } } },
            { id: 'f1', type: 'filter', arrayRef: 'steps.s1.output.items', expr: 'item.amount > 10' },
            { id: 'stop1', type: 'stop_error', message: 'Nothing matched {{steps.s1.output.count}}' },
        ],
        edges: [
            { from: 'trg', to: 's1' },
            { from: 'trg2', to: 's1' },
            { from: 's1', to: 'cond1' },
            { from: 'cond1', to: 'n1', label: 'then' },
            { from: 'cond1', to: 'f1', label: 'else' },
            { from: 'n1', to: 'loop1' },
            { from: 'loop1', to: 'par1' },
            { from: 'par1', to: 'cl1' },
            { from: 'f1', to: 'stop1' },
        ],
        vars: { fromVar: { kind: 'ref', path: 'steps.s1.output.count' } },
        layers: {
            enrich: {
                title: 'Enrich contact',
                trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'email', type: 'string', required: true }] },
                steps: [
                    {
                        id: 's1', type: 'ai_step', prompt: 'Enrich {{email}} please',
                        inputs: { email: { kind: 'ref', path: 'trigger.output.email' } },
                        // `out` reads .company — an ai_step only answers fields
                        // it declares (validate: ai_step.output_schema_missing).
                        outputSchema: { type: 'object', properties: { company: { type: 'string' } } },
                        pinnedOutput: { company: 'ACME' },
                    },
                    {
                        id: 'out', type: 'layer_output',
                        fields: {
                            company: { kind: 'ref', path: 'steps.s1.output.company' },
                            viaTpl: { kind: 'template', value: 'company={{steps.s1.output.company}}' },
                        },
                    },
                ],
                edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'out' }],
            },
        },
    };
}

function makeRow(overrides = {}) {
    return {
        id: '2f9c5e1a-0000-4000-8000-aaaaaaaaaaaa',
        userId: 'user-123',
        organizationId: 'org-456',
        kind: 'automation',
        title: 'Invoice sweep',
        description: 'Finds invoices and enriches senders',
        definition: makeDefinition(),
        version: 7,
        isActive: true,
        isDraft: false,
        needsFirstRunConfirm: false,
        triggerType: 'schedule',
        scheduleCron: '0 9 * * *',
        scheduleTz: 'Europe/Amsterdam',
        nextRunAt: '2026-06-11T07:00:00.000Z',
        runningInstanceId: 'pod-7',
        attempts: 3,
        builderSession: { messages: ['SECRET-TRANSCRIPT'] },
        createdFromChatId: 'chat-789',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        ...overrides,
    };
}

// Sanity: the fixture itself validates (so later "post-rekey validates"
// assertions actually prove rekey didn't break anything).
{
    const v = validateDefinition(makeDefinition());
    assert.strictEqual(v.ok, true, `fixture must validate: ${JSON.stringify(v.errors)}`);
}

// ── 1. buildExport — allowlist envelope, no forbidden fields ────────────
{
    const row = makeRow();
    const before = JSON.stringify(row);
    const { envelope, warnings } = buildExport(row);

    assert.strictEqual(envelope.format, EXPORT_FORMAT);
    assert.strictEqual(envelope.format, 'beeflow.automation');
    assert.strictEqual(envelope.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.strictEqual(envelope.schemaVersion, 1);
    assert.ok(!Number.isNaN(Date.parse(envelope.exportedAt)), 'exportedAt is a parseable timestamp');
    assert.ok(Math.abs(Date.now() - Date.parse(envelope.exportedAt)) < 10_000, 'exportedAt is "now"');

    // Exactly the allowlisted keys — nothing else.
    assert.deepStrictEqual(
        Object.keys(envelope.automation).sort(),
        ['definition', 'description', 'scheduleCron', 'scheduleTz', 'title', 'triggerType'],
    );
    assert.strictEqual(envelope.automation.title, 'Invoice sweep');
    assert.strictEqual(envelope.automation.triggerType, 'schedule');
    assert.strictEqual(envelope.automation.scheduleCron, '0 9 * * *');

    // No forbidden values anywhere in the serialized envelope.
    const json = JSON.stringify(envelope);
    for (const leak of ['2f9c5e1a', 'user-123', 'org-456', 'SECRET-TRANSCRIPT', 'chat-789', 'pod-7', 'builderSession', 'isActive', 'nextRunAt', 'runningInstanceId']) {
        assert.ok(!json.includes(leak), `envelope must not contain "${leak}"`);
    }

    // Pinned data stripped everywhere — root TRIGGER, additional trigger, root
    // step, loop body, layer step — and warned about, one warning per node.
    assert.ok(!json.includes('pinnedOutput'), 'no pinnedOutput survives export');
    assert.ok(!json.includes('pinned-in-loop'), 'loop-body pinned value stripped');
    assert.ok(!json.includes('ACME'), 'layer pinned value stripped');
    assert.ok(!json.includes('klant-bv.nl'), 'the TRIGGER sample payload is stripped');
    assert.ok(!json.includes('WEBHOOK-SAMPLE-BODY'), 'the additional trigger sample payload is stripped');
    // The whole pin goes, not just its payload: a leftover pinnedAt is still a
    // timestamp from the author's install, and reads as a corrupt pin in the
    // importer's builder.
    assert.ok(!json.includes('pinnedAt'), 'pinnedAt goes with the pin');
    assert.ok(!json.includes('pinnedSource'), 'pinnedSource goes with the pin');
    assert.strictEqual(warnings.length, 5, `one warning per stripped pin (got ${JSON.stringify(warnings)})`);
    assert.ok(warnings.some(w => w.includes('step "s1"') && !w.includes('layer')), 'root step pin warned');
    assert.ok(warnings.some(w => w.includes('"lb1"')), 'loop-body pin warned');
    assert.ok(warnings.some(w => w.includes('layer "enrich"')), 'layer pin warned with layer key');
    assert.ok(warnings.some(w => w.includes('trigger "trg"')), 'primary trigger pin warned, as a TRIGGER');
    assert.ok(warnings.some(w => w.includes('trigger "trg2"')), 'additional trigger pin warned');

    // And the exported definition really has no pin fields left on either
    // trigger — a substring check on the envelope would pass on a `{}` value.
    const exportedDef = envelope.automation.definition;
    for (const node of [exportedDef.trigger, exportedDef.triggers[0]]) {
        assert.strictEqual(node.pinnedOutput, undefined);
        assert.strictEqual(node.pinnedAt, undefined);
        assert.strictEqual(node.pinnedSource, undefined);
    }
    assert.strictEqual(exportedDef.trigger.kind, 'manual', 'the rest of the trigger survives');

    // Inline layers ride along; the source row is never mutated.
    assert.ok(envelope.automation.definition.layers.enrich, 'layers ride along in the definition');
    assert.strictEqual(JSON.stringify(row), before, 'buildExport must not mutate its input');
}

// ── 2. sanitizeImport — format / schemaVersion gate ─────────────────────
{
    const { envelope } = buildExport(makeRow());

    // Round trip: a fresh export imports cleanly.
    const ok = sanitizeImport(envelope);
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.automation.title, 'Invoice sweep');

    // Bare { automation } body (no format/schemaVersion) is tolerated.
    const bare = sanitizeImport({ automation: envelope.automation });
    assert.deepStrictEqual(bare.errors, []);

    // Unknown sibling fields on the envelope are ignored (export may embed
    // exportWarnings; future-proofing for additive metadata).
    const extra = sanitizeImport({ ...envelope, exportWarnings: ['x'], somethingElse: 1 });
    assert.deepStrictEqual(extra.errors, []);

    // Wrong format → rejected.
    const badFormat = sanitizeImport({ ...envelope, format: 'n8n.workflow' });
    assert.strictEqual(badFormat.automation, null);
    assert.ok(badFormat.errors.some(e => e.includes('n8n.workflow')), `format error names the format: ${badFormat.errors}`);

    // Newer schemaVersion → clear "newer than this server" message.
    const newer = sanitizeImport({ ...envelope, schemaVersion: 2 });
    assert.strictEqual(newer.automation, null);
    assert.ok(newer.errors.some(e => /newer than this server supports/.test(e)), `newer-version message: ${newer.errors}`);

    // Junk schemaVersion → rejected too.
    const junk = sanitizeImport({ ...envelope, schemaVersion: '1' });
    assert.strictEqual(junk.automation, null);
    assert.ok(junk.errors.some(e => e.includes('Unsupported schemaVersion')));

    // Non-object / missing automation / bad shapes.
    assert.ok(sanitizeImport(null).errors.length === 1);
    assert.ok(sanitizeImport([1, 2]).errors.length === 1);
    assert.ok(sanitizeImport({}).errors.some(e => e.includes('automation')));
    assert.ok(sanitizeImport({ automation: { title: '', definition: {} } }).errors.some(e => e.includes('title')));
    assert.ok(sanitizeImport({ automation: { title: 'x', definition: 'nope' } }).errors.some(e => e.includes('definition')));
    assert.ok(sanitizeImport({ automation: { title: 'x', definition: {}, triggerType: 42 } }).errors.some(e => e.includes('triggerType')));
}

// ── 3. sanitizeImport — allowlist strips unknown/forbidden fields ───────
{
    const res = sanitizeImport({
        automation: {
            id: 'attacker-chosen-id',
            userId: 'someone-else',
            organizationId: 'their-org',
            isActive: true,
            isDraft: false,
            version: 99,
            builderSession: { messages: [] },
            webhooks: [{ slug: 'x', secret: 'y' }],
            title: '  Imported flow  ',
            description: 'desc',
            triggerType: 'manual',
            scheduleCron: null,
            scheduleTz: null,
            definition: { trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
        },
    });
    assert.deepStrictEqual(res.errors, []);
    assert.deepStrictEqual(
        Object.keys(res.automation).sort(),
        ['definition', 'description', 'scheduleCron', 'scheduleTz', 'title', 'triggerType'],
        'only allowlisted fields survive import',
    );
    assert.strictEqual(res.automation.title, 'Imported flow', 'title trimmed');
    // Defaults applied.
    const defaults = sanitizeImport({ automation: { title: 'x', definition: { a: 1 } } });
    assert.strictEqual(defaults.automation.triggerType, 'manual');
    assert.strictEqual(defaults.automation.scheduleCron, null);
    assert.strictEqual(defaults.automation.scheduleTz, null);
    // definition is cloned, not aliased.
    const srcDef = { trigger: { id: 't' }, steps: [], edges: [] };
    const cloned = sanitizeImport({ automation: { title: 'x', definition: srcDef } });
    assert.notStrictEqual(cloned.automation.definition, srcDef);
    assert.deepStrictEqual(cloned.automation.definition, srcDef);
}

// ── 4. rekeyDefinition — ids, edges, refs, templates, exprs ─────────────
{
    const def = makeDefinition();
    const before = JSON.stringify(def);
    const { definition: rk, renameMap } = rekeyDefinition(def);
    assert.strictEqual(JSON.stringify(def), before, 'rekeyDefinition must not mutate its input');

    const root = renameMap.root;
    const oldRootIds = ['trg', 'trg2', 's1', 'cond1', 'n1', 'loop1', 'lb1', 'par1', 'pb1', 'cl1', 'f1', 'stop1'];
    assert.deepStrictEqual(Object.keys(root).sort(), [...oldRootIds].sort(), 'every root id (incl. loop-body + parallel-branch steps) is renamed');
    for (const [oldId, newId] of Object.entries(root)) {
        assert.notStrictEqual(newId, oldId, `fresh id for ${oldId}`);
        assert.ok(newId.startsWith(`${oldId.split('_')[0]}_`) || newId.startsWith(`${oldId}_`), `prefix preserved for ${oldId} → ${newId}`);
    }
    const newIdSet = new Set(Object.values(root));
    assert.strictEqual(newIdSet.size, oldRootIds.length, 'no fresh-id collisions');

    // Trigger + steps carry the new ids — including the ADDITIONAL trigger,
    // which used to keep its original id while the edges out of it were
    // rewritten to the fresh ones.
    assert.strictEqual(rk.trigger.id, root.trg);
    assert.strictEqual(rk.triggers[0].id, root.trg2);
    const stepById = new Map(rk.steps.map(s => [s.id, s]));
    assert.ok(stepById.has(root.s1) && stepById.has(root.cl1));

    // Edges rewritten (root graph).
    for (const e of rk.edges) {
        assert.ok([...newIdSet].includes(e.from), `edge.from rewritten: ${e.from}`);
        assert.ok([...newIdSet].includes(e.to), `edge.to rewritten: ${e.to}`);
    }
    // Labels intact.
    assert.ok(rk.edges.some(e => e.from === root.cond1 && e.to === root.n1 && e.label === 'then'));

    // Expr rewritten; quoted string literal containing "steps.s1" preserved.
    const cond = stepById.get(root.cond1);
    assert.strictEqual(cond.expr, `steps.${root.s1}.output.count > 0 && steps.${root.s1}.output.label != "steps.s1 failed"`);

    // Template strings rewritten with spacing preserved.
    const notif = stepById.get(root.n1);
    assert.strictEqual(notif.title, `Found {{steps.${root.s1}.output.count}}`);
    assert.strictEqual(notif.body, `First: {{ steps.${root.s1}.output.items[0].subject }}`);
    const stop = stepById.get(root.stop1);
    assert.strictEqual(stop.message, `Nothing matched {{steps.${root.s1}.output.count}}`);

    // Loop: overRef rewritten; body step renamed; body bindings follow the
    // SAME (root) map; loop.item refs untouched.
    const loop = stepById.get(root.loop1);
    assert.strictEqual(loop.overRef, `steps.${root.s1}.output.items`);
    assert.strictEqual(loop.body[0].id, root.lb1);
    assert.strictEqual(loop.body[0].fields.subj.path, 'loop.item.subject');
    assert.strictEqual(loop.body[0].fields.parent.path, `steps.${root.s1}.output.count`);

    // Parallel branch: step renamed, datetime ref-string input rewritten.
    const par = stepById.get(root.par1);
    assert.strictEqual(par.branches[0][0].id, root.pb1);
    assert.strictEqual(par.branches[0][0].input, `steps.${root.s1}.output.items[0].date`);

    // call_layer: layerKey unchanged; bracket-form ref rewritten with the root map.
    const cl = stepById.get(root.cl1);
    assert.strictEqual(cl.layerKey, 'enrich', 'layer KEYS stay unchanged');
    assert.strictEqual(cl.inputs.email.path, `steps["${root.s1}"].output.items[0].from`);

    // Collection op: arrayRef rewritten; item-scoped expr untouched.
    const filt = stepById.get(root.f1);
    assert.strictEqual(filt.arrayRef, `steps.${root.s1}.output.items`);
    assert.strictEqual(filt.expr, 'item.amount > 10');

    // Literal binding values ship verbatim at run time → never rewritten.
    assert.strictEqual(stepById.get(root.s1).inputs.q.value, 'invoices {{steps.s1}}');

    // vars bindings follow the root map.
    assert.strictEqual(rk.vars.fromVar.path, `steps.${root.s1}.output.count`);

    // ── Per-layer scoping ────────────────────────────────────────────────
    const lmap = renameMap.layers.enrich;
    assert.deepStrictEqual(Object.keys(rk.layers), ['enrich'], 'layer keys unchanged');
    assert.deepStrictEqual(Object.keys(lmap).sort(), ['out', 's1', 'trg']);
    // The layer's rename of `s1` is INDEPENDENT of the root's.
    assert.notStrictEqual(lmap.s1, root.s1, 'layer s1 gets its own fresh id');
    const layer = rk.layers.enrich;
    assert.strictEqual(layer.trigger.id, lmap.trg);
    const lOut = layer.steps.find(s => s.type === 'layer_output');
    assert.strictEqual(lOut.id, lmap.out);
    // A layer step binding referencing a same-layer id follows THAT layer's
    // map — not the root's.
    assert.strictEqual(lOut.fields.company.path, `steps.${lmap.s1}.output.company`);
    assert.strictEqual(lOut.fields.viaTpl.value, `company={{steps.${lmap.s1}.output.company}}`);
    // Layer edges follow the layer map.
    assert.deepStrictEqual(layer.edges, [{ from: lmap.trg, to: lmap.s1 }, { from: lmap.s1, to: lmap.out }]);
    // trigger.output refs + ai_step prompts are untouched.
    const lAi = layer.steps.find(s => s.type === 'ai_step');
    assert.strictEqual(lAi.inputs.email.path, 'trigger.output.email');
    assert.strictEqual(lAi.prompt, 'Enrich {{email}} please');

    // The re-keyed document (WITH inline layers) still validates.
    const v = validateDefinition(rk);
    assert.strictEqual(v.ok, true, `re-keyed definition must validate: ${JSON.stringify(v.errors)}`);
}

// ── 5. Full round trip: export → sanitize → rekey → validate ────────────
{
    const { envelope } = buildExport(makeRow());
    const { automation, errors } = sanitizeImport(JSON.parse(JSON.stringify(envelope)));
    assert.deepStrictEqual(errors, []);
    const { definition } = rekeyDefinition(automation.definition);
    const v = validateDefinition(definition);
    assert.strictEqual(v.ok, true, `round-tripped definition validates: ${JSON.stringify(v.errors)}`);
    assert.ok(!JSON.stringify(definition).includes('pinnedOutput'));
    // Importing the same file twice yields different ids each time.
    const again = rekeyDefinition(automation.definition);
    assert.notStrictEqual(again.definition.trigger.id, definition.trigger.id);
}

// ── 6. Degenerate inputs don't throw ─────────────────────────────────────
{
    assert.deepStrictEqual(rekeyDefinition(null).renameMap, { root: {}, layers: {} });
    assert.deepStrictEqual(rekeyDefinition({}).renameMap, { root: {}, layers: {} });
    const weird = rekeyDefinition({ trigger: { id: 't' }, steps: [null, 'x', { id: 's_a', type: 'set' }], edges: [null, { from: 't', to: 's_a' }], layers: { bad: 'not-an-object' } });
    assert.ok(weird.renameMap.root.t && weird.renameMap.root.s_a);
    assert.strictEqual(weird.definition.edges[1].from, weird.renameMap.root.t);
    const { envelope } = buildExport({});
    assert.strictEqual(envelope.automation.title, '');
    assert.deepStrictEqual(envelope.automation.definition, {});
}

// ── form pages: the templated text is NESTED and needs its own rule ─────
//
// A form page's visitor-facing strings live under `form` as bare strings, so
// neither TEMPLATE_STRING_FIELDS (top-level keys only) nor the binding-wrapper
// deep walk reaches them. Without an explicit rule an imported or duplicated
// automation renders {{steps.<oldId>…}} as blank — silently, on the visitor's
// screen. Its own graph because a form page requires a form trigger.
{
    const def = {
        trigger: {
            id: 'trg', type: 'trigger', kind: 'form',
            form: { title: 'Start', fields: [{ name: 'name', type: 'text', label: 'Name' }] },
        },
        steps: [
            { id: 's1', type: 'set', fields: { count: { kind: 'literal', value: 3 } } },
            {
                id: 'fp1', type: 'form_page', mode: 'ending',
                form: {
                    title: 'Done, {{steps.s1.output.name}}',
                    description: 'We found {{ steps.s1.output.count }} items.',
                    submitLabel: 'Close {{steps.s1.output.name}}',
                    successMessage: 'Bye {{steps.s1.output.name}}',
                    fields: [{
                        name: 'note', type: 'text',
                        label: 'Note for {{steps.s1.output.name}}',
                        placeholder: 'about {{steps.s1.output.count}}',
                        help: 'h {{steps.s1.output.count}}',
                    }],
                },
            },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'fp1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'fixture validates before rekey');

    const { definition, renameMap } = rekeyDefinition(def);
    const map = renameMap.root;
    const page = definition.steps.find(s => s.id === map.fp1);
    assert.strictEqual(page.form.title, `Done, {{steps.${map.s1}.output.name}}`);
    assert.strictEqual(page.form.description, `We found {{ steps.${map.s1}.output.count }} items.`);
    assert.strictEqual(page.form.submitLabel, `Close {{steps.${map.s1}.output.name}}`);
    assert.strictEqual(page.form.successMessage, `Bye {{steps.${map.s1}.output.name}}`);
    assert.strictEqual(page.form.fields[0].label, `Note for {{steps.${map.s1}.output.name}}`);
    assert.strictEqual(page.form.fields[0].placeholder, `about {{steps.${map.s1}.output.count}}`);
    assert.strictEqual(page.form.fields[0].help, `h {{steps.${map.s1}.output.count}}`);
    // The binding NAME is not a ref and must never be rewritten — it is what
    // downstream steps.<id>.output.<name> points at.
    assert.strictEqual(page.form.fields[0].name, 'note');
    assert.strictEqual(validateDefinition(definition).ok, true, 'still valid after rekey');
}

// ── Environment-specific references ──────────────────────────────────────
//
// A definition can carry ids that only mean something on the install that made
// them. A saved HTTP credential is the sharp one: the id names a row in
// `integration_connections`, so on another install it is either absent or —
// worse — somebody else's credential.
{
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'h1', type: 'http_request', url: 'https://api.example.com', auth: { connectionId: 'conn-abc' } },
            { id: 'cb1', type: 'call_block', blockId: 'block-xyz', inputs: {} },
        ],
        edges: [{ from: 'trg', to: 'h1' }, { from: 'h1', to: 'cb1' }],
    };
    const { envelope, warnings } = buildExport({ title: 'T', definition });
    const steps = envelope.automation.definition.steps;

    assert.strictEqual(steps[0].auth, null, 'the saved credential must not travel');
    assert.ok(
        warnings.some(w => /credential/i.test(w) && w.includes('h1')),
        'clearing the credential must be reported, not silent',
    );
    // A reusable Step lives outside this document, so its id cannot be
    // rewritten. Say so rather than dropping the call or shipping it mutely.
    assert.strictEqual(steps[1].blockId, 'block-xyz');
    assert.ok(
        warnings.some(w => w.includes('block-xyz')),
        'a call to a Step that is not in the file must be named in the warnings',
    );
    // And it must say what the EXPORTER can do about it. "Whoever imports it
    // needs that Step first" is true and useless: the person reading this is
    // the one who can export the Step too, and nothing told them that.
    assert.ok(
        warnings.some(w => w.includes('block-xyz') && /export that step as well/i.test(w)),
        'the warning must tell the exporter to export the Step too',
    );

    // The source is never mutated — the caller still holds a live automation.
    assert.deepStrictEqual(definition.steps[0].auth, { connectionId: 'conn-abc' });
}

// Two row ids in one sentence is a warning nobody can act on without first
// looking up which Step "block-xyz" is. The builder auto-names a call_block
// step from the Step's own title, so the label is usually that name.
{
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cb1', type: 'call_block', label: 'Send welcome pack', blockId: 'block-xyz', inputs: {} }],
        edges: [{ from: 'trg', to: 'cb1' }],
    };
    const { warnings } = buildExport({ title: 'T', definition });
    const hit = warnings.find(w => w.includes('block-xyz'));
    assert.ok(hit, 'expected a call_block warning');
    assert.ok(hit.includes('Send welcome pack'), `the Step's name must be in the sentence: ${hit}`);
    // The id stays too — it is what the recipient's import error quotes back.
    assert.ok(hit.includes('block-xyz'));
}

// A call_block with no label falls back to the id rather than printing an
// empty pair of quotes.
{
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cb1', type: 'call_block', blockId: 'block-xyz', inputs: {} }],
        edges: [{ from: 'trg', to: 'cb1' }],
    };
    const { warnings } = buildExport({ title: 'T', definition });
    const hit = warnings.find(w => w.includes('block-xyz'));
    assert.ok(hit && !hit.includes('""'), `empty quotes in: ${hit}`);
}

// The same scrub inside an inline flowlet, which is where it is easiest to miss.
{
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: {
            enrich: {
                trigger: { id: 'lt', type: 'trigger', kind: 'layer_input', params: [] },
                steps: [{ id: 'h9', type: 'http_request', url: 'https://x.test', auth: { connectionId: 'conn-inner' } }],
                edges: [{ from: 'lt', to: 'h9' }],
            },
        },
    };
    const { envelope, warnings } = buildExport({ title: 'T', definition });
    assert.strictEqual(envelope.automation.definition.layers.enrich.steps[0].auth, null);
    assert.ok(warnings.some(w => w.includes('enrich')), 'the warning should say which flowlet');
}

// A step with no credential is left completely alone (no spurious warning).
{
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com' }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const { envelope, warnings } = buildExport({ title: 'T', definition });
    assert.ok(!('auth' in envelope.automation.definition.steps[0]) || envelope.automation.definition.steps[0].auth === undefined);
    assert.strictEqual(warnings.length, 0, 'nothing to warn about: ' + warnings.join(' | '));
}

// An ai_step's knowledgeBaseIds identify a knowledge base in ONE
// organisation (BFSF-410) — same story as a saved credential: cleared on
// export, and reported so the exporter knows to reconfigure grounding.
{
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'ai1', type: 'ai_step', prompt: 'Draft a reply in our brand voice.', knowledgeBaseIds: ['kb-style-guide'] }],
        edges: [{ from: 'trg', to: 'ai1' }],
    };
    const { envelope, warnings } = buildExport({ title: 'T', definition });
    const step = envelope.automation.definition.steps[0];

    assert.deepStrictEqual(step.knowledgeBaseIds, [], 'the organisation-scoped KB id must not travel');
    assert.ok(
        warnings.some(w => /knowledge base/i.test(w) && w.includes('ai1')),
        'clearing the knowledge base reference must be reported, not silent: ' + warnings.join(' | '),
    );
    // The source is never mutated — the caller still holds a live automation.
    assert.deepStrictEqual(definition.steps[0].knowledgeBaseIds, ['kb-style-guide']);
}

// An ai_step with no knowledgeBaseIds is left alone (no spurious warning).
{
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'ai1', type: 'ai_step', prompt: 'p', knowledgeBaseIds: [] }],
        edges: [{ from: 'trg', to: 'ai1' }],
    };
    const { warnings } = buildExport({ title: 'T', definition });
    assert.strictEqual(warnings.length, 0, 'nothing to warn about: ' + warnings.join(' | '));
}

// ── Version ladder ───────────────────────────────────────────────────────
//
// Established before it is needed: the moment EXPORT_SCHEMA_VERSION is bumped,
// a strict equality check would start rejecting every file yesterday's build
// wrote, including the user's own backups.
{
    const { EXPORT_SUPPORTED_VERSIONS } = require('./portability');
    assert.ok(Array.isArray(EXPORT_SUPPORTED_VERSIONS));
    assert.ok(
        EXPORT_SUPPORTED_VERSIONS.includes(EXPORT_SCHEMA_VERSION),
        'the version we WRITE must be one we can read back',
    );

    const good = {
        format: EXPORT_FORMAT,
        schemaVersion: EXPORT_SUPPORTED_VERSIONS[0],
        automation: { title: 'T', definition: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] } },
    };
    assert.deepStrictEqual(sanitizeImport(good).errors, [], 'the oldest supported version must still import');

    const future = { ...good, schemaVersion: EXPORT_SCHEMA_VERSION + 1 };
    const res = sanitizeImport(future);
    assert.strictEqual(res.automation, null);
    assert.ok(/newer than this server supports/.test(res.errors[0]), res.errors[0]);
}

// ── note (BFSF-411) — a canvas annotation rides through export/import as
// plain, unspecial data: `walkAllSteps` visits it (nothing in this module
// keys off `step.type === 'note'`, so it is a no-op pass-through), export
// carries its free text verbatim (no scrub rule strips or interprets it),
// and rekeyDefinition renames its id + rewrites downstream refs to it the
// same as any other step. ─────────────────────────────────────────────────
{
    const { walkAllSteps } = require('./portability');
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'n1', type: 'notification', title: 'hi', body: '{{steps.note_1.output.x}}' },
            // A note referencing "steps.note_1" in its OWN text is exactly
            // the trap a special-cased walker would fall into — this proves
            // the text is carried as plain data, never parsed for refs.
            { id: 'note_1', type: 'note', text: 'see steps.note_1 for context — not a real binding', position: { x: 10, y: 20 }, size: { width: 200, height: 120 }, color: 'blue' },
        ],
        edges: [{ from: 'trg', to: 'n1' }],
    };

    // walkAllSteps visits it like any other node.
    const seen = [];
    walkAllSteps(definition, (node) => seen.push(node.id));
    assert.ok(seen.includes('note_1'), 'walkAllSteps visits the note');

    // Export carries the note through untouched — no PIN_FIELDS on it, no
    // scrub rule matches type 'note', so nothing is stripped or warned about.
    const { envelope, warnings } = buildExport({ title: 'T', definition });
    const exportedNote = envelope.automation.definition.steps.find(s => s.type === 'note');
    assert.deepStrictEqual(exportedNote, definition.steps[1], 'the note is exported byte-identical');
    assert.strictEqual(warnings.length, 0, 'nothing about the note is warned about: ' + warnings.join(' | '));

    // rekeyDefinition renames the note's OWN id (so a second import of the
    // same file, or a duplicated automation, never collides on it) and rewrites
    // the real step's template that referenced it — while the note's own
    // free TEXT, which merely CONTAINS the substring "steps.note_1", is left
    // completely alone: it is prose, not a binding.
    const { definition: rk, renameMap } = rekeyDefinition(definition);
    const newNoteId = renameMap.root.note_1;
    assert.ok(newNoteId && newNoteId !== 'note_1', 'the note got a fresh id like every other step');
    const rkNote = rk.steps.find(s => s.type === 'note');
    assert.strictEqual(rkNote.id, newNoteId);
    assert.strictEqual(rkNote.text, definition.steps[1].text, 'the note\'s own text is untouched — plain data, not a binding source');
    assert.deepStrictEqual(rkNote.position, { x: 10, y: 20 });
    assert.deepStrictEqual(rkNote.size, { width: 200, height: 120 });
    assert.strictEqual(rkNote.color, 'blue');
    const rkNotif = rk.steps.find(s => s.type === 'notification');
    assert.strictEqual(rkNotif.body, `{{steps.${newNoteId}.output.x}}`, 'a REAL reference TO the note is still rewritten (even though the note itself never produces output)');
}

console.log('✓ server/automation/portability.test.js — all assertions passed');
