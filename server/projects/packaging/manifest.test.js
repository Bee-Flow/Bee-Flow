/**
 * The Blueprint format.
 *
 * The rule that carries the feature: a pointer at something INSIDE the bundle
 * becomes a `{ $ref }` and survives the trip, while a pointer at something
 * outside keeps the old null-and-report behaviour. Every other packaging path
 * in this product nulls both, which is right for shipping one thing and fatal
 * for shipping a set of things built to call each other — the app arrives no
 * longer knowing which automation it runs, and the install is inert.
 *
 * The order those two halves run in is the other load-bearing detail: rewrite
 * first, scrub second, so the scrub only ever sees what could not be resolved
 * locally.
 *
 * Run: cd server && node --test projects/packaging/manifest.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    FORMAT, SCHEMA_VERSION, assignRefs, rewriteToRefs, collectRefs,
    buildManifest, sanitizeManifest, ENTITY_KINDS, REF_PREFIX,
    readSource, withSource,
} = require('./manifest');
const { scrubAppDefinition } = require('./scrub');

// ═══ References ══════════════════════════════════════════════════════

test('refs are positional, so a Blueprint says nothing about the ids that made it', () => {
    const refs = assignRefs({
        automations: [{ id: 'aut_9f3a' }, { id: 'aut_bbb' }],
        apps: [{ id: 'app_secret_looking_id' }],
        webpages: [{ id: 'web_zzz' }],
    });
    assert.deepStrictEqual([...refs.values()], ['aut_1', 'aut_2', 'app_1', 'web_1']);
});

test('an in-bundle automation reference becomes a $ref', () => {
    const refs = assignRefs({ automations: [{ id: 'aut_live' }] });
    const definition = { actions: { go: { kind: 'run_automation', automationId: 'aut_live' } } };
    const rewritten = rewriteToRefs({ appDefinition: definition }, refs);

    assert.deepStrictEqual(definition.actions.go.automationId, { $ref: 'aut_1' });
    assert.deepStrictEqual(rewritten, [{ from: 'aut_live', ref: 'aut_1' }]);
});

test('an OUT-of-bundle reference is left for the scrub to null', () => {
    const refs = assignRefs({ automations: [{ id: 'aut_here' }] });
    const definition = { actions: { go: { kind: 'run_automation', automationId: 'aut_elsewhere' } } };
    rewriteToRefs({ appDefinition: definition }, refs);
    assert.strictEqual(definition.actions.go.automationId, 'aut_elsewhere', 'untouched by the rewrite');
});

test('rewrite THEN scrub: in-bundle survives, outside is nulled', () => {
    // This ordering is the whole design. Reversed, the scrub would null the
    // in-bundle pointer first and there would be nothing left to rewrite.
    const refs = assignRefs({ automations: [{ id: 'aut_here' }] });
    const definition = {
        actions: {
            inside: { kind: 'run_automation', automationId: 'aut_here' },
            outside: { kind: 'run_automation', automationId: 'aut_elsewhere' },
        },
    };
    rewriteToRefs({ appDefinition: definition }, refs);
    const report = scrubAppDefinition(definition);

    assert.deepStrictEqual(definition.actions.inside.automationId, { $ref: 'aut_1' }, 'survives the trip');
    assert.strictEqual(definition.actions.outside.automationId, null, 'reported as a dependency instead');
    assert.strictEqual(report.length, 1, 'and only the external one is reported');
});

test('call_block and the webpage bridge take refs too', () => {
    const refs = assignRefs({ automations: [{ id: 'blk_1' }, { id: 'aut_x' }] });
    const automationDefinition = { steps: [{ id: 's1', type: 'call_block', blockId: 'blk_1' }] };
    const webpageBridgeGrants = { automations: [{ automationId: 'aut_x', label: 'Run it' }] };

    rewriteToRefs({ automationDefinition }, refs);
    rewriteToRefs({ webpageBridgeGrants }, refs);

    assert.deepStrictEqual(automationDefinition.steps[0].blockId, { $ref: 'aut_1' });
    assert.deepStrictEqual(webpageBridgeGrants.automations[0].automationId, { $ref: 'aut_2' });
    assert.strictEqual(webpageBridgeGrants.automations[0].label, 'Run it', 'the label is not a reference');
});

test('refs nested in layers, loops and branches are all rewritten', () => {
    const refs = assignRefs({ automations: [{ id: 'blk' }] });
    const definition = {
        steps: [
            { id: 'l', type: 'loop', body: [{ id: 'a', type: 'call_block', blockId: 'blk' }] },
            { id: 'p', type: 'parallel', branches: [[{ id: 'b', type: 'call_block', blockId: 'blk' }]] },
        ],
        layers: { enrich: { steps: [{ id: 'c', type: 'call_block', blockId: 'blk' }] } },
    };
    rewriteToRefs({ automationDefinition: definition }, refs);
    assert.ok(!JSON.stringify(definition).includes('"blk"'));
    assert.strictEqual(JSON.stringify(definition).split('aut_1').length - 1, 3);
});

test('collectRefs finds every reference the entities actually use', () => {
    const manifest = buildManifest({
        project: { id: 'p1' },
        entities: {
            apps: [{ ref: 'app_1', definition: { actions: { go: { automationId: { $ref: 'aut_1' } } } } }],
            webpages: [{ ref: 'web_1', bridgeGrants: { automations: [{ automationId: { $ref: 'aut_2' } }] } }],
        },
    });
    assert.deepStrictEqual([...collectRefs(manifest)].sort(), ['aut_1', 'aut_2']);
});

// ═══ The envelope ════════════════════════════════════════════════════

test('a manifest is a pure function of its inputs', () => {
    const args = {
        project: { id: 'p1', name: 'Onboarding', description: 'd', icon: '📁', color: '#fff', customInstructions: 'ci' },
        entities: { automations: [{ ref: 'aut_1' }] },
        requires: [{ kind: 'approver', count: 2 }],
        report: { warnings: [] },
        exportedAt: '2026-08-23T00:00:00Z',
    };
    // No clock read inside, so the whole thing can be asserted.
    assert.deepStrictEqual(buildManifest(args), buildManifest(args));
    const m = buildManifest(args);
    assert.strictEqual(m.format, FORMAT);
    assert.strictEqual(m.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(m.solution.name, 'Onboarding');
    assert.strictEqual(m.solution.key, 'sol_p1');
    assert.strictEqual(m.solution.version, 1);
});

test('there is no approvals array — a decision is not data that travels', () => {
    const m = buildManifest({ project: { id: 'p1' } });
    // The list grows with what a Solution can hold, and this assertion is meant
    // to break when it does: a new entity kind must be a decision somebody made
    // here, not a key that appeared because a capture happened to emit it.
    assert.deepStrictEqual(Object.keys(m.solution.entities).sort(),
        ['agents', 'apps', 'automations', 'datatables', 'documents', 'knowledgeBases', 'skills', 'webpages']);
    assert.strictEqual(m.solution.entities.approvals, undefined);
});

// ═══ Reading one back ════════════════════════════════════════════════

test('a foreign or future file is refused, with the reason', () => {
    assert.strictEqual(sanitizeManifest(null).ok, false);
    assert.match(sanitizeManifest({ format: 'something.else' }).errors.join(' '), /Expected a beeflow\.blueprint file/);
    assert.match(
        sanitizeManifest({ format: FORMAT, schemaVersion: 99, solution: {} }).errors.join(' '),
        /version 99 is not supported/,
    );
});

test('a dangling $ref is refused rather than repaired', () => {
    // Repairing would install a set of entities that do not know about each
    // other — the exact failure the format exists to prevent, and silent.
    const bad = buildManifest({
        project: { id: 'p1' },
        entities: { apps: [{ ref: 'app_1', definition: { go: { $ref: 'aut_7' } } }] },
    });
    const result = sanitizeManifest(bad);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join(' '), /points at "aut_7", which it does not contain/);
});

test('a self-consistent Blueprint reads back clean', () => {
    const good = buildManifest({
        project: { id: 'p1', name: 'Onboarding' },
        entities: {
            automations: [{ ref: 'aut_1', title: 'Nightly' }],
            apps: [{ ref: 'app_1', definition: { go: { $ref: 'aut_1' } } }],
        },
    });
    const result = sanitizeManifest(good);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual([...result.refs].sort(), ['app_1', 'aut_1']);
});

// ═══ Every kind a Solution can hold gets a ref of its own ════════════

test('each entity kind has its own ref prefix, and they are all distinct', () => {
    // A shared prefix would make `dt_1` and `agt_1` collide in refByEntityId,
    // and the symptom would be an app wired to the wrong thing after install.
    const prefixes = ENTITY_KINDS.map(k => REF_PREFIX[k]);
    for (const [i, kind] of ENTITY_KINDS.entries()) {
        assert.strictEqual(typeof prefixes[i], 'string', `${kind} has a prefix`);
    }
    assert.strictEqual(new Set(prefixes).size, prefixes.length, 'no two kinds share one');
});

test('refs are positional per kind, so no real id survives', () => {
    const refs = assignRefs({
        automations: [{ id: 'aut_REAL' }],
        datatables: [{ id: 'tbl_REAL' }, { id: 'tbl_TWO' }],
        agents: [{ id: 'agt_REAL' }],
        knowledgeBases: [{ id: 'kb_REAL' }],
        skills: [{ id: 'skl_REAL' }, { id: 'skl_TWO' }],
        documents: [{ id: 'doc_REAL' }],
    });
    assert.strictEqual(refs.get('aut_REAL'), 'aut_1');
    assert.strictEqual(refs.get('tbl_REAL'), 'dt_1');
    assert.strictEqual(refs.get('tbl_TWO'), 'dt_2');
    assert.strictEqual(refs.get('agt_REAL'), 'agt_1');
    assert.strictEqual(refs.get('kb_REAL'), 'kb_1');
    assert.strictEqual(refs.get('skl_REAL'), 'skl_1');
    assert.strictEqual(refs.get('skl_TWO'), 'skl_2');
    assert.strictEqual(refs.get('doc_REAL'), 'doc_1');
});

test('skills and document templates are entity kinds with the skl and doc prefixes', () => {
    assert.ok(ENTITY_KINDS.includes('skills') && ENTITY_KINDS.includes('documents'));
    assert.strictEqual(REF_PREFIX.skills, 'skl');
    assert.strictEqual(REF_PREFIX.documents, 'doc');
    const m = buildManifest({
        project: { id: 'p1' },
        entities: {
            skills: [{ ref: 'skl_1', name: 'Tone', knowledge_base_ids: [{ $ref: 'kb_1' }] }],
            documents: [{ ref: 'doc_1', name: 'Offer', body_html: '<p>x</p>' }],
            knowledgeBases: [{ ref: 'kb_1', name: 'Handbook' }],
            automations: [{ ref: 'aut_1', definition: { steps: [{ type: 'fill_document', documentId: { $ref: 'doc_1' } }] } }],
        },
    });
    const checked = sanitizeManifest(m);
    assert.strictEqual(checked.ok, true);
    assert.ok(checked.refs.has('skl_1') && checked.refs.has('doc_1'));
    assert.deepStrictEqual([...collectRefs(m)].sort(), ['doc_1', 'kb_1']);
});

test('a $ref to a skill or template the file does not carry is refused', () => {
    const m = buildManifest({
        project: { id: 'p1' },
        entities: { agents: [{ ref: 'agt_1', config: { attachedSkillIds: [{ $ref: 'skl_9' }] } }] },
    });
    assert.match(sanitizeManifest(m).errors.join(' '), /"skl_9"/);
    const slotted = buildManifest({ project: { id: 'p1' }, entities: {}, slots: [{ slot: 'x', kind: 'k', ref: 'doc_1' }] });
    assert.match(sanitizeManifest(slotted).errors.join(' '), /doc_1/);
});

test('a manifest from before skills and templates existed still reads', () => {
    const m = buildManifest({ project: { id: 'p1' }, entities: { automations: [{ ref: 'aut_1' }] } });
    delete m.solution.entities.skills;
    delete m.solution.entities.documents;
    m.schemaVersion = 1;
    assert.strictEqual(sanitizeManifest(m).ok, true);
});

test('a $ref into a NEW entity list resolves, instead of reading as dangling', () => {
    const m = buildManifest({
        project: { id: 'p1' },
        entities: {
            agents: [{ ref: 'agt_1', name: 'A' }],
            apps: [{ ref: 'app_1', definition: { x: { $ref: 'agt_1' } } }],
        },
    });
    const checked = sanitizeManifest(m);
    assert.strictEqual(checked.ok, true, 'the declared set covers every list, not only the first three');
    assert.ok(checked.refs.has('agt_1'));
});

// ═══ The two key classes that can never be installed ═════════════════

const withGrants = (bridgeGrants) => buildManifest({
    project: { id: 'p1' },
    entities: { webpages: [{ ref: 'web_1', name: 'Status', bridgeGrants }] },
});

test('EVERY ai.public key is stripped — including one invented next year', () => {
    // Matched by SHAPE, not by a list of names. The invented key below is the
    // whole point: the rule has to cover a field bridgeGrants gains after this
    // test was written.
    const checked = sanitizeManifest(withGrants({
        ai: {
            enabled: true, groundOnPage: true,
            publicEnabled: true, publicSpendCapUsd: 50, publicDefaultTier: 'deep',
            public_iets_nieuws: 'LEAK-CANARY',
        },
    }));
    assert.strictEqual(checked.ok, true);
    const ai = checked.manifest.solution.entities.webpages[0].bridgeGrants.ai;
    assert.deepStrictEqual(ai, { enabled: true, groundOnPage: true });
    assert.ok(!JSON.stringify(checked.manifest).includes('LEAK-CANARY'));
});

test('fixedArgs is stripped wherever it sits, however deep', () => {
    const checked = sanitizeManifest(buildManifest({
        project: { id: 'p1' },
        entities: {
            apps: [{ ref: 'app_1', definition: { screens: [{ children: [{ call: { tool: 't', fixedArgs: { token: 'LEAK-CANARY' } } }] }] } }],
            webpages: [{ ref: 'web_1', bridgeGrants: { integrations: [{ tool: 'x', fixedArgs: { a: 1 } }] } }],
        },
    }));
    assert.ok(!JSON.stringify(checked.manifest).includes('LEAK-CANARY'));
    assert.ok(!JSON.stringify(checked.manifest).includes('fixedArgs'));
    assert.strictEqual(checked.manifest.solution.entities.webpages[0].bridgeGrants.integrations[0].tool, 'x',
        'the tool name is what the installer re-authorises, so it stays');
});

test('a key merely CALLED public elsewhere is left alone', () => {
    // Only under an `ai` object. A component named `publicNotice` on a page is
    // the author's work, not a spending grant.
    const checked = sanitizeManifest(buildManifest({
        project: { id: 'p1' },
        entities: { apps: [{ ref: 'app_1', definition: { publicNotice: 'Open to everyone' } }] },
    }));
    assert.strictEqual(checked.manifest.solution.entities.apps[0].definition.publicNotice, 'Open to everyone');
});

test('the caller\'s own object is never mutated by the check', () => {
    // install.js and upgrade.js build from `checked.manifest`; a caller that
    // also kept the file it read must still have what it read.
    const original = withGrants({ ai: { publicEnabled: true } });
    const checked = sanitizeManifest(original);
    assert.strictEqual(original.solution.entities.webpages[0].bridgeGrants.ai.publicEnabled, true);
    assert.strictEqual(checked.manifest.solution.entities.webpages[0].bridgeGrants.ai.publicEnabled, undefined);
});


// ═══ `source`: waar het bestand zegt vandaan te komen ═════════
//
// EEN BEWERING, GEEN AUTORISATIE. Dit blok reist in een bestand dat iedereen
// met een teksteditor kan wijzigen, dus de vraag hier is niet of het klopt maar
// of het GENORMALISEERD is: elke lezer voorbij `sanitizeManifest` hoort vier
// velden te zien — string of null — en niet wat het bestand ook maar meestuurde.
// Wat er met de bewering GEBEURT staat in install.test.js.

test('een manifest draagt altijd een herkomstblok, ook als niemand er een gaf', () => {
    // Vier velden op null in plaats van een ontbrekende sleutel: een lezer hoeft
    // dan nooit te raden tussen "geen bron" en "oud bestand".
    const m = buildManifest({ project: { id: 'p1' } });
    assert.deepStrictEqual(m.source, { blueprintId: null, orgId: null, orgName: null, version: null });
});

test('een gestempeld herkomstblok reist mee', () => {
    const m = buildManifest({
        project: { id: 'p1' },
        source: { blueprintId: 'bp_abc', orgId: 'org1', orgName: 'Acme', version: 3 },
    });
    assert.deepStrictEqual(m.source, { blueprintId: 'bp_abc', orgId: 'org1', orgName: 'Acme', version: 3 });
});

test('readSource maakt van alles wat geen string is een null', () => {
    // Zoals een handgemaakt bestand het zou kunnen aanleveren.
    assert.deepStrictEqual(
        readSource({ source: { blueprintId: { $ref: 'aut_1' }, orgId: ['org1'], orgName: 42, version: 'drie' } }),
        { blueprintId: null, orgId: null, orgName: null, version: null },
    );
    // En de randen: geen blok, een array als blok, helemaal geen manifest.
    for (const input of [{}, { source: [] }, { source: 'org1' }, null, 'nope']) {
        assert.deepStrictEqual(readSource(input),
            { blueprintId: null, orgId: null, orgName: null, version: null });
    }
});

test('readSource begrenst wat een bestand mag beweren', () => {
    const claim = readSource({ source: {
        blueprintId: 'bp_' + 'a'.repeat(500),
        orgName: '  Acme  ',
        orgId: '   ',
        version: 0,
    } });
    assert.strictEqual(claim.blueprintId.length, 64, 'een id uit een bestand is begrensd');
    assert.strictEqual(claim.orgName, 'Acme', 'witruimte hoort niet bij de naam');
    assert.strictEqual(claim.orgId, null, 'een lege bewering is geen bewering');
    assert.strictEqual(claim.version, null, 'versie 0 bestaat niet — dat is geen nummer maar een gat');
});

test('de check normaliseert het herkomstblok, en weigert er niet op', () => {
    // Een onzinnige bewering is geen reden om een verder geldige Blueprint niet
    // te installeren — zij geeft toch geen enkel recht.
    const raw = buildManifest({ project: { id: 'p1' } });
    raw.source = { blueprintId: 'bp_abc', orgName: { toString: () => 'Acme' }, extra: 'smokkelwaar' };
    const checked = sanitizeManifest(raw);
    assert.strictEqual(checked.ok, true);
    assert.deepStrictEqual(checked.manifest.source,
        { blueprintId: 'bp_abc', orgId: null, orgName: null, version: null });
    assert.strictEqual(checked.manifest.source.extra, undefined,
        'een veld dat het formaat niet kent reist niet mee');
});

test('de check laat het herkomstblok van de aanroeper met rust', () => {
    // Zelfde belofte als bij de gestripte sleutels: wie het bestand ook nog
    // vasthoudt, houdt wat hij gelezen heeft.
    const original = buildManifest({ project: { id: 'p1' } });
    original.source = { blueprintId: 'bp_abc', orgName: 12345 };
    sanitizeManifest(original);
    assert.strictEqual(original.source.orgName, 12345);
});

test('withSource geeft een kopie terug, niet hetzelfde object', () => {
    const m = buildManifest({ project: { id: 'p1' } });
    const stamped = withSource(m, { blueprintId: 'bp_abc', orgId: 'org1', orgName: 'Acme', version: 2 });
    assert.notStrictEqual(stamped, m);
    assert.strictEqual(m.source.blueprintId, null, 'het origineel is niet gestempeld');
    assert.deepStrictEqual(stamped.source, { blueprintId: 'bp_abc', orgId: 'org1', orgName: 'Acme', version: 2 });
    assert.strictEqual(stamped.solution, m.solution, 'de rest van het manifest is ongemoeid');
});

// ═══ Schema version 2: stable refs, slots and variables ══════════════

const { SUPPORTED_VERSIONS, FORBIDDEN_SECTIONS } = require('./manifest');

const v2 = (solution = {}) => buildManifest({
    project: { id: 'p1', name: 'P' },
    entities: { automations: [{ ref: 'aut_1', definition: {} }], datatables: [{ ref: 'dt_1', key: 'k' }] },
    ...solution,
});

test('the format is version 2, and a version-1 file still sanitizes', () => {
    assert.strictEqual(SCHEMA_VERSION, 2);
    assert.deepStrictEqual(SUPPORTED_VERSIONS, [1, 2]);
    const v1 = {
        format: FORMAT, schemaVersion: 1,
        solution: { key: 'sol_p1', version: 3, entities: { apps: [{ ref: 'app_1', definition: { actions: { go: { automationId: { $ref: 'aut_1' } } } } }], automations: [{ ref: 'aut_1' }] } },
    };
    const checked = sanitizeManifest(v1);
    assert.strictEqual(checked.ok, true, (checked.errors || []).join(' '));
    assert.strictEqual(checked.manifest.solution.slots, undefined, 'nothing is invented for an old file');
});

test('a gallery manifest carries no slots or variables section', () => {
    const m = v2();
    assert.strictEqual('slots' in m.solution, false);
    assert.strictEqual('variables' in m.solution, false);
});

test('slots and variables travel with plain refs, and collectRefs ignores them', () => {
    const m = v2({
        slots: [{ slot: 'table:invoices', kind: 'table', ref: 'aut_1', stepId: 's1', label: 'x', suggested: null }],
        variables: [{ name: 'api_base', type: 'url', ref: 'aut_1' }, { name: 'global_flag', type: 'boolean' }],
    });
    assert.deepStrictEqual([...collectRefs(m)], [], 'a slot ref is not a pointer install resolves');
    assert.strictEqual(sanitizeManifest(m).ok, true);
});

test('a slot ref must be declared by an entity of the file', () => {
    const m = v2({ slots: [{ slot: 'seats:aut_9:s1', kind: 'approver_seats', ref: 'aut_9' }] });
    const checked = sanitizeManifest(m);
    assert.strictEqual(checked.ok, false);
    assert.match(checked.errors.join(' '), /aut_9/);
});

test('a slot ref written as {$ref} is refused, not resolved', () => {
    const m = v2({ slots: [{ slot: 'notify:aut_1', kind: 'approver_seats', ref: { $ref: 'aut_1' } }] });
    assert.strictEqual(sanitizeManifest(m).ok, false);
});

test('a slot without a name or a part is refused', () => {
    assert.strictEqual(sanitizeManifest(v2({ slots: [{ kind: 'table', ref: 'aut_1' }] })).ok, false);
    assert.strictEqual(sanitizeManifest(v2({ slots: [{ slot: 'table:k', kind: 'table' }] })).ok, false);
    const notAList = v2();
    notAList.solution.slots = 'nope';
    assert.strictEqual(sanitizeManifest(notAList).ok, false);
});

test('a manifest carrying reference rows or KB content is refused (D20)', () => {
    assert.deepStrictEqual(FORBIDDEN_SECTIONS, ['referenceRows', 'knowledgeContent']);
    const inSolution = v2();
    inSolution.solution.referenceRows = [{ ref: 'dt_1', rows: [{ id: 'r1' }] }];
    const checked = sanitizeManifest(inSolution);
    assert.strictEqual(checked.ok, false);
    assert.match(checked.errors.join(' '), /referenceRows/);

    const atTop = { ...v2(), knowledgeContent: [] };
    assert.strictEqual(sanitizeManifest(atTop).ok, false);
});

test('refs from the passed map are stable across reordering', () => {
    const ledger = new Map([['a_x', 'aut_3'], ['a_y', 'aut_1'], ['t_z', 'dt_2']]);
    const first = assignRefs({ automations: [{ id: 'a_x' }, { id: 'a_y' }], datatables: [{ id: 't_z' }] }, { refs: ledger });
    const second = assignRefs({ automations: [{ id: 'a_y' }, { id: 'a_x' }], datatables: [{ id: 't_z' }] }, { refs: ledger });
    assert.deepStrictEqual([...first].sort(), [...second].sort());
    assert.strictEqual(first.get('a_x'), 'aut_3');
});

test('a member the ledger does not know gets a fresh number, never a retired one', () => {
    // aut_5 belongs to a part that left the Solution: it is never handed out again.
    const ledger = new Map([['a_x', 'aut_1'], ['gone', 'aut_5']]);
    const refs = assignRefs({ automations: [{ id: 'a_x' }, { id: 'a_new' }] }, { refs: ledger });
    assert.strictEqual(refs.get('a_new'), 'aut_6');
});

test('without a map, refs stay positional', () => {
    const refs = assignRefs({ automations: [{ id: 'b' }, { id: 'a' }] }, {});
    assert.deepStrictEqual([...refs.values()], ['aut_1', 'aut_2']);
});

test('rewriteToRefs covers the new locations through the registry, keeping its return shape', () => {
    const refs = assignRefs({ datatables: [{ id: 'tbl_live' }], automations: [{ id: 'aut_live' }] });
    const automationDefinition = { steps: [{ id: 's1', type: 'datatable', datatableId: 'tbl_live', datatableKey: 'k' }] };
    const webpageBridgeGrants = { automations: [], tables: [{ datatableId: 'tbl_live', mode: 'read' }] };
    const rewritten = [
        ...rewriteToRefs({ automationDefinition }, refs),
        ...rewriteToRefs({ webpageBridgeGrants }, refs),
    ];
    assert.deepStrictEqual(rewritten, [{ from: 'tbl_live', ref: 'dt_1' }, { from: 'tbl_live', ref: 'dt_1' }]);
    assert.deepStrictEqual(automationDefinition.steps[0].datatableId, { $ref: 'dt_1' });
    assert.deepStrictEqual(webpageBridgeGrants.tables[0].datatableId, { $ref: 'dt_1' });
});
