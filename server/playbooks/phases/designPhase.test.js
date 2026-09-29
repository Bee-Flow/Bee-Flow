/**
 * The designer phase: a designer's brief (no tool names), a clamped design
 * document, and the words the builder reads from it.
 *
 * Run: node --test --test-force-exit playbooks/phases/designPhase.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('./designPhase');

const TABLE = { name: 'Facturen', fields: [{ key: 'datum', name: 'Datum', type: 'date' }, { key: 'totaal', name: 'Totaal', type: 'number' }], rowCount: 32 };
const RAW = {
    name: 'Facturen', tagline: 'Alle facturen in één oogopslag',
    look: { preset: 'cloud', accent: '#1E7F4F', mood: 'kalm, precies, warm' },
    screens: [
        { name: 'Overzicht', purpose: 'Het totaal zien', sections: [{ title: 'Kerncijfers', layout: 'row', elements: [{ kind: 'stat', label: 'Aantal', note: 'count' }, { kind: 'chart', label: 'Per maand', note: 'totaal over datum' }, { kind: 'wizard', label: 'Raar' }] }, { title: 'Leeg', elements: [] }] },
        { name: 'Factuur', sections: [{ title: 'Details', elements: [{ kind: 'detail', label: 'Factuur' }, { kind: 'button', label: 'Ter goedkeuring' }] }] },
    ],
    principles: ['Eén accentkleur', '', 'Ruimte'],
};

test('the designer never hears a tool name; the brief carries goal, columns, count, sample rows and the approvals flag', () => {
    const sys = D.designerPrompt('nl');
    assert.doesNotMatch(sys, /app_|data_grid|filter_bar|tool call arguments/i);
    assert.match(sys, /MODERN, CLEAN/);
    assert.match(sys, /Dutch/);
    const msg = D.designerUserMessage({ goal: 'Een factuur-app', table: TABLE, sampleRows: [{ datum: '2026-09-01', totaal: 1554.25, secret: 'x' }], approvals: true, locale: 'nl' });
    assert.match(msg, /Goal of the app: Een factuur-app/);
    assert.match(msg, /"Facturen" with columns Datum \(key `datum`, date\), Totaal \(key `totaal`, number\); 32 rows today/);
    assert.match(msg, /Sample rows \(shapes, not real values[^)]*\): \[\{"datum":"2026-09-01","totaal":"1554.25"\}\]/);
    assert.doesNotMatch(msg, /secret/);
    assert.match(msg, /Approval flow later: yes — a person approves or rejects a record in Studio → Approvals; the app only shows the status/);
});

test('normaliseDesign clamps: unknown element kinds become text, empty sections drop, the accent is validated, the preset falls back', () => {
    const d = D.normaliseDesign(RAW);
    assert.equal(d.look.accent, '#1e7f4f');
    assert.equal(d.look.preset, 'cloud');
    assert.deepEqual(d.screens.map((s) => s.sections.length), [1, 1]);
    assert.deepEqual(d.screens[0].sections[0].elements.map((e) => e.kind), ['stat', 'chart', 'text']);
    assert.deepEqual(d.principles, ['Eén accentkleur', 'Ruimte']);
    const weird = D.normaliseDesign({ name: 'x', look: { preset: 'neon', accent: 'purple' }, screens: [{ name: 'S', sections: [{ title: 'T', elements: [{ kind: 'stat', label: 'A' }] }] }] });
    assert.deepEqual(weird.look, { preset: 'cloud', accent: '#1e7f4f', mood: '' });
});

test('designToBrief speaks the builder\'s words, starts with the theme call, stays under its cap', () => {
    const text = D.designToBrief(D.normaliseDesign(RAW));
    assert.match(text, /^## DESIGN\nFollow this; where it differs from the screens above, THIS wins\. Call `app_set_theme \{preset:"cloud", primary:"#1e7f4f"\}` first — mood: kalm, precies, warm\./);
    assert.match(text, /### Screen "Overzicht" — Het totaal zien\n- \*\*Kerncijfers\*\*: stat "Aantal" \(count\), chart "Per maand" \(totaal over datum\), text "Raar" — /);
    assert.match(text, /record_detail "Factuur", button "Ter goedkeuring"/);
    assert.match(text, /\*\*Principles:\*\* Eén accentkleur; Ruimte\./);
    assert.ok(text.length <= D.MAX_DESIGN_BRIEF_CHARS);
    const huge = D.normaliseDesign({ name: 'x', look: {}, screens: Array.from({ length: 6 }, (_, i) => ({ name: `S${i}`, purpose: 'p'.repeat(160), sections: Array.from({ length: 6 }, (__, j) => ({ title: `T${j}`, elements: Array.from({ length: 8 }, (___, k) => ({ kind: 'stat', label: `L${k}`, note: 'n'.repeat(160) })) })) })) });
    assert.ok(D.designToBrief(huge).length <= D.MAX_DESIGN_BRIEF_CHARS);
    assert.equal(D.designToBrief(null), '');
});

test('runDesignPhase: one forced call at temperature 0.2 (0.7 only when redrawing); artifacts + summary; empty and dead answers are coded failures', async () => {
    const calls = [];
    const deps = { resolveModel: async () => 'fast', chatForcedTool: async (m, msgs, tool, opts) => { calls.push({ m, msgs, tool, opts }); return { structured: RAW }; } };
    const out = await D.runDesignPhase({ goal: 'Een factuur-app', table: TABLE, sampleRows: [], approvals: false, locale: 'nl' }, deps);
    assert.equal(out.ok, true);
    assert.equal(calls[0].tool, D.DESIGN_TOOL);
    // The hardest JSON shape in the feature is sampled tightly, like every other
    // playbook call. A REDRAW may wander — it has a design to anchor it.
    assert.equal(calls[0].opts.temperature, 0.2);
    assert.ok(calls[0].opts.timeoutMs > 0, 'the call has a budget, so a wedged model fails the phase instead of hanging it');
    await D.runDesignPhase({ goal: 'g', table: TABLE, locale: 'nl', feedback: 'anders', previousDesign: RAW }, deps);
    assert.equal(calls[1].opts.temperature, 0.7);
    assert.deepEqual([out.artifacts.designName, out.artifacts.screenCount, out.artifacts.elementCount], ['Facturen', 2, 5]);
    assert.match(out.summary, /Ontwerp "Facturen": 2 schermen, 5 elementen, look cloud\./);
    assert.equal((await D.runDesignPhase({ goal: 'g' }, { resolveModel: async () => 'm', chatForcedTool: async () => ({ structured: null }) })).code, 'design_empty');
    // resolveModelForTierName RETURNS null when no model is configured; that has
    // to be named here, not handed on to the provider factory.
    assert.equal((await D.runDesignPhase({ goal: 'g' }, { resolveModel: async () => null, chatForcedTool: async () => ({ structured: RAW }) })).code, 'model_unavailable');
    assert.equal((await D.runDesignPhase({ goal: 'g' }, { resolveModel: async () => 'm', chatForcedTool: async () => { throw new Error('down'); } })).code, 'design_failed');
    assert.equal((await D.runDesignPhase({ goal: '' }, deps)).code, 'goal_missing');
});

test('the designer is asked for the interface language, and says so in it', async () => {
    assert.match(D.designerPrompt('en'), /Every label, screen name and note in English/);
    assert.match(D.designerUserMessage({ goal: 'An invoice app', table: TABLE, approvals: false, locale: 'en' }), /Language of the app: English\./);
    // A language we ship no copy for is still named to the model.
    assert.match(D.designerPrompt('de'), /in German/);
    const deps = { resolveModel: async () => 'fast', chatForcedTool: async () => ({ structured: RAW }) };
    const out = await D.runDesignPhase({ goal: 'An invoice app', table: TABLE, locale: 'en' }, deps);
    assert.equal(out.summary, 'Design "Facturen": 2 screens, 5 elements, look cloud.');
    // A screen the model left unnamed is named in the demo's language.
    assert.equal(D.normaliseDesign({ name: 'x', look: {}, screens: [{ sections: [{ title: 'T', elements: [{ kind: 'stat', label: 'A' }] }] }] }, 'en').screens[0].name, 'Screen');
    assert.equal(D.normaliseDesign({ name: 'x', look: {}, screens: [{ sections: [{ title: 'T', elements: [{ kind: 'stat', label: 'A' }] }] }] }).screens[0].name, 'Scherm');
});

test('a revision hands the designer the design that stands plus the one change, and asks for the whole thing back', () => {
    const previous = D.normaliseDesign(RAW);
    const msg = D.designerUserMessage({ goal: 'Een factuur-app', table: TABLE, approvals: false, locale: 'nl', feedback: 'Geef elke leverancier een eigen scherm', previousDesign: previous });
    assert.match(msg, /The design you made earlier:/);
    assert.match(msg, /Screen "Overzicht" — Het totaal zien: Kerncijfers: stat "Aantal" \(count\)/, 'the recap speaks the DESIGNER\'s words, not the builder\'s');
    assert.doesNotMatch(msg, /data_grid|record_detail/);
    assert.match(msg, /The person asks for this change: Geef elke leverancier een eigen scherm/);
    assert.match(msg, /Return the complete revised design — keep everything they did not ask to change\./);
    assert.match(D.designerPrompt('nl'), /return the COMPLETE design again/);
    // No feedback, no recap: a first design is never handed an earlier one.
    assert.doesNotMatch(D.designerUserMessage({ goal: 'g', table: TABLE, approvals: false, locale: 'nl', previousDesign: previous }), /The design you made earlier/);
});

test('the designer is bound by what the person asked and by the brief the builder will get', () => {
    const msg = D.designerUserMessage({
        goal: 'Een factuur-app', table: TABLE, approvals: false, locale: 'en',
        ask: 'Also i want a comprehensive dashboard. Just one screen in the app.',
        builderBrief: 'Call app_set_plan first, then app_link_datatable {datatableId:"tbl_1"}. Create one screen: "Dashboard".',
    });
    assert.match(msg, /What the person asked for, in their own words/);
    assert.match(msg, /Just one screen in the app\./);
    assert.match(msg, /The builder will be told this, and your design has to fit inside it/);
    assert.match(msg, /Create one screen: "Dashboard"\./);
    // The rule that makes it stick.
    assert.match(D.designerPrompt('en'), /"One screen" means ONE screen, with everything on it/);
    // Both arrive WHOLE. The brief is capped at the same number the document
    // writer enforces on a rendered brief (1200) and the ask at what the route
    // stores (2000) — cutting either at 700 meant the designer designed inside
    // a brief whose last screen it had never seen.
    const long = D.designerUserMessage({ goal: 'g', table: TABLE, approvals: false, locale: 'en', ask: 'x'.repeat(2500), builderBrief: 'y'.repeat(2500) });
    assert.ok(long.includes('y'.repeat(1200)), 'the whole rendered brief reaches the designer');
    assert.ok(long.includes('x'.repeat(2000)), 'the whole stored ask reaches the designer');
    assert.ok(long.length < 4200, `still bounded: ${long.length}`);
    // Nothing said, nothing added.
    const bare = D.designerUserMessage({ goal: 'g', table: TABLE, approvals: false, locale: 'en' });
    assert.doesNotMatch(bare, /in their own words|The builder will be told/);
});


test('the design block speaks only words the app builder accepts, and says how wide things sit', (t) => {
    const { COMPONENT_TYPES } = require('../../appStudio/componentSpecs');
    const real = new Set(COMPONENT_TYPES);
    // EVERY word in the map, against the real catalog. The phase cannot look
    // for itself (playbooks/ may not require appStudio/), so the route runs
    // this at load and this test pins it in CI. A stale word is named on the
    // console and returned by its map key; no catalog is no verdict.
    const warn = t.mock.method(console, 'warn', () => {});
    assert.deepStrictEqual(D.checkElementWords(COMPONENT_TYPES), []);
    assert.strictEqual(warn.mock.callCount(), 0, 'a sound map is silent');
    assert.deepStrictEqual(D.checkElementWords(COMPONENT_TYPES.filter((x) => x !== 'data_grid')), ['table'], 'a missing type is reported by its map key');
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /ELEMENT_WORDS\.table = "data_grid"/);
    assert.deepStrictEqual(D.checkElementWords([]), [], 'no catalog, no verdict');
    // The block tells the builder the design OUTRANKS the brief, so every word
    // in it has to be a type the builder will take verbatim. "stat tile" was
    // not one.
    const brief = D.designToBrief(D.normaliseDesign({
        name: 'X', look: { preset: 'cloud', accent: '#1e7f4f' },
        screens: [{
            name: 'S',
            sections: [
                { title: 'Top', layout: 'row', elements: [{ kind: 'stat', label: 'A' }, { kind: 'table', label: 'B' }] },
                { title: 'Side', layout: 'split', elements: [{ kind: 'detail', label: 'C' }] },
            ],
        }],
    }));
    for (const word of ['stat', 'data_grid', 'record_detail']) {
        assert.ok(real.has(word), `${word} is not a real component type`);
        assert.ok(brief.includes(word), `${word} missing from the block`);
    }
    assert.ok(!brief.includes('stat tile'), 'the invented name is gone');
    // The layout was normalised and then never emitted, so "four across" always
    // arrived as a stack.
    assert.match(brief, /3 columns each/);
    assert.match(brief, /8 and 4 columns/);
});

test('an over-long design block is cut on a line boundary, never mid-instruction', () => {
    const screens = Array.from({ length: 6 }, (_, i) => ({
        name: `Screen ${i}`,
        purpose: 'p'.repeat(150),
        sections: Array.from({ length: 6 }, () => ({
            title: 'T'.repeat(50),
            layout: 'stack',
            elements: Array.from({ length: 8 }, (_, k) => ({ kind: 'text', label: `L${k}`, note: 'n'.repeat(150) })),
        })),
    }));
    const brief = D.designToBrief(D.normaliseDesign({ name: 'X', look: { preset: 'cloud', accent: '#1e7f4f' }, screens }));
    assert.ok(brief.length <= D.MAX_DESIGN_BRIEF_CHARS, `${brief.length} over the cap`);
    assert.ok(!brief.endsWith('…'), 'no mid-token ellipsis');
    // Whole lines only: the last line is a complete bullet or heading.
    const last = brief.split('\n').filter(Boolean).pop();
    assert.ok(/^(#|-|\*\*|Follow this)/.test(last) || last.endsWith('.'), `cut mid-line: ${JSON.stringify(last.slice(-60))}`);
});


test('the designer is shown the SHAPE of a row, never the personal values in it', () => {
    // It is choosing screens, not reading records — and this was the only
    // playbook call that sent real values off the customer's table anywhere.
    const fields = [
        { key: 'leverancier', name: 'Leverancier', type: 'text' },
        { key: 'email', name: 'E-mail', type: 'text' },
        { key: 'totaal', name: 'Totaal', type: 'number' },
    ];
    const msg = D.designerUserMessage({
        goal: 'g', approvals: false, locale: 'en',
        table: { name: 'Facturen', fields, rowCount: 32 },
        sampleRows: [{ leverancier: 'ACME BV', email: 'jan@acme.nl', totaal: 1554.25 }],
    });
    assert.doesNotMatch(msg, /ACME BV/);
    assert.doesNotMatch(msg, /jan@acme\.nl/);
    // The kind still reaches it, so it knows what the column IS…
    assert.match(msg, /<supplier>/);
    assert.match(msg, /<email>/);
    // …and a column that is not personal data is untouched, so the shape is real.
    assert.match(msg, /1554\.25/);
    // The detector is the shared one, so the two cannot disagree.
    assert.deepEqual(
        D.redactPersonal([{ totaal: 1 }], [{ key: 'totaal', name: 'Totaal' }]),
        [{ totaal: 1 }],
    );
});

test('the designer redacts with the ONE detector, not with a copy of it', () => {
    // "Which columns hold personal data" was answered in three places with
    // three vocabularies, and this phase borrowed the compliance phase's copy
    // of it — a require between two files of one feature, over a question
    // neither of them owns. It lives in core now, so the designer cannot
    // redact a column the review would not flag, or send one it would.
    const fields = [{ key: 'iban', name: 'IBAN' }];
    assert.deepEqual(D.redactPersonal([{ iban: 'NL12INGB0001234567' }], fields), [{ iban: '<financial>' }]);
    assert.deepEqual(
        require('../../core/privacy/personalColumns').byName(fields).map((c) => c.kind),
        ['financial'],
        'the same answer the review reads',
    );

    // Real module graph, not a require string: redactPersonal() is called
    // above, which is when its lazy require actually resolves, so this checks
    // what designPhase.js ACTUALLY loaded rather than what it happens to say.
    const detectorPath = require.resolve('../../core/privacy/personalColumns');
    const compliancePhasePath = require.resolve('./compliancePhase');
    const children = require.cache[require.resolve('./designPhase')].children.map((c) => c.id);
    assert.ok(children.includes(detectorPath), 'redactPersonal must load the shared detector');
    assert.ok(!children.includes(compliancePhasePath), 'and never the compliance phase\'s own copy');
});

test('"only a dashboard" becomes a binding SCREENS line for the designer, and an extra detail screen is folded away when it comes back anyway', async () => {
    const calls = [];
    const deps = { resolveModel: async () => 'fast', chatForcedTool: async (m, msgs) => { calls.push(msgs); return { structured: RAW }; } };
    const out = await D.runDesignPhase({ goal: 'Een factuur-app', table: TABLE, locale: 'nl', ask: 'Maak alleen een data-insight dashboard van de facturen.' }, deps);
    // Stated to the designer, right after the person's words.
    const user = calls[0][1].content;
    assert.match(user, /in their own words[^\n]*Maak alleen een data-insight dashboard/);
    assert.match(user, /\nSCREENS \(binding, from the person's own words "alleen een data-insight dashboard"\): exactly ONE screen/);
    // Enforced on the design: RAW has "Overzicht" + a "Factuur" detail screen.
    assert.equal(out.ok, true);
    assert.equal(out.artifacts.screenCount, 1);
    assert.equal(out.artifacts.design.screens[0].name, 'Overzicht');
    assert.ok(!out.artifacts.design.screens[0].sections.some((s) => s.elements.some((e) => e.kind === 'detail')), 'the detail element is gone');
    assert.deepEqual(out.artifacts.constraintChanges, ['dropped 1 detail element', 'folded 1 extra screen ("Factuur") into "Overzicht" — 1 section moved']);
    assert.equal(out.artifacts.design.constraints.screens, 1);
    // stat + chart + text from "Overzicht", plus the button that came along from "Factuur".
    assert.match(out.summary, /Ontwerp "Facturen": 1 scherm, 4 elementen, look cloud\. Teruggebracht tot 1 scherm, zoals gevraagd\.$/);
    // …and repeated to the app builder in the design block, so it cannot add the screen back.
    const brief = D.designToBrief(out.artifacts.design);
    assert.doesNotMatch(brief, /### Screen "Factuur"|record_detail/);
    assert.match(brief, /\*\*SCREENS \(binding[^\n]*exactly ONE screen[^\n]*\*\*$/);
    // Nothing said → nothing constrained, the design stands as drawn.
    const free = await D.runDesignPhase({ goal: 'Een factuur-app', table: TABLE, locale: 'nl', ask: 'Ik wil de facturen kunnen bekijken.' }, deps);
    assert.equal(free.artifacts.screenCount, 2);
    assert.equal(free.artifacts.design.constraints, undefined);
    assert.doesNotMatch(calls[1][1].content, /SCREENS \(binding/);
});

test('on a revision the newest words decide: "add a detail screen" lifts the constraint the standing design was made under', async () => {
    const calls = [];
    const deps = { resolveModel: async () => 'fast', chatForcedTool: async (m, msgs) => { calls.push(msgs); return { structured: RAW }; } };
    const standing = { ...D.normaliseDesign(RAW), constraints: { screens: 1, exact: true, noDetail: false, source: 'only a dashboard' } };
    const kept = await D.runDesignPhase({ goal: 'g', table: TABLE, locale: 'en', ask: 'only a dashboard', feedback: 'Make the accent blue.', previousDesign: standing }, deps);
    assert.equal(kept.artifacts.screenCount, 1, 'a change that says nothing about screens keeps the one-screen rule');
    assert.match(calls[0][1].content, /SCREENS \(binding/);
    const lifted = await D.runDesignPhase({ goal: 'g', table: TABLE, locale: 'en', ask: 'only a dashboard', feedback: 'Add a detail page for one invoice.', previousDesign: standing }, deps);
    assert.equal(lifted.artifacts.screenCount, 2);
    assert.equal(lifted.artifacts.design.constraints, undefined);
});

// The provider's own words reached the person: `The model could not be
// reached: ${e.message}` went into the 422 AND into the phase's stored
// `error`, so an internal host and port stayed on the playbook row. So did a
// config store's error when the model could not be looked up. Compose was
// fixed first (composeRecipe.test.js); the designer answers the same way now.
test('an unreachable designer is a fixed sentence and a correlation id; the error itself goes to the log under that id', async () => {
    const { runWithRequestId } = require('../../telemetry/log');
    const leak = 'connect ECONNREFUSED 10.20.30.40:8080 (upstream llama-box-3)';
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    let out;
    let lookup;
    try {
        out = await runWithRequestId('req-4711', () => D.runDesignPhase({ goal: 'g' }, { resolveModel: async () => 'local-model', chatForcedTool: async () => { throw new Error(leak); } }));
        lookup = await runWithRequestId('req-4712', () => D.runDesignPhase({ goal: 'g' }, { resolveModel: async () => { throw new Error('connect ECONNREFUSED 10.9.9.9:5432'); }, chatForcedTool: async () => ({ structured: RAW }) }));
    } finally { console.error = orig; }
    assert.equal(out.ok, false);
    assert.equal(out.code, 'design_failed');
    assert.equal(out.error, 'The model could not be reached. Try again in a moment.');
    assert.equal(out.correlationId, 'req-4711');
    assert.doesNotMatch(JSON.stringify(out), /10\.20\.30\.40|ECONNREFUSED|llama-box/);
    const logged = lines.find((l) => l.includes('correlationId=req-4711'));
    assert.ok(logged, `logged under the id: ${JSON.stringify(lines)}`);
    assert.match(logged, /ECONNREFUSED 10\.20\.30\.40:8080/, 'the operator still reads what happened');
    assert.match(logged, /local-model/);

    assert.equal(lookup.code, 'model_unavailable');
    assert.equal(lookup.correlationId, 'req-4712');
    assert.doesNotMatch(JSON.stringify(lookup), /10\.9\.9\.9|ECONNREFUSED/);
    assert.ok(lines.some((l) => l.includes('correlationId=req-4712') && /10\.9\.9\.9:5432/.test(l)), 'the lookup failure is logged under its id');
});
