/**
 * Unit tests — builder system-prompt rendering (§B/§C).
 *
 * Plain assert-based suite (no jest/mocha in this repo).
 * Run: node automation/builderPrompt.test.js
 *
 * builderPrompt is pure (it only require()s outputSchemas lazily) — no DB.
 */

const assert = require('assert');
const {
    renderCatalog,
    renderCatalogSlim,
    buildFullSystemPrompt,
    buildLeanSystemPrompt,
    renderDraftStateSystemMessage,
    renderTurnPreferences,
    buildFewShotMessages,
    renderDatatablesBlock,
} = require('./builderPrompt');
const { renderRelevantToolSchemas } = require('./builderPrompt/catalogRender');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const CATALOG = {
    apps: [
        {
            id: 'gmail', label: 'Gmail', available: true, actions: [
                { name: 'gmail_search', description: 'Search Gmail\n(second line ignored)', sideEffect: false, inputSchema: { type: 'object', properties: { q: {}, maxResults: {} }, required: ['q'] } },
                { name: 'gmail_compose', description: 'Send an email', sideEffect: true, inputSchema: { type: 'object', properties: { to: {}, subject: {}, body: {}, cc: {} }, required: ['to', 'body'] } },
            ],
        },
        { id: 'hidden', label: 'Hidden', available: false, actions: [{ name: 'hidden_tool', description: 'x', sideEffect: false, inputSchema: null }] },
    ],
};

// ─── renderCatalogSlim ──────────────────────────────────────────────────────
console.log('renderCatalogSlim');

t('emits one line per action with name + input count, grouped by app', () => {
    const out = renderCatalogSlim(CATALOG);
    assert.ok(out.includes('### Gmail (gmail)'), 'app header present');
    assert.ok(out.includes('gmail_search [list] — Search Gmail (2 inputs, 1 required)'), 'search line with count + required');
    assert.ok(out.includes('gmail_compose [side-effect] — Send an email (4 inputs, 2 required)'), 'compose line with side-effect + counts');
});

t('does NOT leak output shapes or param names', () => {
    const out = renderCatalogSlim(CATALOG);
    assert.ok(!out.includes('→ output:'), 'no output-shape annotation');
    assert.ok(!/\bproperties\b/.test(out), 'no raw schema');
    // param names must not appear — only counts
    assert.ok(!/\bmaxResults\b/.test(out), 'param names withheld (fetched via inspect)');
});

t('excludes unavailable apps', () => {
    const out = renderCatalogSlim(CATALOG);
    assert.ok(!out.includes('Hidden'), 'available:false app excluded');
});

t('is materially shorter than the full renderCatalog', () => {
    const slim = renderCatalogSlim(CATALOG);
    const full = renderCatalog(CATALOG);
    assert.ok(slim.length < full.length, `slim (${slim.length}) should be shorter than full (${full.length})`);
});

t('renders "no inputs" when an action declares none', () => {
    const cat = { apps: [{ id: 'a', label: 'A', available: true, actions: [{ name: 'ping', description: 'p', sideEffect: false, inputSchema: { type: 'object', properties: {} } }] }] };
    assert.ok(renderCatalogSlim(cat).includes('ping — p (no inputs)'), 'no-inputs tag');
});

// ─── full prompt: slim catalog + gated sections + new rules ──────────────────
console.log('buildFullSystemPrompt');

t('uses the slim catalog (no output-shape arrows)', () => {
    const p = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(!p.includes('→ output:'), 'full prompt no longer dumps output shapes');
});

t('teaches in-place editing and inspect-before-bind', () => {
    const p = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(p.includes('builder_update_step'), 'mentions builder_update_step');
    assert.ok(p.includes('builder_inspect_tool'), 'mentions builder_inspect_tool');
    assert.ok(/never delete and recreate/i.test(p), 'has the never-delete-to-edit rule');
});

t('positions data_extraction against ai_step in both prompt variants', () => {
    // Extraction is a data_extraction step; an ai_step is for judgement and
    // writing. Both variants must say so, and the worked example must not
    // still teach the ai_step shape for it.
    const full = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(full.includes('data_extraction'), 'full prompt lists the type');
    assert.ok(full.includes('builder_add_data_extraction'), 'full prompt names the tool');
    assert.ok(/ai_step, data_extraction, code, http_request/.test(full), 'full prompt lists it among failure-capable on_error sources');
    assert.ok(!/builder_add_ai_step\` → prompt "Extract/.test(full), 'the invoice worked example no longer extracts through an ai_step');
    const lean = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(/EXTRACTION IS NOT AN ai_step/.test(lean), 'lean prompt carries the one bullet');
    assert.ok(lean.includes('builder_add_data_extraction'), 'lean prompt names the tool');
    assert.ok(/fields\` \[\{name,type,description,required\}\] IS the output shape/.test(lean), 'lean prompt says fields are the shape');
});

t('gates the Webpages section behind catalog presence', () => {
    const without = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(!without.includes('Inspecting webpages'), 'no Webpages prose when not in catalog');
    const withWp = buildFullSystemPrompt({
        catalog: { apps: [{ id: 'webpages', label: 'Webpages', available: true, actions: [{ name: 'webpage_db_exec', description: 'SQL', sideEffect: true, inputSchema: { type: 'object', properties: { webpageId: {}, sql: {} }, required: ['webpageId', 'sql'] } }] }] },
        codeStepEnabled: false,
    });
    assert.ok(withWp.includes('Inspecting webpages'), 'Webpages prose present when webpage tools exist');
});

t('gates the Drive sourceHandle section behind drive_upload_file', () => {
    const without = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(!without.includes('Mail attachments → Google Drive'), 'no Drive prose without drive_upload_file');
    const withDrive = buildFullSystemPrompt({
        catalog: { apps: [{ id: 'gdrive', label: 'Drive', available: true, actions: [{ name: 'drive_upload_file', description: 'Upload', sideEffect: true, inputSchema: { type: 'object', properties: { name: {} } } }] }] },
        codeStepEnabled: false,
    });
    assert.ok(withDrive.includes('Mail attachments → Google Drive'), 'Drive prose present when drive_upload_file exists');
});

// ─── lean prompt mirrors the new rules ──────────────────────────────────────
console.log('buildLeanSystemPrompt');

t('lean prompt mentions inspect + update_step', () => {
    const p = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(p.includes('builder_inspect_tool'), 'lean mentions inspect');
    assert.ok(p.includes('builder_update_step'), 'lean mentions update_step');
    assert.ok(!p.includes('→ output:'), 'lean uses slim catalog');
});

// ─── few-shots: small models ('core') see batched builds only ────────────────
console.log('buildFewShotMessages');

t("core toolset count=3 carries the batched protocol and the binding basics", () => {
    const msgs = JSON.stringify(buildFewShotMessages(3, { toolset: 'core' }));
    // Reversed 2026-09-11: core carries the batch tools now, and a worked
    // batched example is the strongest signal a small model gets that it need
    // not spend one round per step.
    assert.ok(msgs.includes('builder_add_steps'), 'core sees the batch tool it can now call');
    assert.ok(msgs.includes('builder_inspect_tool'), 'inspect example present');
});

t("core toolset count=1 is the invoice fan-out on its own — a batched build too", () => {
    // 2026-09-18: the core order is [invoice fan-out, Dutch create-table,
    // Gmail digest] so a `fewShots: 2` override drops the digest, which
    // teaches nothing the fan-out does not. Whatever leads must still be a
    // multi-call reply with ONE builder_add_steps batch.
    const msgs = buildFewShotMessages(1, { toolset: 'core' });
    const firstAssistant = msgs.find(m => m.role === 'assistant');
    assert.ok(Array.isArray(firstAssistant.tool_calls) && firstAssistant.tool_calls.length >= 2,
        'even at count=1 the small model sees a multi-call reply');
    const s = JSON.stringify(msgs);
    assert.ok(s.includes('builder_add_steps'), 'and the batch add tool');
    assert.ok(s.includes('nextcloud_list_files') && !s.includes('gmail_search'), 'the fan-out leads, not the digest');
});

t("full toolset count=1 leads with the BATCHED example (multi-call replies + builder_add_steps)", () => {
    const msgs = buildFewShotMessages(1, { toolset: 'full' });
    const firstAssistant = msgs.find(m => m.role === 'assistant');
    assert.ok(Array.isArray(firstAssistant.tool_calls) && firstAssistant.tool_calls.length >= 2,
        'first assistant reply carries multiple tool calls');
    const s = JSON.stringify(msgs);
    assert.ok(s.includes('builder_add_steps'), 'batched example uses builder_add_steps');
    assert.ok(s.includes('steps.$'), 'batched example demonstrates $tempId refs');
    const inspectCall = msgs.flatMap(m => m.tool_calls || []).find(tc => tc.function.name === 'builder_inspect_tool');
    const inspectArgs = JSON.parse(inspectCall.function.arguments);
    assert.ok(Array.isArray(inspectArgs.tools) && inspectArgs.tools.length >= 2, 'batched example uses multi-tool inspect');
});

// ─── WS2: draft state lives in the dynamic message, not the system prompt ────
console.log('renderDraftStateSystemMessage / cache-stable system prompt');

t('neither prompt variant embeds the LIVE draft state anymore', () => {
    const full = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    const lean = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(!full.includes('Current draft — LIVE state'), 'full prompt stays draft-free (cacheable)');
    assert.ok(!lean.includes('Current draft — LIVE state'), 'lean prompt stays draft-free (cacheable)');
    // `existingDraftSummary` was accepted and never rendered for months — it is
    // gone from both signatures; a stray caller passing it must still be inert.
    const stray = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, existingDraftSummary: 'MAIN FLOW: xyz' });
    assert.strictEqual(stray, full, 'unknown keys change nothing');
});

// ─── Session-stable system prompt: the per-turn preferences moved out ────────
console.log('system prompt is a pure function of session state');

// The values the old signatures rendered inline. None of them may appear in
// either variant now, however the caller spells the (ignored) old parameters.
const PER_TURN = {
    userTimezone: 'Pacific/Auckland', webSearchEnabled: false,
    disabledMedia: { image: true }, allowedModelTiers: ['auto', 'fast', 'thinking'],
};

t('system prompts render no timezone / web-search / modelTier-list lines', () => {
    for (const build of [buildFullSystemPrompt, buildLeanSystemPrompt]) {
        const p = build({ catalog: CATALOG, codeStepEnabled: false, batchTools: true, ...PER_TURN });
        assert.ok(!p.includes('All times use'), 'no timezone line');
        assert.ok(!p.includes('Pacific/Auckland'), 'timezone value absent');
        assert.ok(!/web.?search:? (has web-search )?(ENABLED|DISABLED)/i.test(p), 'no web-search preference line');
        assert.ok(!p.includes('MUST be one of'), 'no modelTier list line');
        assert.ok(!p.includes('generation is disabled') && !p.includes('disabled image generation'), 'no disabled-media line');
    }
});

t('two builds with the same catalogue are byte-identical, whatever the per-turn inputs', () => {
    const a = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true, ...PER_TURN });
    const b = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true, userTimezone: 'Europe/Amsterdam', webSearchEnabled: true });
    assert.strictEqual(a, b, 'lean: same catalogue → same bytes');
    const c = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, ...PER_TURN });
    const d = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.strictEqual(c, d, 'full: same catalogue → same bytes');
});

t('renderTurnPreferences renders all four preferences under a "This turn" heading', () => {
    const out = renderTurnPreferences(PER_TURN);
    assert.ok(out.startsWith('## This turn'), 'heading');
    assert.ok(out.includes("All times use the user's timezone: Pacific/Auckland."), 'timezone');
    assert.ok(out.includes('ai_step `modelTier` MUST be one of: auto, fast, thinking'), 'tiers');
    assert.ok(out.includes('Web search: DISABLED'), 'web search off');
    assert.ok(out.includes('disabled image generation'), 'disabled media');
    assert.ok(renderTurnPreferences({ ...PER_TURN, webSearchEnabled: true }).includes('Web search: ENABLED'), 'web search on');
});

t('renderTurnPreferences omits absent preferences, and is null when there are none', () => {
    const tzOnly = renderTurnPreferences({ userTimezone: 'Europe/Amsterdam' });
    assert.ok(tzOnly.includes('Europe/Amsterdam'));
    assert.ok(!tzOnly.includes('Web search') && !tzOnly.includes('MUST be one of') && !tzOnly.includes('generation'), 'only what was given');
    assert.ok(!renderTurnPreferences({ userTimezone: 'X', disabledMedia: { image: false } }).includes('generation'), 'a false media flag renders nothing');
    assert.ok(!renderTurnPreferences({ userTimezone: 'X', allowedModelTiers: [] }).includes('MUST'), 'an empty tier list renders nothing');
    assert.strictEqual(renderTurnPreferences({}), null, 'nothing set → null (not an empty heading)');
    assert.strictEqual(renderTurnPreferences(), null);
});

t('renderDraftStateSystemMessage carries heading, state and validated canvas hint', () => {
    const msg = renderDraftStateSystemMessage({ agentDraftState: 'MAIN FLOW:\n  - `trg` trigger:manual', canvasScope: 'enrich_contact' });
    assert.ok(msg.includes('Current draft — LIVE state'), 'heading present');
    assert.ok(msg.includes('`trg` trigger:manual'), 'draft state embedded');
    assert.ok(msg.includes("flowlet 'enrich_contact'"), 'canvas hint appended');
    const bad = renderDraftStateSystemMessage({ agentDraftState: 'x', canvasScope: 'NOT A KEY!' });
    assert.ok(!bad.includes('NOT A KEY'), 'malformed canvasScope rejected (no prompt injection)');
    assert.strictEqual(renderDraftStateSystemMessage({ agentDraftState: null }), null, 'no state → no message');
});

t('full prompt teaches the batch protocol', () => {
    const full = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(full.includes('Work in BATCHES'), 'batch section present');
    assert.ok(full.includes('builder_add_steps'), 'batch add tool taught');
    assert.ok(!full.includes('call `builder_set_plan` AGAIN with the\n  WHOLE list'), 'per-item whole-list plan protocol gone');
    assert.ok(full.includes('markDone'), 'plan diff form taught');
});

t('lean prompt gates the batch paragraph on batchTools', () => {
    // The PARAMETER still gates the paragraph — that contract is unchanged.
    // What changed 2026-09-11 is which profiles pass true: the small profile
    // now does (profile.batchTools), so in practice every profile sees it.
    const off = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: false });
    const on = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true });
    assert.ok(!off.includes('builder_add_steps'), 'batchTools:false renders no batch paragraph');
    assert.ok(on.includes('builder_add_steps'), 'batchTools:true renders it');
});

// ─── WS8: renderRelevantToolSchemas ──────────────────────────────────────────
console.log('renderRelevantToolSchemas');

t('scores message-matched tools and renders full input schemas', () => {
    const r = renderRelevantToolSchemas(CATALOG, 'search my gmail for invoices and compose a reply', { steps: [] });
    assert.ok(r && r.tools.includes('gmail_search') && r.tools.includes('gmail_compose'), 'both gmail tools matched');
    assert.ok(r.text.includes('pre-inspected'), 'block announces pre-inspection');
    assert.ok(r.text.includes('q*'), 'required param starred');
    assert.ok(/to\*/.test(r.text), 'compose required params starred');
});

t('draft-used tools rank in even without a message match; unavailable apps never leak', () => {
    const r = renderRelevantToolSchemas(CATALOG, 'completely unrelated words', { steps: [{ tool: 'gmail_compose' }] });
    assert.ok(r && r.tools.includes('gmail_compose'), 'draft-used tool included for edits');
    const none = renderRelevantToolSchemas(CATALOG, 'hidden tool please', { steps: [] });
    assert.ok(!none || !none.tools.includes('hidden_tool'), 'available:false app stays hidden (fail-closed)');
});

t('no relevance → null (falls back to the inspect path)', () => {
    assert.strictEqual(renderRelevantToolSchemas(CATALOG, 'zzz qqq', { steps: [] }), null);
});

// ─── A6/A7: the "Datatables you may use" block ──────────────────────────────
//
// The prompt used to say "datatableId must be an id from the catalog" while
// the catalog carried apps only — the model invented `tbl_…` ids on every
// invoice brief. The block is the list; three inputs render three ways.
console.log('renderDatatablesBlock');

const FACTUREN = {
    id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen', canWrite: true, scope: 'org',
    columns: [
        { key: 'datum', name: 'Datum', type: 'date', unique: false },
        { key: 'leverancier', name: 'Leverancier', type: 'text', unique: false },
        { key: 'excl_btw', name: 'Excl. btw', type: 'number', unique: false },
    ],
};
const KLANTEN = { id: 'tbl_9f8e7d', key: 'klanten', name: 'Klanten', canWrite: false, columns: [{ key: 'email', name: 'E-mail', type: 'text', unique: true }] };

t('renders id, key, title, writability and columns as key ("Title") type', () => {
    const out = renderDatatablesBlock([FACTUREN]);
    assert.ok(out.startsWith('## Datatables you may use (existing tables — never invent an id)'), 'heading');
    for (const s of ['tbl_1a2b3c', 'key facturen', '"Facturen"', 'writable', 'excl_btw ("Excl. btw")', 'datum ("Datum") date']) {
        assert.ok(out.includes(s), `block contains ${s}`);
    }
    assert.ok(/Key values by the column KEY/.test(out), 'teaches key-not-title');
    assert.ok(/find_rows, count_rows, add_row, save_row \(\+matchColumn\), update_rows, delete_rows/.test(out), 'lists the ops');
});

t('the worked example names a REAL writable table from the list, never an invented id', () => {
    const out = renderDatatablesBlock([KLANTEN, FACTUREN]);
    assert.ok(out.includes('op:"add_row", datatableId:"tbl_1a2b3c", datatableKey:"facturen"'), 'first writable table is the example');
    assert.ok(out.includes('values:{datum:{kind:"ref", path:"loop.x.output.datum"}'), 'example keys values by the first column KEY');
    const ro = renderDatatablesBlock([KLANTEN]);
    assert.ok(ro.includes('op:"find_rows", datatableId:"tbl_9f8e7d"'), 'with only read-only tables the example is a read');
    assert.ok(!ro.includes('values:'), 'no write example on a read-only table');
});

t('a read-only table says so, and the block says a read-only table cannot take a write', () => {
    const out = renderDatatablesBlock([FACTUREN, KLANTEN]);
    assert.ok(/tbl_9f8e7d · key klanten · "Klanten" · read-only/.test(out), 'read-only tag');
    assert.ok(out.includes('A read-only table cannot take a write.'));
    // Input order is output order — the block sits in the cached prefix.
    assert.ok(out.indexOf('tbl_1a2b3c') < out.indexOf('tbl_9f8e7d'), 'order preserved');
    assert.strictEqual(renderDatatablesBlock([FACTUREN, KLANTEN]), out, 'deterministic');
});

t('[] renders the "none" line; null/undefined render nothing at all', () => {
    const none = renderDatatablesBlock([]);
    assert.ok(none.startsWith('## Datatables you may use\n\n_(none — this user has no datatables.'), 'none line');
    assert.ok(none.includes('Studio → Datatables first and stop'), 'tells the model to stop');
    assert.strictEqual(renderDatatablesBlock(null), '', 'null = could not tell → silent');
    assert.strictEqual(renderDatatablesBlock(undefined), '', 'undefined = no list → silent');
});

t('[] with canCreate points at builder_create_datatable instead of telling the model to stop', () => {
    // The main builders carry builder_create_datatable on the menu — "stop and
    // ask the user" contradicted the tool the model was looking at (2026-09-17).
    const none = renderDatatablesBlock([], { canCreate: true });
    assert.ok(none.includes('builder_create_datatable'), 'names the create tool');
    assert.ok(!none.includes('and stop'), 'no stop order');
});

t('caps are announced, never silent: 20 tables, 30 columns per table', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ ...FACTUREN, id: `tbl_${i}`, key: `t${i}` }));
    const out = renderDatatablesBlock(many);
    assert.ok(out.includes('tbl_19') && !out.includes('tbl_20 '), 'twenty listed');
    assert.ok(out.includes('…and 3 more tables — search the document library for more'), 'overflow named');
    const wide = { ...FACTUREN, columns: Array.from({ length: 34 }, (_, i) => ({ key: `c${i}`, name: `C${i}`, type: 'text' })) };
    const w = renderDatatablesBlock([wide]);
    assert.ok(w.includes('c29 ("C29")') && !w.includes('c30 ("C30")'), 'thirty columns listed');
    assert.ok(w.includes('…+4 more columns'), 'column overflow named');
    assert.ok(!renderDatatablesBlock([FACTUREN]).includes('more'), 'no overflow note under the caps');
});

t('both prompts carry the block right before the catalog, and stay byte-identical without it', () => {
    const withDt = { ...CATALOG, datatables: [FACTUREN] };
    for (const [name, build] of [['full', buildFullSystemPrompt], ['lean', buildLeanSystemPrompt]]) {
        const p = build({ catalog: withDt, codeStepEnabled: false, batchTools: true });
        const heading = p.indexOf('## Datatables you may use');
        const cat = p.indexOf('## Catalog');
        assert.ok(heading !== -1, `${name}: block present`);
        assert.ok(heading < cat, `${name}: block sits before the catalog`);
        assert.ok(p.includes('excl_btw ("Excl. btw")'), `${name}: column keys reach the model`);
        // Absent (null) and undefined both render NOTHING — the pre-existing
        // bytes, so the prompt cache of a session without tables is untouched.
        const plain = build({ catalog: CATALOG, codeStepEnabled: false, batchTools: true });
        const nul = build({ catalog: { ...CATALOG, datatables: null }, codeStepEnabled: false, batchTools: true });
        assert.strictEqual(nul, plain, `${name}: datatables:null is byte-identical to no datatables`);
        assert.ok(!plain.includes('## Datatables you may use'), `${name}: no heading without a list`);
        // [] is NOT silent: the model must be told there is nothing to write to —
        // and both main builders carry builder_create_datatable, so the line
        // points at creating one rather than stopping (2026-09-17).
        const empty = build({ catalog: { ...CATALOG, datatables: [] }, codeStepEnabled: false, batchTools: true });
        assert.ok(empty.includes('_(none yet — when the request needs a table, CREATE it first with builder_create_datatable'), `${name}: the none line points at the create tool`);
    }
});

t('the datatable prose points at the block, not "the catalog", and the lean batch bullet describes partial application', () => {
    const full = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(full.includes('datatableId must be an id from the\n                     "Datatables you may use" block below (its key beside it as datatableKey);\n                     values are keyed by column KEY'), 'full prose rewritten');
    assert.ok(!/datatableId must be an id from the catalog/.test(full), 'old wording gone');
    const lean = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true });
    // ONE datatable bullet since 2026-09-17 (the small-band diet): exists →
    // add_row with id AND key; missing → create first; keys, refs, forEach.
    assert.ok(lean.includes('DATATABLES. Table exists in the "Datatables you may use" block → `add_row` into it with its id AND key. Table missing → `builder_create_datatable({name, fields:[{name,type}]})` first'), 'lean table bullet');
    assert.ok(lean.includes('values = `{kind:"ref"}` bindings, one row per item via forEach over the extraction\'s `output.results`'), 'the bullet carries the write shape');
    assert.ok(lean.includes('tableId:{kind:"literal", value:"Facturen"}'), 'the Nextcloud tableId sentence is kept');
    assert.ok(lean.includes('Entries apply in order; if entry i fails, the entries before it STAY built'), 'partial-batch wording');
    assert.ok(!/It is atomic: one bad entry rolls the whole call back/.test(lean), 'atomic wording gone');
});

// ─── A8: the fan-out few-shot (list → read → extract → add_row) ─────────────
//
// The small profile (fewShots: 3) is the one that failed the invoice brief;
// it must see the chained-forEach shape and the datatable write. The count-1
// profiles keep the batched example alone — their cached prefix must not move.
console.log('buildFewShotMessages — fan-out example');

// The text the MODEL reads: tool names, tool-call arguments and tool echoes.
// The last two are JSON strings already, so they are joined as-is —
// JSON.stringify over the whole message list would re-escape their quotes
// (`\"type\":\"datatable\"`) and a quoted needle could never match, nor
// could its negation ever fail.
const fewShotText = (msgs) => msgs
    .map(m => (m.role === 'tool' ? m.content : (m.tool_calls || []).map(tc => `${tc.function.name} ${tc.function.arguments}`).join('\n')))
    .join('\n');

t('core toolset count=3 carries the invoice fan-out: extraction, datatable write, chained forEach', () => {
    const s = fewShotText(buildFewShotMessages(3, { toolset: 'core' }));
    for (const needle of ['"type":"data_extraction"', '"type":"datatable"', '"op":"add_row"', 'loop.r.output.content', 'steps.$extract.output.results']) {
        assert.ok(s.includes(needle), `small profile few-shots contain ${needle}`);
    }
});

t('full toolset count=1 is still the batched example alone — the fan-out never reaches the count-1 profiles', () => {
    // mid and reasoning (fewShots: 1) run the 'full' toolset; their cached
    // prefix must not move.
    for (const opts of [undefined, { toolset: 'full' }]) {
        const one = buildFewShotMessages(1, opts);
        const s = fewShotText(one);
        assert.ok(s.includes('builder_add_steps') && s.includes('gmail_search'), 'the batched example');
        assert.ok(!s.includes('"type":"datatable"') && !s.includes('nextcloud_list_files'), 'and nothing of the invoice example');
        // The invoice example is a strict INSERTION after the batched one: the
        // count-1 bytes are a prefix of the count-3 bytes.
        assert.deepStrictEqual(buildFewShotMessages(3, opts).slice(0, one.length), one, 'count=1 is a prefix of count=3');
    }
});

t('core toolset: fan-out, then the Dutch create-table shot, the Gmail digest LAST — so fewShots: 2 keeps the Dutch shot', () => {
    // 2026-09-18 (small-band diet): the digest (8k chars) teaches nothing the
    // fan-out does not, and the Dutch shot is the only one that shows
    // builder_create_datatable and a dry-run repair. The order lets the
    // builder_model_profiles `fewShots` knob trade the digest away first.
    const opts = { toolset: 'core' };
    const one = buildFewShotMessages(1, opts);
    const two = buildFewShotMessages(2, opts);
    const three = buildFewShotMessages(3, opts);
    assert.ok(fewShotText(one).includes('nextcloud_list_files'), 'count=1 is the fan-out');
    const second = fewShotText(two.slice(one.length));
    assert.ok(second.includes('builder_create_datatable') && second.includes('Inkomende facturen'), 'count=2 adds the Dutch create-table shot');
    assert.ok(!fewShotText(two).includes('gmail_search'), 'the digest is not in the first two');
    assert.ok(fewShotText(three.slice(two.length)).includes('gmail_search'), 'count=3 adds the digest last');
    assert.deepStrictEqual(three.slice(0, two.length), two, 'count=2 is a prefix of count=3');
    assert.deepStrictEqual(two.slice(0, one.length), one, 'count=1 is a prefix of count=2');
    // Same three shots as the full toolset, just reordered — nothing is lost.
    const briefs = (msgs) => msgs.filter(m => m.role === 'user').map(m => m.content).sort();
    assert.deepStrictEqual(briefs(three), briefs(buildFewShotMessages(3, { toolset: 'full' })));
});

// ─── 2026-09-17: the small-band diet, the naming rule, the dynamic catalog ──
console.log('lean prompt — diet, naming, catalog placement');

const { DROP_TOOLS_SMALL } = require('./builderTools/schemaProjection');
const { renderCatalogContextMessage } = require('./builderPrompt');

t('the lean prompt names no loop container, flowlet, switch or other tool the lean menu lacks', () => {
    const p = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true });
    for (const n of [...DROP_TOOLS_SMALL, 'builder_add_set', 'builder_add_form_page', 'builder_add_switch', 'builder_add_trigger', 'builder_create_layer', 'builder_add_call_layer', 'builder_generate_layer']) {
        assert.ok(!p.includes(n), `${n} is not taught`);
    }
    assert.ok(!/## Flowlets|## Additional triggers|delegate|Delegate/.test(p), 'the three removed sections are gone');
    assert.ok(/There is no loop container on this menu/.test(p), 'loop bullets rewritten');
    assert.ok(/## Placing steps/.test(p) && /## Triggers \(builder_propose_trigger/.test(p) && /## Naming/.test(p) && p.includes('## Plan\n'), 'the new sections');
    assert.ok(/NEVER propose nextcloud share\.created/.test(p), 'the trigger block is rendered into the prompt');
    assert.ok(/ONE `builder_update_step` per failing step/.test(p), 'dry-run repair is one update_step per failing step');
});

t('menu:"full" — the reasoning band reads the lean prose beside the FULL menu, so the prompt teaches what that menu serves', () => {
    // Before 2026-09-17 the lean prompt described the full menu; the diet
    // rewrote it for the 22-tool projection, and the reasoning band (lean
    // prose, full menu) was told "there is no loop container" beside
    // builder_add_loop. The menu parameter restores the full-menu sections.
    const lean = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true });
    const full = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true, menu: 'full' });
    assert.strictEqual(lean, buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true, menu: 'lean' }), 'lean is the default');
    assert.ok(!/There is no loop container/.test(full), 'the claim is not made beside builder_add_loop');
    assert.ok(/PREFER `forEach` ON THE STEP over a `loop` container/.test(full) && /A `loop` container is for the rare case/.test(full), 'the loop bullets say when the container is right');
    for (const n of ['builder_add_loop', 'builder_add_set', 'builder_add_form_page', 'builder_update_steps', 'builder_add_switch', 'builder_add_trigger', 'builder_create_layer', 'builder_set_layer_contract', 'builder_add_call_layer', 'builder_generate_layer', 'builder_generate_layers']) {
        assert.ok(full.includes(n), `full menu: ${n} is taught`);
    }
    assert.ok(/## Flowlets \(inline sub-flows\)/.test(full) && /## Additional triggers/.test(full) && /## Plan & delegate/.test(full), 'the three sections are back');
    assert.ok(/never a second builder_propose_trigger — that replaces the primary/.test(full), 'a second trigger goes through builder_add_trigger');
    assert.ok(/agent_call \| app_trigger/.test(full) && /`trigger\.id`/.test(full) && /Inside a flowlet these are NOT available/.test(full), 'the full trigger.kind sentence');
    assert.ok(/For a `switch`, pass `caseName`/.test(full), 'the switch rule');
    assert.ok(/ONE `builder_update_steps` call for the failing steps/.test(full), 'the batch update is the repair on the full menu');
    // What both menus share: the trigger block, the naming rule, the placing
    // rules and the one datatable bullet.
    for (const needle of ['## Triggers (builder_propose_trigger', '## Naming', '## Placing steps', 'DATATABLES. Table exists in the "Datatables you may use" block']) {
        assert.ok(full.includes(needle) && lean.includes(needle), `both menus: ${needle}`);
    }
    // Dynamic placement composes with either menu.
    const dyn = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true, menu: 'full', catalogPlacement: 'dynamic' });
    assert.ok(dyn.includes('## Flowlets') && !dyn.includes('## Catalog'), 'full menu + dynamic catalog');
});

t('the naming rule is in both variants, and the draft-state message opens with the title', () => {
    const lean = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true });
    const full = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    for (const [name, p] of [['lean', lean], ['full', full]]) {
        assert.ok(/FIRST reply on a new draft names the automation/.test(p), `${name}: first-reply rule`);
        assert.ok(/builder_set_metadata\(\{title, description\}\)/.test(p), `${name}: the call`);
        assert.ok(/"Untitled automation" is a defect/.test(p), `${name}: the defect sentence`);
    }
    assert.ok(full.includes('`builder_propose_trigger` + `builder_set_metadata`,\n            ALL in this one reply'), 'full: reply 1 carries the name');
    const named = renderDraftStateSystemMessage({ agentDraftState: 'MAIN FLOW: x', title: 'Facturen inlezen' });
    assert.ok(named.includes('Title: "Facturen inlezen"\n\nThis is the exact current contents'), 'title line first');
    const untitled = renderDraftStateSystemMessage({ agentDraftState: 'MAIN FLOW: x', title: 'Untitled automation' });
    assert.ok(untitled.includes('Title: (untitled — call builder_set_metadata in this reply)'), 'the default counts as untitled');
    assert.ok(renderDraftStateSystemMessage({ agentDraftState: 'MAIN FLOW: x', title: '  ' }).includes('Title: (untitled'), 'blank counts as untitled');
    assert.ok(!renderDraftStateSystemMessage({ agentDraftState: 'MAIN FLOW: x' }).includes('Title:'), 'no title argument → the old bytes');
});

t('lean + dynamic placement: a different catalogue, datatables or documents → the same bytes; the blocks move to the context message', () => {
    const other = { apps: [{ id: 'drive', label: 'Drive', available: true, actions: [{ name: 'drive_upload_file', description: 'Upload', sideEffect: true, inputSchema: { type: 'object', properties: { name: {} } } }] }], datatables: [FACTUREN], documents: [] };
    const a = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true, catalogPlacement: 'dynamic' });
    const b = buildLeanSystemPrompt({ catalog: other, codeStepEnabled: false, batchTools: true, catalogPlacement: 'dynamic' });
    assert.strictEqual(a, b, 'dynamic: the catalog never reaches the system prompt');
    // (gmail_search itself is named by the static Triggers block, so the
    // catalog LINE — with the action description — is the thing to look for.)
    assert.ok(!a.includes('## Catalog') && !a.includes('## Datatables you may use') && !a.includes('gmail_search [list] — Search Gmail'), 'none of the three blocks');
    assert.ok(a.includes('The catalog, your datatables and documents are in the message right before the user\'s — the ONLY tools/tables you may propose.'), 'the pointer');
    // 'system' (the default) still renders them, so the cloud bands' bytes are what they were.
    const sys = buildLeanSystemPrompt({ catalog: other, codeStepEnabled: false, batchTools: true });
    assert.ok(sys.includes('## Catalog (the ONLY tools you may propose)') && sys.includes('drive_upload_file') && sys.includes('tbl_1a2b3c') && sys.includes('## Documents you may fill'));
    assert.strictEqual(sys, buildLeanSystemPrompt({ catalog: other, codeStepEnabled: false, batchTools: true, catalogPlacement: 'system' }));
    // The context message carries exactly those blocks, catalog first.
    const ctx = renderCatalogContextMessage({ catalog: other });
    assert.ok(ctx.startsWith('## Catalog (the ONLY tools you may propose)\n\n### Drive (drive)'), 'catalog first');
    assert.ok(ctx.indexOf('## Datatables you may use') < ctx.indexOf('## Documents you may fill'), 'then tables, then documents');
    assert.ok(ctx.includes('excl_btw ("Excl. btw")'), 'the same renderer');
    assert.ok(renderCatalogContextMessage({ catalog: { apps: [] } }).includes('_(user has no integrations connected)_'));
    assert.ok(!renderCatalogContextMessage({ catalog: { apps: [], datatables: null } }).includes('## Datatables'), 'null renders nothing');
    assert.strictEqual(renderCatalogContextMessage({}), null);
});

// ─── BFSF-485 F4 + A3: a condition decides once; rules open as rows ──────────
console.log('condition doctrine');

t('both prompts say a condition decides ONCE and name the filter that keeps items', () => {
    const full = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(full.includes('A condition decides ONCE for the whole run; to keep the matching items\n  of a list use builder_add_filter'), 'full prompt doctrine line');
    const lean = buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true });
    assert.ok(lean.includes('A condition decides ONCE for the whole run; to keep the matching items of a list use `builder_add_array_op({op:"filter"})`'), 'lean prompt doctrine line');
});

t('the full prompt teaches the rule shapes; neither prompt filters with === or lower()', () => {
    const { CONDITION_RULES_HINT } = require('./builderTools/ruleExamples');
    const full = buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
    assert.ok(full.includes(CONDITION_RULES_HINT));
    for (const p of [full, buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false })]) {
        assert.ok(!p.includes("item.status === 'success'"), 'the forEach-failure filter is a row shape now');
        assert.ok(p.includes('expr:"equals(item.status, \\"success\\")"'));
        assert.ok(!/(lower|upper)\((item|trigger|steps)\./.test(p), 'no rule wraps a field in lower()/upper()');
    }
});

console.log(`\nbuilderPrompt.test.js: ${passed} assertions passed`);
