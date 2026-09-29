/**
 * Unit tests for the builder round-trip/token optimizations:
 *   - builder_add_steps (batch append with $tempId cross-references)
 *   - builder_inspect_tool batch form ({tools:[…]})
 *   - inspect gate: schema-inlined rejection + mark-inspected semantics
 *   - model-facing payload helpers (compactSample, truncateToolResultJson,
 *     compactDryRunForModel, _stepIds vs _draftSteps echo policy)
 *
 * Run: node --test automation/builderTools.addSteps.test.js
 *
 * No DB needed — everything here mutates the in-memory draft only.
 */

const assert = require('assert');
const {
    applyToolCall, emptyDefinition, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, TOOL_SCHEMAS,
    compactSample, compactDryRunForModel, truncateToolResultJson,
} = require('./builderTools');
const { CORE_TOOL_NAMES } = require('./builderModelProfiles');
const { validateDefinition } = require('./validate');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}

function gatedWrap() {
    return {
        userId: 'u_test',
        def: emptyDefinition(),
        _inputSchemasByTool: {
            gmail_search: { type: 'object', properties: { query: { type: 'string', description: 'search query' }, maxResults: { type: 'number' } }, required: ['query'] },
            gmail_compose: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
        },
        _inspectedTools: new Set(),
    };
}

(async () => {
    // ═══ builder_add_steps: happy path with tempId cross-references ═══
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'search', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'is:unread' } } } },
                { tempId: 'flt', type: 'filter', spec: { arrayRef: 'steps.$search.output.results', expr: 'item.subject.length > 0' } },
                {
                    tempId: 'read', type: 'integration_action',
                    spec: {
                        tool: 'gmail_read',
                        forEach: { overRef: 'steps.$flt.output.results', itemVar: 'email' },
                        inputs: { messageId: { kind: 'ref', path: 'loop.email.id' } },
                    },
                },
                {
                    tempId: 'sum', type: 'ai_step',
                    spec: {
                        prompt: 'Summarise: {{steps.$read.output.results}}',
                        outputSchema: { digest: 'string' },
                        inputs: { extra: { kind: 'ref', path: 'steps.$search.output.results' } },
                    },
                },
            ],
        }, dw);
        assert.ok(!r.error, `batch add must not error: ${r.error}`);
        assert.strictEqual(r.added.length, 4, 'all four entries added');
        assert.deepStrictEqual(Object.keys(r.idMap).sort(), ['flt', 'read', 'search', 'sum'], 'idMap covers every tempId');

        const byId = Object.fromEntries(dw.def.steps.map(s => [s.id, s]));
        const searchId = r.idMap.search;
        const fltId = r.idMap.flt;
        const readId = r.idMap.read;
        const sumId = r.idMap.sum;
        // $tempId rewritten in arrayRef, forEach.overRef, template, ref path.
        assert.strictEqual(byId[fltId].arrayRef, `steps.${searchId}.output.results`, 'arrayRef rewritten');
        assert.strictEqual(byId[readId].forEach.overRef, `steps.${fltId}.output.results`, 'forEach.overRef rewritten');
        assert.ok(byId[sumId].prompt.includes(`steps.${readId}.output.results`), 'template body rewritten');
        assert.strictEqual(byId[sumId].inputs.extra.path, `steps.${searchId}.output.results`, 'ref path rewritten');
        // Default chaining: trg > search > flt > read > sum.
        const chain = [['trg', searchId], [searchId, fltId], [fltId, readId], [readId, sumId]];
        for (const [from, to] of chain) {
            assert.ok(dw.def.edges.some(e => e.from === from && e.to === to), `edge ${from}→${to} wired`);
        }
        // Full structured echo exactly once (batch is a TOPOLOGY tool).
        assert.ok(Array.isArray(r._draftSteps), 'batch result carries _draftSteps');
        assert.ok(!r._stepIds, 'no duplicate compact echo');
        const v = validateDefinition(dw.def);
        assert.deepStrictEqual(v.errors, [], `batch-built draft validates: ${JSON.stringify(v.errors)}`);
    }

    // ═══ builder_add_steps: forward/unknown $ref → indexed error, prefix kept ═══
    // Entries apply in order and the built prefix STAYS (since 2026-09-13;
    // before that the whole batch rolled back and the model resent it whole —
    // which is how a fixed batch built its first entry twice).
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
                { type: 'filter', spec: { arrayRef: 'steps.$later.output.results', expr: 'item.x' } }, // unknown tempId
            ],
        }, dw);
        assert.ok(r.error && r.error.includes('steps[1]') && r.error.includes('$later'), `error names index + handle: ${r.error}`);
        assert.strictEqual(r.failedIndex, 1);
        assert.strictEqual(r.resendFrom, 1);
        assert.strictEqual(r.added.length, 1, 'entry 0 stays built');
        assert.strictEqual(r.lastAppliedId, r.added[0].id);
        assert.deepStrictEqual(dw.def.steps.map(s => s.id), [r.added[0].id], 'only entry 0 is in the draft');
        assert.deepStrictEqual(dw.def.edges.map(e => [e.from, e.to]), [['trg', r.added[0].id]], 'and it is wired');
        assert.strictEqual(r._rolledBack, undefined, 'no batch-wide rollback any more');
    }

    // ═══ builder_add_steps: tempId collisions rejected pre-mutation ═══
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const dup = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'x', type: 'datetime', spec: { op: 'now' } },
                { tempId: 'x', type: 'wait', spec: { seconds: 5 } },
            ],
        }, dw);
        assert.ok(dup.error && /duplicate tempId/.test(dup.error), 'duplicate tempId rejected');
        assert.strictEqual(dw.def.steps.length, 0, 'nothing added on pre-validation reject');

        const bad = await applyToolCall('builder_add_steps', {
            steps: [{ tempId: '1bad', type: 'datetime', spec: { op: 'now' } }],
        }, dw);
        assert.ok(bad.error && /tempId/.test(bad.error), 'bad tempId grammar rejected');

        const trg = await applyToolCall('builder_add_steps', {
            steps: [{ tempId: 'trg', type: 'datetime', spec: { op: 'now' } }],
        }, dw);
        assert.ok(trg.error && /collides/.test(trg.error), 'tempId "trg" collision rejected');
    }

    // ═══ builder_add_steps: condition entry + $ wiring on branches ═══
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'c', type: 'condition', spec: { expr: 'trigger.output.x == 1' } },
                { tempId: 't', type: 'notification', spec: { title: 'yes', afterStepId: '$c', branch: 'then' } },
                { tempId: 'e', type: 'notification', spec: { title: 'no', afterStepId: '$c', branch: 'else' } },
            ],
        }, dw);
        assert.ok(!r.error, `condition batch must not error: ${r.error}`);
        const condId = r.idMap.c;
        const outs = dw.def.edges.filter(e => e.from === condId);
        assert.ok(outs.some(e => e.to === r.idMap.t && e.label === 'then'), 'then branch wired via $tempId');
        assert.ok(outs.some(e => e.to === r.idMap.e && e.label === 'else'), 'else branch wired via $tempId');
    }

    // ═══ builder_add_steps: scoped into a flowlet keeps layer_output terminal ═══
    {
        const dw = freshWrap();
        const created = await applyToolCall('builder_create_layer', { title: 'Enrich', params: [{ name: 'email', type: 'string' }] }, dw);
        const key = created.layerKey;
        const r = await applyToolCall('builder_add_steps', {
            scope: key,
            steps: [
                { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
                { tempId: 'b', type: 'set', spec: { fields: { when: { kind: 'ref', path: 'steps.$a.output.iso' } } } },
            ],
        }, dw);
        assert.ok(!r.error, `scoped batch must not error: ${r.error}`);
        const layer = dw.def.layers[key];
        assert.ok(layer.steps.some(s => s.id === r.idMap.a), 'scoped step landed in the flowlet');
        assert.ok(!dw.def.steps.some(s => s.id === r.idMap.a), 'scoped step NOT in root');
        // layer_output terminality is an EDGE property: the batch steps chain
        // trg → a → b → out, with the out-feed re-pointed to the LAST entry.
        const out = layer.steps.find(s => s.type === 'layer_output');
        assert.ok(layer.edges.some(e => e.from === r.idMap.b && e.to === out.id), 'last batch step feeds layer_output');
        assert.ok(layer.edges.some(e => e.from === r.idMap.a && e.to === r.idMap.b), 'batch entries chain a → b');
        assert.ok(!layer.edges.some(e => e.from === out.id), 'nothing follows layer_output');
    }

    // ═══ builder_add_steps: step fields beside spec are hoisted INTO spec ═══
    // Was a rejection. The fast local model answered "source is required" by
    // putting `source` next to spec and resent that shape three rounds
    // running — the repair lands the step and the warning corrects the habit.
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_add_steps', {
            steps: [{ tempId: 'a', type: 'integration_action', tool: 'gmail_search', inputs: {} }],
        }, dw);
        assert.ok(!r.error, `no spec at all → built from the stray fields: ${r.error}`);
        assert.strictEqual(r.added[0].tool, 'gmail_search');
        assert.ok(r._warnings && r._warnings.some(w => /"tool", "inputs" were placed next to spec/.test(w) && /INSIDE spec/.test(w)), `hoist warning: ${JSON.stringify(r._warnings)}`);
    }
    {
        // The trace shape: data_extraction with `source` beside spec, `fields`
        // both beside and inside (spec's copy wins).
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: {} }, dw);
        const read = dw.def.steps[0].id;
        const r = await applyToolCall('builder_add_steps', {
            steps: [{
                tempId: 'ex', type: 'data_extraction',
                source: { kind: 'ref', path: `steps.${read}.output.content` },
                fields: [{ name: 'wrong', type: 'string' }],
                spec: { fields: [{ name: 'vendor', type: 'string', description: 'Supplier' }], label: 'Extract invoice data' },
            }],
        }, dw);
        assert.ok(!r.error, `source beside spec is hoisted: ${r.error}`);
        const ex = dw.def.steps.find(s => s.type === 'data_extraction');
        assert.deepStrictEqual(ex.source, { kind: 'ref', path: `steps.${read}.output.content` });
        assert.strictEqual(ex.fields[0].name, 'vendor', "spec's own fields win over the stray copy");
        assert.ok(r._warnings.some(w => /"source" was placed next to spec — moved inside it; "fields" appeared both/.test(w)), JSON.stringify(r._warnings));
    }
    {
        // The 2026-09-12 trace, verbatim in shape: a data_extraction entry
        // whose source + fields sit under `inputs` (integration_action
        // vocabulary) with an ai_step `prompt` beside them, inside a forEach
        // over a $handle. "source is required" was true and useless — the
        // binding was there, one level too deep — and the model resent the
        // identical batch three times. It must apply on the first call.
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'list_files', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices-Test' } }, label: 'Lijst bestanden' } },
                { tempId: 'read_pdf', type: 'integration_action', spec: { tool: 'nextcloud_read_file', inputs: { path: { kind: 'ref', path: 'loop.file.path' } }, forEach: { itemVar: 'file', overRef: 'steps.$list_files.output.items' }, label: 'Lees PDF' } },
                {
                    tempId: 'extract_data', type: 'data_extraction',
                    spec: {
                        forEach: { itemVar: 'res', overRef: 'steps.$read_pdf.output.results' },
                        inputs: {
                            source: { kind: 'ref', path: 'loop.res.output.content' },
                            fields: [
                                { name: 'datum', type: 'string', description: 'YYYY-MM-DD' },
                                { name: 'totaal', type: 'number', description: 'Total amount' },
                            ],
                        },
                        label: 'Extraheer data uit PDF',
                        prompt: 'Extract fields from this invoice text. Ensure amounts are numbers and date is YYYY-MM-DD.',
                    },
                },
            ],
        }, dw);
        assert.ok(!r.error, `source/fields under inputs are unwrapped, not refused: ${r.error}`);
        const ex = dw.def.steps.find(s => s.type === 'data_extraction');
        assert.ok(ex, 'the extraction step was added');
        assert.deepStrictEqual(ex.source, { kind: 'ref', path: 'loop.res.output.content' });
        assert.deepStrictEqual(ex.fields.map(f => f.name), ['datum', 'totaal']);
        assert.strictEqual(ex.instructions, 'Extract fields from this invoice text. Ensure amounts are numbers and date is YYYY-MM-DD.', 'prompt became the instructions hint');
        assert.ok(!('inputs' in ex) && !('prompt' in ex), 'neither foreign key reaches the step');
        assert.strictEqual(ex.forEach.itemVar, 'res');
        assert.ok(r._warnings.some(w => /"source", "fields" were sent under inputs — a data_extraction step has no inputs map/.test(w)), JSON.stringify(r._warnings));
    }
    {
        // A missing type is read off an unambiguous spec (tool → action);
        // a known alias resolves; `prompt` alone stays ambiguous → error that
        // names the missing key, not "unknown type undefined".
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'a', spec: { tool: 'gmail_search', inputs: {} } },
                { tempId: 'b', type: 'action', spec: { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'x' } } } },
            ],
        }, dw);
        assert.ok(!r.error, `inferred + aliased types: ${r.error}`);
        assert.strictEqual(r.added[0].type, 'integration_action');
        assert.strictEqual(r.added[1].type, 'integration_action');
        assert.ok(r._warnings.some(w => /steps\[0\]: had no type — read as "integration_action"/.test(w)), JSON.stringify(r._warnings));
        assert.ok(r._warnings.some(w => /steps\[1\]: type "action" read as "integration_action"/.test(w)), JSON.stringify(r._warnings));
        const r2 = await applyToolCall('builder_add_steps', {
            steps: [{ tempId: 'c', spec: { prompt: 'Summarise', outputSchema: { text: { type: 'string' } } } }],
        }, dw);
        assert.ok(r2.error && /steps\[0\]: has no "type"\. Every entry is \{tempId\?, type, spec\}/.test(r2.error), r2.error);
        assert.ok(!/corrupted/.test(r2.error), 'a clean entry is not called corrupted');
        assert.ok(!/undefined/.test(r2.error), 'never "unknown type undefined" again');
    }
    {
        // The corrupted-JSON signature from a real trace: a field type of
        // "string}}},systemPrompt:" swallowed the rest of the entry.
        const dw = freshWrap();
        const r = await applyToolCall('builder_add_steps', {
            steps: [{ spec: { prompt: 'Extract', outputSchema: { vendor: { type: 'string}}},systemPrompt:' } } } }],
        }, dw);
        assert.ok(r.error && /has no "type"/.test(r.error) && /batch JSON arrived corrupted/.test(r.error), r.error);
        assert.ok(r._fixHint && /corrupted batch JSON/.test(r._fixHint), r._fixHint);
        assert.strictEqual(dw.def.steps.length, 0, 'nothing applied');
    }

    // ═══ gate inside batch: prefix kept + inlined schema + one-round retry ═══
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
                { tempId: 's', type: 'integration_action', spec: { tool: 'gmail_search', inputs: {} } }, // required `query` unbound, not inspected
            ],
        }, dw);
        assert.ok(r.error && r.failedIndex === 1 && r.added.length === 1, 'gated entry fails; entry 0 stays');
        assert.strictEqual(r._needsInspect, 'gmail_search');
        assert.ok(r.toolSchema && r.toolSchema.inputs.query.required === true, 'rejection inlines the schema');
        assert.strictEqual(dw.def.steps.length, 1, 'the entry before the gate is in the draft');
        assert.ok(dw._inspectedTools.has('gmail_search'), 'rejection marks the tool inspected');
        // A whole-batch retry now passes the gate (schema was shown) — and
        // the entry that was already built is reported back, not built twice.
        const retry = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
                { tempId: 's', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'is:unread' } } } },
            ],
        }, dw);
        assert.ok(!retry.error, `retry after schema-inlined reject succeeds: ${retry.error}`);
        assert.strictEqual(retry.added[0].reused, true);
        assert.strictEqual(retry.added[0].id, r.added[0].id);
        assert.strictEqual(dw.def.steps.length, 2, 'one datetime, one search');
    }

    // ═══ standalone gate: escape hatch marks inspected; unknown-param warning ═══
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        // Escape hatch: all required bound → allowed AND marked.
        const ok = await applyToolCall('builder_add_action', {
            tool: 'gmail_compose',
            inputs: { to: { kind: 'literal', value: 'a@b.c' }, body: { kind: 'literal', value: 'hi' } },
        }, dw);
        assert.ok(!ok.error, `escape hatch allows: ${ok.error}`);
        assert.ok(dw._inspectedTools.has('gmail_compose'), 'escape hatch marks tool inspected');
        // Hallucinated param → warning, not reject.
        const warn = await applyToolCall('builder_add_action', {
            tool: 'gmail_compose',
            afterStepId: ok.added.id,
            inputs: { to: { kind: 'literal', value: 'a@b.c' }, body: { kind: 'literal', value: 'x' }, priority: { kind: 'literal', value: 'high' } },
        }, dw);
        assert.ok(!warn.error, 'unknown param does not reject');
        assert.ok(Array.isArray(warn._warnings) && warn._warnings[0].includes('priority'), 'unknown param surfaces a warning');
    }

    // ═══ a required input left unbound is refused at ADD time, gate or no gate ═══
    // The builder's validator is not handed the tool schemas, so a read step
    // without its `path` used to finalise clean and fail live with "path is
    // required". Once the tool is inspected the §B3 gate is silent; this check
    // is the one that stays.
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        await applyToolCall('builder_inspect_tool', { tools: ['gmail_search', 'gmail_compose'] }, dw);
        const bare = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: {} }, dw);
        assert.ok(bare.error && /gmail_search: required input "query" is not bound — the step would fail at run time/.test(bare.error), bare.error);
        assert.match(bare.error, /Bind it to an upstream field/);
        assert.match(bare._fixHint, /^Reject reason: a required input is missing/);
        const empty = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: '' } } }, dw);
        assert.ok(empty.error && /"query" is not bound/.test(empty.error), 'an empty literal is as good as absent');
        // Inside a forEach the hint points at the item.
        const list = await applyToolCall('builder_add_datetime', { op: 'now' }, dw);
        const looped = await applyToolCall('builder_add_action', {
            tool: 'gmail_search', forEach: { overRef: `steps.${list.added.id}.output.results`, itemVar: 'f' },
        }, dw);
        assert.ok(looped.error && /loop\.f\.query/.test(looped.error), `forEach hint names the item: ${looped.error}`);
        // Several missing → plural, all named.
        const two = await applyToolCall('builder_add_action', { tool: 'gmail_compose', inputs: { subject: { kind: 'literal', value: 'x' } } }, dw);
        assert.ok(two.error && /required inputs "to", "body" are not bound/.test(two.error), two.error);
        // Bound → lands. In a batch the refusal names the entry; the entry
        // before it stays built.
        const ok = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'is:unread' } } }, dw);
        assert.ok(!ok.error, ok.error);
        const before = dw.def.steps.length;
        const batch = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
                { tempId: 'r', type: 'integration_action', spec: { tool: 'gmail_search', forEach: { overRef: 'steps.$a.output.results', itemVar: 'f' } } },
            ],
        }, dw);
        assert.ok(batch.error && batch.failedIndex === 1 && batch.added.length === 1, `batch entry refused: ${batch.error}`);
        assert.match(batch.error, /steps\[1\] \(\$r\): gmail_search: required input "query" is not bound/);
        assert.strictEqual(dw.def.steps.length, before + 1, 'entry 0 stays, entry 1 was never added');
        // No schema map attached (MCP surface) → no opinion, as before.
        const dwNoSchema = freshWrap();
        const legacy = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: {} }, dwNoSchema);
        assert.ok(!legacy.error, 'without a schema map nothing is required');
    }

    // ═══ A2 — a required input the draft can answer for is BOUND, not refused ═══
    // Measured 2026-09-12/13: the fast local model sent a forEach'd
    // nextcloud_read_file with no inputs, was told to bind `path` from the
    // item, and resent the byte-identical batch. The item's shape is known
    // (outputSchemas) and carries `path`, so the server writes the binding
    // and says so; what it will not write comes back as a named candidate.
    function ncWrap() {
        const dw = gatedWrap();
        const str = { type: 'string' };
        Object.assign(dw._inputSchemasByTool, {
            nextcloud_list_files: { type: 'object', properties: { path: str }, required: ['path'] },
            nextcloud_read_file: { type: 'object', properties: { path: str }, required: ['path'] },
            nextcloud_delete: { type: 'object', properties: { path: str }, required: ['path'] },
            nextcloud_list_versions: { type: 'object', properties: { fileId: str }, required: ['fileId'] },
            gmail_read: { type: 'object', properties: { messageId: str }, required: ['messageId'] },
        });
        for (const t of Object.keys(dw._inputSchemasByTool)) dw._inspectedTools.add(t);
        return dw;
    }
    {
        // (11) The measured batch, verbatim.
        const dw = ncWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'list_files', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices-Test' } }, label: 'Scan map /Invoices-Test' } },
                { tempId: 'read_file', type: 'integration_action', spec: { tool: 'nextcloud_read_file', forEach: { itemVar: 'f', overRef: 'steps.$list_files.output.items' }, label: 'Lees PDF per bestand' } },
            ],
        }, dw);
        assert.ok(!r.error, `the measured batch applies: ${r.error || ''}`);
        const read = dw.def.steps.find(s => s.tool === 'nextcloud_read_file');
        assert.deepStrictEqual(read.inputs, { path: { kind: 'ref', path: 'loop.f.path' } }, 'path bound from the listing entry');
        assert.ok(r._warnings.some(w => /^steps\[1\] \(\$read_file\): input "path" was not bound — bound to loop\.f\.path \(the forEach item from steps\.a_[0-9a-f]+\.output\.items has: name, path, type, size, contentType, modified, fileId\)\. Write the binding yourself next time: path:\{kind:"ref", path:"loop\.f\.path"\}\.$/.test(w)), JSON.stringify(r._warnings));
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => /param_missing/.test(e.code)), JSON.stringify(v.errors));

        // (12) The single tool after the list step exists, real id in overRef.
        const listId = r.idMap.list_files;
        const one = await applyToolCall('builder_add_action', { tool: 'nextcloud_read_file', forEach: { overRef: `steps.${listId}.output.items`, itemVar: 'x' } }, dw);
        assert.ok(!one.error, one.error);
        assert.deepStrictEqual(one.added.inputs.path, { kind: 'ref', path: 'loop.x.path' });
        assert.ok(one._warnings.some(w => /^input "path" was not bound — bound to loop\.x\.path/.test(w)), JSON.stringify(one._warnings));
        // The duplicate check sees the POST-bind inputs: the same read again,
        // same var, is the same call.
        const again = await applyToolCall('builder_add_action', { tool: 'nextcloud_read_file', forEach: { overRef: `steps.${listId}.output.items`, itemVar: 'f' } }, dw);
        assert.ok(again.error && /identical inputs/.test(again.error), again.error);

        // (13) A side-effect action is never bound for — the candidate is named.
        const before = dw.def.steps.length;
        const del = await applyToolCall('builder_add_steps', {
            steps: [{ tempId: 'rm', type: 'integration_action', spec: { tool: 'nextcloud_delete', forEach: { overRef: `steps.${listId}.output.items`, itemVar: 'f' } } }],
        }, dw);
        assert.ok(del.error && del.failedIndex === 0 && del.added.length === 0, del.error);
        assert.match(del.error, /nextcloud_delete: required input "path" is not bound\. The forEach item \(an entry of steps\.a_[0-9a-f]+\.output\.items from nextcloud_list_files\) has a field "path" — if that is the file to act on, bind it explicitly: path:\{kind:"ref", path:"loop\.f\.path"\}\. It is not filled in for you because this action changes data\./);
        assert.match(del._fixHint, /^Reject reason: a required input is missing on a side-effect action/);
        assert.strictEqual(dw.def.steps.length, before, 'nothing added');

        // (14) A known item that lacks the name says what it has.
        const q = await applyToolCall('builder_add_action', { tool: 'gmail_search', forEach: { overRef: `steps.${listId}.output.items`, itemVar: 'f' } }, dw);
        assert.match(q.error, /^gmail_search: required input "query" is not bound, and the forEach item \(an entry of steps\.a_[0-9a-f]+\.output\.items from nextcloud_list_files\) has: name, path, type, size, contentType, modified, fileId — none of those is called "query"\./);
        assert.match(q.error, /query:\{kind:"ref", path:"loop\.f\.<field>"\}/);
        assert.match(q._fixHint, /^Reject reason: a required input is missing and the loop item has no field/);

        // (15) An unknown item shape keeps the plain wording and hint.
        const dt = await applyToolCall('builder_add_datetime', { op: 'now' }, dw);
        const unknown = await applyToolCall('builder_add_action', { tool: 'gmail_search', forEach: { overRef: `steps.${dt.added.id}.output.results`, itemVar: 'f' } }, dw);
        assert.strictEqual(unknown.error, 'gmail_search: required input "query" is not bound — the step would fail at run time. Inside this forEach bind it from the item, e.g. query: {kind:"ref", path:"loop.f.query"}.');
        assert.strictEqual(unknown._fixHint, 'Reject reason: a required input is missing. Add that binding and resend the same step — the other bindings were fine.');
        assert.ok(!unknown._suggestedPatch, 'a guess against an unknown shape is not a patch');

        // A loop.<var>.<field> the model DID write is checked against the
        // item too: a fan-out field without its envelope is repaired, a field
        // the item lacks is warned about — never refused on an action.
        const readId = r.idMap.read_file;
        const rep = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: readId, forEach: { overRef: `steps.${readId}.output.results`, itemVar: 'r' }, inputs: { query: { kind: 'ref', path: 'loop.r.content' } } }, dw);
        assert.ok(!rep.error, rep.error);
        assert.deepStrictEqual(rep.added.inputs.query, { kind: 'ref', path: 'loop.r.output.content' });
        assert.ok(rep._warnings.some(w => /^input "query": binding "loop\.r\.content" read as "loop\.r\.output\.content"/.test(w)), JSON.stringify(rep._warnings));
        const empty = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: readId, forEach: { overRef: `steps.${readId}.output.results`, itemVar: 'r' }, inputs: { query: { kind: 'ref', path: 'loop.r.output.nope' } } }, dw);
        assert.ok(!empty.error, empty.error);
        assert.ok(empty._warnings.some(w => /^input "query" reads loop\.r\.output\.nope but the forEach item \(an entry of steps\.a_[0-9a-f]+\.output\.results from nextcloud_read_file\) is \{index, item, output, status\}; output has: .*content.* — it will be empty at run time\.$/.test(w)), JSON.stringify(empty._warnings));
    }
    {
        // (16) The trigger payload answers for a read; a side-effect action is
        // told the candidate instead.
        const dw = ncWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'app_event', appProvider: 'gmail', appEvent: 'mail.new' }, dw);
        const read = await applyToolCall('builder_add_action', { tool: 'gmail_read' }, dw);
        assert.ok(!read.error, read.error);
        assert.deepStrictEqual(read.added.inputs, { messageId: { kind: 'ref', path: 'trigger.output.messageId' } });
        assert.ok(read._warnings.some(w => w === 'input "messageId" was not bound — bound to trigger.output.messageId (the trigger payload has it). Write the binding yourself next time.'), JSON.stringify(read._warnings));
        const send = await applyToolCall('builder_add_action', { tool: 'gmail_compose', afterStepId: 'trg', inputs: { body: { kind: 'literal', value: 'hi' } } }, dw);
        assert.match(send.error, /^gmail_compose: required input "to" is not bound\. The trigger payload has a field "to" — if that is the value to act on, bind it explicitly: to:\{kind:"ref", path:"trigger\.output\.to"\}\. It is not filled in for you because this action changes data\.$/);
        assert.match(send._fixHint, /^Reject reason: a required input is missing on a side-effect action/);
        assert.strictEqual(dw.def.steps.length, 1, 'nothing added');
        // Chained after the read instead: its top-level `to` is offered with
        // the caveat, and — this being a side-effect action — with NO patch
        // the loop could apply on a resend.
        const after = await applyToolCall('builder_add_action', { tool: 'gmail_compose', inputs: { body: { kind: 'literal', value: 'hi' } } }, dw);
        assert.match(after.error, /^gmail_compose: required input "to" is not bound\. The previous step a_[0-9a-f]+ \(gmail_read\) outputs a top-level "to", bind it only if that is the value you mean: to:\{kind:"ref", path:"steps\.a_[0-9a-f]+\.output\.to"\}\.$/);
        assert.ok(!after._suggestedPatch, 'no machine-applied binding on a side-effect action');
        assert.strictEqual(dw.def.steps.length, 1, 'nothing added');
    }
    {
        // (17) The previous step's top-level `path` is the folder that was
        // listed — offered with its caveat and the forEach that means one file,
        // never written.
        const dw = ncWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const list = await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices' } } }, dw);
        const r = await applyToolCall('builder_add_action', { tool: 'nextcloud_read_file' }, dw);
        assert.ok(r.error, 'not bound');
        assert.match(r.error, /^nextcloud_read_file: required input "path" is not bound\. The previous step a_[0-9a-f]+ \(nextcloud_list_files\) outputs a top-level "path", but that is the folder that was listed, not one file — bind it only if you really mean it: path:\{kind:"ref", path:"steps\.a_[0-9a-f]+\.output\.path"\}\./);
        assert.match(r.error, /To run once per listed file add forEach:\{overRef:"steps\.a_[0-9a-f]+\.output\.items", itemVar:"f"\} and bind path:\{kind:"ref", path:"loop\.f\.path"\}\.$/);
        assert.match(r._fixHint, /^Reject reason: a required input is missing\./);
        assert.ok(!r._suggestedPatch, 'two ways to bind it is not one exact edit');
        assert.strictEqual(dw.def.steps.length, 1, 'nothing bound, nothing added');
        // Only the entries have the name → the forEach to add, with both
        // edits as a machine-readable patch (the binding alone would be
        // refused as loop.<var> without a forEach).
        const ver = await applyToolCall('builder_add_action', { tool: 'nextcloud_list_versions' }, dw);
        assert.match(ver.error, /^nextcloud_list_versions: required input "fileId" is not bound\. steps\.a_[0-9a-f]+\.output\.items is a list whose entries have "fileId" — add forEach:\{overRef:"steps\.a_[0-9a-f]+\.output\.items", itemVar:"f"\} to this step and bind fileId:\{kind:"ref", path:"loop\.f\.fileId"\}\.$/);
        assert.match(ver._fixHint, /^Reject reason: a required input is missing and the previous step produces a list/);
        assert.deepStrictEqual(ver._suggestedPatch, { ops: [
            { op: 'set', path: 'forEach', value: { overRef: `steps.${list.added.id}.output.items`, itemVar: 'f' } },
            { op: 'set', path: 'inputs.fileId', value: { kind: 'ref', path: 'loop.f.fileId' } },
        ] });
        // (18) No schema map (MCP surface) → nothing is required, nothing is bound.
        const dwNoSchema = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dwNoSchema);
        const l2 = await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/x' } } }, dwNoSchema);
        const legacy = await applyToolCall('builder_add_action', { tool: 'nextcloud_read_file', forEach: { overRef: `steps.${l2.added.id}.output.items`, itemVar: 'f' } }, dwNoSchema);
        assert.ok(!legacy.error && Object.keys(legacy.added.inputs).length === 0 && !legacy._warnings, 'as today: no opinion without a schema map');
    }

    // ═══ builder_inspect_tool: batch form + single-tool shape preserved ═══
    {
        const dw = gatedWrap();
        const multi = await applyToolCall('builder_inspect_tool', { tools: ['gmail_search', 'gmail_compose'] }, dw);
        assert.ok(multi.results && multi.results.gmail_search && multi.results.gmail_compose, 'batch inspect returns per-tool map');
        assert.strictEqual(multi.results.gmail_search.sample, null, 'batch inspect omits samples');
        assert.ok(multi.results.gmail_search.inputs.query.required === true, 'batch inspect keeps inputs');
        assert.ok(dw._inspectedTools.has('gmail_search') && dw._inspectedTools.has('gmail_compose'), 'both tools marked inspected');

        const single = await applyToolCall('builder_inspect_tool', { tool: 'gmail_compose' }, dw);
        assert.strictEqual(single.tool, 'gmail_compose', 'single form keeps flat result shape');
        assert.ok(single.inputs && single.requiredInputs.includes('to'), 'single form keeps inputs/requiredInputs');

        const none = await applyToolCall('builder_inspect_tool', {}, dw);
        assert.ok(none.error, 'no tool/tools → error');
    }

    // ═══ echo policy: pure append → _stepIds; update → _draftSteps; lean forces full ═══
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        assert.ok(typeof a._stepIds === 'string' && a._stepIds.includes(a.added.id), 'append carries compact _stepIds');
        assert.ok(!a._draftSteps, 'append does not carry full _draftSteps');
        const u = await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { label: 'Find' } }, dw);
        assert.ok(Array.isArray(u._draftSteps), 'topology change carries full _draftSteps');

        const dwLean = freshWrap();
        dwLean._resultDetail = 'full';
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dwLean);
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dwLean);
        assert.ok(Array.isArray(a2._draftSteps), "lean profile (_resultDetail='full') keeps the full echo");
    }

    // ═══ compactSample bounds ═══
    {
        const big = { items: Array.from({ length: 50 }, (_, i) => ({ i, text: 'x'.repeat(300) })), note: 'y'.repeat(500) };
        const c = compactSample(big);
        assert.ok(c !== null, 'compacted form fits the default budget');
        assert.strictEqual(c.items.length, 2, 'array → first item + more-marker');
        assert.ok(String(c.items[1]).includes('more'), 'more-marker present');
        assert.ok(c.note.length <= 121, 'string capped');
        const tiny = compactSample({ a: 1 });
        assert.deepStrictEqual(tiny, { a: 1 }, 'small values pass through');
        const over = compactSample({ s: 'x'.repeat(100) }, { maxChars: 10 });
        assert.strictEqual(over, null, 'over-budget → null (caller drops the field)');
    }

    // ═══ truncateToolResultJson is always valid JSON ═══
    {
        const small = { ok: true };
        assert.deepStrictEqual(JSON.parse(truncateToolResultJson(small)), small, 'under budget → passthrough');

        const huge = {
            run: { id: 'r1' },
            _draftSteps: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}` })),
            steps: Array.from({ length: 40 }, (_, i) => ({ stepId: `s${i}`, output: 'z'.repeat(2000) })),
        };
        const out = truncateToolResultJson(huge, 20_000);
        const parsed = JSON.parse(out); // must not throw
        assert.ok(out.length <= 20_000, 'within cap');
        assert.ok(!parsed._draftSteps, '_draftSteps dropped first');
        assert.ok(parsed._truncated === true && parsed.omittedSteps > 0, 'steps trimmed with explicit marker');

        const monster = { blob: 'q'.repeat(100_000) };
        const out2 = truncateToolResultJson(monster, 5_000);
        const parsed2 = JSON.parse(out2);
        assert.ok(out2.length <= 5_000 && parsed2._truncated, 'last-resort preview stays valid JSON');
    }

    // ═══ compactDryRunForModel projection ═══
    {
        const result = {
            run: { id: 'r1', status: 'success', startedAt: 't0', finishedAt: 't1', triggerPayload: { huge: 'x'.repeat(500) } },
            steps: [
                { stepId: 's1', stepType: 'integration_action', status: 'success', input: { q: 'find' }, output: { results: Array.from({ length: 20 }, (_, i) => ({ i })) }, _hint: { outputType: 'object', topKeys: ['results'], shape: '{results: array}' } },
                { stepId: 's2', stepType: 'ai_step', status: 'failed', error: 'boom', errorClass: 'ToolError', input: { prompt: 'p'.repeat(2000) }, output: null, _hint: { outputType: 'null', topKeys: null, shape: null } },
            ],
        };
        const m = compactDryRunForModel(result);
        assert.strictEqual(m.run.stepCount, 2, 'run projected with stepCount');
        assert.ok(!('triggerPayload' in m.run), 'run row payload fields dropped');
        const ok = m.steps.find(s => s.stepId === 's1');
        assert.ok(ok._hint, 'succeeded step keeps _hint');
        assert.ok(!('outputHead' in ok) && !('output' in ok), 'succeeded step carries no payload — shapes only (2026-09-18)');
        assert.ok(!('input' in ok), 'succeeded step drops input');
        const bad = m.steps.find(s => s.stepId === 's2');
        assert.strictEqual(bad.error, 'boom', 'failed step keeps error verbatim');
        assert.ok(bad.input, 'failed step keeps (compacted) input');
        assert.strictEqual(m.ok, false, 'a failed step makes the run not ok');
        assert.match(m.note, /^1 step failed\. Fix each failed step with builder_update_step/, 'the note names what to do');
    }

    // ═══ compactDryRunForModel: the quiet failures — empty results, failed forEach items, null fields ═══
    {
        const m = compactDryRunForModel({
            run: { id: 'r2', status: 'success' },
            steps: [
                { stepId: 'l1', stepType: 'integration_action', status: 'success', output: { path: '/x', count: 0, items: [] }, _hint: { outputType: 'object', topKeys: ['path', 'count', 'items'], shape: '' } },
                { stepId: 'f1', stepType: 'data_extraction', status: 'success', output: { iterations: 3, succeeded: 2, failed: 1, results: [{ index: 0, status: 'success', output: { totaal: 1 } }, { index: 1, status: 'error', error: 'model timeout' }, { index: 2, status: 'success', output: { totaal: 2 } }] }, _hint: { outputType: 'object', topKeys: ['iterations', 'succeeded', 'failed', 'results'], shape: '' } },
                { stepId: 'x1', stepType: 'data_extraction', status: 'success', output: { leverancier: 'Acme', totaal: null, _dryRunSynthesised: true }, _hint: { outputType: 'object', topKeys: ['leverancier', 'totaal', '_dryRunSynthesised'], shape: '' } },
                { stepId: 'd1', stepType: 'datatable', status: 'success', output: { row: { a: 1 }, id: null, created: true }, _hint: { outputType: 'object', topKeys: ['row', 'id', 'created'], shape: '' } },
            ],
        });
        assert.strictEqual(m.steps[0].empty, true, 'an empty listing is flagged');
        assert.deepStrictEqual(m.steps[1].items, { iterations: 3, succeeded: 2, failed: 1, failedItems: [{ index: 1, error: 'model timeout' }] }, 'failed forEach items are reported');
        assert.deepStrictEqual(m.steps[2].nullKeys, ['totaal'], 'a null extraction field is flagged');
        assert.ok(!('nullKeys' in m.steps[3]), 'a previewed write\'s id: null is by design, not a flag');
        assert.strictEqual(m.ok, false, 'a failed item makes the run not ok');
        assert.match(m.note, /1 forEach item failed/);
        const clean = compactDryRunForModel({ run: { id: 'r3', status: 'success' }, steps: [{ stepId: 'l1', stepType: 'integration_action', status: 'success', output: { count: 0, items: [] }, _hint: {} }] });
        assert.strictEqual(clean.ok, true);
        assert.match(clean.note, /^Clean run: every step succeeded — but l1 produced nothing \(empty: true\)/);
        const spotless = compactDryRunForModel({ run: { id: 'r4', status: 'success' }, steps: [{ stepId: 's', status: 'success', output: { count: 3 }, _hint: {} }] });
        assert.strictEqual(spotless.note, 'Clean run: every step succeeded. Nothing to fix: finish with builder_finalize.');
    }

    // ═══ ai_step modelTier gate: only the user's configured tiers ═══
    {
        const dw = freshWrap();
        dw._allowedModelTiers = new Set(['auto', 'fast', 'think', 'deep_thinking']);
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);

        const bad = await applyToolCall('builder_add_ai_step', { prompt: 'x', modelTier: 'standard' }, dw);
        assert.ok(bad.error && bad.error.includes('standard') && bad.error.includes('fast'), `unconfigured tier rejected with the allowed list: ${bad.error}`);
        assert.strictEqual(dw.def.steps.length, 0, 'no step added on tier reject');

        const ok = await applyToolCall('builder_add_ai_step', { prompt: 'x', modelTier: 'deep_thinking' }, dw);
        assert.ok(!ok.error, `configured tier allowed: ${ok.error}`);
        const auto = await applyToolCall('builder_add_ai_step', { prompt: 'y' }, dw);
        assert.ok(!auto.error, 'omitted tier (auto default) always allowed');

        // update_step patch is gated the same way
        const patchBad = await applyToolCall('builder_update_step', { stepId: ok.added.id, patch: { modelTier: 'swarm' } }, dw);
        assert.ok(patchBad.error && patchBad.error.includes('swarm'), 'patching to an unconfigured tier rejected');
        const patchOk = await applyToolCall('builder_update_step', { stepId: ok.added.id, patch: { modelTier: 'fast' } }, dw);
        assert.ok(!patchOk.error, `patching to a configured tier allowed: ${patchOk.error}`);

        // batch entries inherit the gate
        const batchBad = await applyToolCall('builder_add_steps', {
            steps: [{ tempId: 'ai', type: 'ai_step', spec: { prompt: 'z', modelTier: 'pro' } }],
        }, dw);
        assert.ok(batchBad.error && batchBad.failedIndex === 0 && batchBad.added.length === 0, 'batch ai_step with unconfigured tier is refused, nothing added');

        // no set attached (tests / legacy callers) → gate is a no-op
        const dwNoSet = freshWrap();
        const legacy = await applyToolCall('builder_add_ai_step', { prompt: 'x', modelTier: 'whatever' }, dwNoSet);
        assert.ok(!legacy.error, 'gate no-ops without _allowedModelTiers');
    }

    // ═══ registration: batch tool wired into the right sets, INCLUDING core ═══
    {
        assert.ok(MUTATING_TOOLS.has('builder_add_steps'), 'builder_add_steps in MUTATING_TOOLS');
        assert.ok(SCOPED_GRAPH_TOOLS.has('builder_add_steps'), 'builder_add_steps in SCOPED_GRAPH_TOOLS');
        // Reversed 2026-09-11. The serial protocol cost small models a round
        // per step; a measured build burned all 24 iterations without
        // converging. applyAddSteps applies entries in order and keeps the
        // built prefix, and a resend never builds an entry twice — so a
        // truncated reply costs the entries after the cut, never a duplicate
        // of the ones before it (which is what several separate calls per
        // reply produced when the model resent them all).
        assert.ok(CORE_TOOL_NAMES.has('builder_add_steps'), 'builder_add_steps IS in CORE_TOOL_NAMES — small models batch too');
        const schema = TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_steps');
        assert.ok(schema, 'builder_add_steps schema registered');
        assert.ok(schema.function.parameters.properties.scope, 'scope param auto-injected');
        const inspect = TOOL_SCHEMAS.find(t => t.function.name === 'builder_inspect_tool');
        assert.ok(inspect.function.parameters.properties.tools, 'inspect schema has the batch `tools` param');
        assert.deepStrictEqual(inspect.function.parameters.required || [], [], 'inspect `tool` no longer hard-required');
    }

    // ═══ the same rejected call, sent again: the ladder ═══
    // A rejected mutator rolls back, so identical args meet an identical
    // draft and an identical error — the model saw nothing that told it that.
    // Rung 2 without a patch hands over the one call to send; rung 3 stops
    // the turn (repeatLadder.test.js covers the patch rung).
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const bad = { steps: [{ tempId: 'x', type: 'data_extraction', spec: { fields: [{ name: 'a', type: 'string' }] } }] }; // no source
        const r1 = await applyToolCall('builder_add_steps', structuredClone(bad), dw);
        assert.ok(r1.error && /source is required/.test(r1.error), r1.error);
        assert.strictEqual(r1._repeated, undefined, 'first rejection is not a repeat');
        const r2 = await applyToolCall('builder_add_steps', structuredClone(bad), dw);
        assert.strictEqual(r2._repeated, 2);
        assert.match(r2._fixHint, /SAME call as your previous attempt \(2 times now\)/);
        assert.match(r2._fixHint, /Change exactly what the error names/);
        assert.match(r2._fixHint, /send exactly this ONE call next and nothing else: builder_add_steps\(\{"steps":\[/);
        // "source is required" carries its own hint now (there is no binding
        // to fix — there is none), so the generic stamp never lands on it.
        assert.match(r2._fixHint, /^Reject reason: no source\./, 'the original hint is kept in front');
        const r3 = await applyToolCall('builder_add_steps', structuredClone(bad), dw);
        assert.strictEqual(r3._repeated, 3);
        assert.match(r3._fixHint, /Stopped: the same step was rejected 3 times/);
        assert.deepStrictEqual(r3._stop, { reason: 'repeated_rejection', tool: 'builder_add_steps', error: r3.error.slice(0, 300), entryIndex: 0, label: 'data_extraction' });
        // A different rejected call resets the streak; a successful mutation clears it.
        const other = await applyToolCall('builder_add_steps', { steps: [{ type: 'nonsense', spec: {} }] }, dw);
        assert.ok(other.error && !other._repeated, 'a different call is not a repeat');
        const r4 = await applyToolCall('builder_add_steps', structuredClone(bad), dw);
        assert.ok(r4.error && !r4._repeated, 'the streak restarted at 1');
        const ok = await applyToolCall('builder_add_datetime', { op: 'now' }, dw);
        assert.ok(!ok.error, ok.error);
        assert.strictEqual(dw._lastRejected, null, 'a successful mutation clears the memory');
        const r5 = await applyToolCall('builder_add_steps', structuredClone(bad), dw);
        assert.ok(r5.error && !r5._repeated, 'after a mutation the same call is a fresh attempt');
        // A mutator that leaves the step GRAPH untouched (a title, a canvas
        // note) does not clear the ladder: the refused call meets the same
        // graph. Measured: a byte-identical batch resent beside a
        // builder_set_metadata every round never climbed past rung 1 and
        // burned the whole iteration budget.
        for (const [tool, args] of [['builder_set_metadata', { title: 't' }], ['builder_add_note', { text: 'n' }]]) {
            const fresh = freshWrap();
            await applyToolCall('builder_propose_trigger', { kind: 'manual' }, fresh);
            const b1 = await applyToolCall('builder_add_steps', structuredClone(bad), fresh);
            assert.ok(b1.error && !b1._repeated, b1.error);
            const neutral = await applyToolCall(tool, args, fresh);
            assert.ok(!neutral.error, `${tool}: ${neutral.error}`);
            assert.ok(fresh._lastRejected, `${tool} leaves the memory standing`);
            const b2 = await applyToolCall('builder_add_steps', structuredClone(bad), fresh);
            assert.strictEqual(b2._repeated, 2, `${tool}: the identical resend beside it is still a repeat`);
            await applyToolCall(tool, args, fresh);
            const b3 = await applyToolCall('builder_add_steps', structuredClone(bad), fresh);
            assert.strictEqual(b3._repeated, 3, tool);
            assert.strictEqual(b3._stop.reason, 'repeated_rejection', `${tool}: the third rung still stops`);
        }
    }

    console.log('builderTools.addSteps.test.js: all batch/diet tests passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
