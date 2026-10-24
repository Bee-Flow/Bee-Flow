/**
 * "What changed" between two versions of a Blueprint.
 *
 * Two layers, and the tests chiefly concern the distinction between them:
 *
 *   1. the BOOLEAN DIFF (added/changed/unchanged) is exact, comes from the same
 *      hashDefinition as the upgrade, and is always there — also when there is no model,
 *      no provider and no network;
 *   2. the `text` is a fast-tier sentence about the SHAPE of the change, and may fall over. Should it do so, then there is no
 *      invented sentence but NO sentence, and the difference from "nothing has changed" must remain legible.
 *
 * And the third axis: PRIVACY. The JSON diff of an entity may contain customer data. What goes to the model is an allow-list of fields and of
 * value paths — never the diff itself.
 *
 * Run: cd server && node --test projects/packaging/releaseNotes.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    buildReleaseNotes, releaseNotesPayload, diffEntities, describeChanges, summariseChange,
    summaryMissing, modelPayload, normalise,
    withTimeout,
    FIELD_ALLOW, VALUE_PATHS, MAX_TEXT_CHARS, MAX_SUMMARIES, MAX_FACTS, MAX_NOTES_ENVELOPE_BYTES,
    TIMEOUT_MS, DEADLINE_MS,
} = require('./releaseNotes');

// ── Fixtures ───────────────────────────────────────────────────────────────

function manifestOf(entities, version = 1) {
    return {
        format: 'beeflow.blueprint',
        schemaVersion: 1,
        solution: { key: 'sol_orders', version, name: 'Orders', entities },
    };
}

/** An automation as capture delivers it: `title`, not `name`. */
function automation(overrides = {}) {
    return {
        ref: 'aut_1',
        kind: 'automation',
        title: 'Herinnering Van Dijk BV',
        description: 'Stuurt een betalingsherinnering',
        triggerType: 'schedule',
        scheduleCron: '0 9 * * 1-5',
        scheduleTz: 'Europe/Amsterdam',
        definition: {
            steps: [
                { id: 's1', type: 'ai_step', config: { prompt: 'Beste heer Van Dijk, uw factuur staat open.' } },
                { id: 's2', type: 'send_email', config: { to: 'jan@vandijk.nl', subject: 'Factuur 2026-0398' } },
            ],
        },
        ...overrides,
    };
}

/** De persoonsgegevens die in bovenstaande fixture verstopt zitten. */
const PERSONAL = [
    'Van Dijk', 'vandijk', 'jan@vandijk.nl', 'Factuur 2026-0398',
    'Beste heer', 'Herinnering', 'betalingsherinnering',
];

/** Een injecteerbare llmClient die opschrijft wat er de deur uit ging. */
function llm({ summary = 'Een stap erbij die een e-mail verstuurt.', chat, model = 'fast-model', resolveThrows = false } = {}) {
    const sent = [];
    return {
        sent,
        deps: {
            resolveModelForTierName: async (tier, opts) => {
                sent.push({ resolve: { tier, opts } });
                if (resolveThrows) throw new Error('config unreadable');
                return model;
            },
            llmClient: {
                chatForcedTool: async (modelId, messages, tool, options) => {
                    sent.push({ modelId, messages, tool, options });
                    if (typeof chat === 'function') return chat({ modelId, messages });
                    return { structured: { summary } };
                },
            },
        },
    };
}

/** Everything that went to the model, as one searchable string. */
function wireText(sent) {
    return sent
        .filter(s => Array.isArray(s.messages))
        .map(s => s.messages.map(m => String(m.content)).join('\n'))
        .join('\n');
}

// ── Laag 1: de boolean diff ────────────────────────────────────────────────

test('toegevoegd, gewijzigd en ongewijzigd — alle drie exact, zonder één modelaanroep', () => {
    const before = manifestOf({
        automations: [automation(), automation({ ref: 'aut_2', title: 'Wekelijkse export' })],
    });
    const after = manifestOf({
        automations: [
            automation(),
            automation({ ref: 'aut_2', title: 'Wekelijkse export', description: 'Nu ook met totalen' }),
            automation({ ref: 'aut_3', title: 'Nieuwe controle' }),
        ],
    }, 2);

    const notes = diffEntities({ previousManifest: before, manifest: after });
    assert.deepStrictEqual(notes.map(n => [n.entityId, n.change]), [
        ['aut_1', 'unchanged'],
        ['aut_2', 'changed'],
        ['aut_3', 'added'],
    ]);
    // De naam komt uit `title` als er geen `name` is — dat is de vorm die
    // capture voor automations oplevert.
    assert.deepStrictEqual(notes.map(n => n.name), ['Herinnering Van Dijk BV', 'Wekelijkse export', 'Nieuwe controle']);
    assert.ok(notes.every(n => n.kind === 'automation' && n.text === null));
});

test('een sleutel in een andere volgorde is geen wijziging — jsonb bewaart geen key-volgorde', () => {
    // This is the reason that there is exactly one hasher in this product. A plain
    // JSON.stringify would hash byte-identical content differently.
    const a = manifestOf({ apps: [{ ref: 'app_1', name: 'Orders', description: 'x', icon: 'box' }] });
    const b = manifestOf({ apps: [{ ref: 'app_1', icon: 'box', description: 'x', name: 'Orders' }] });
    assert.strictEqual(diffEntities({ previousManifest: a, manifest: b })[0].change, 'unchanged');
});

test('de eerste versie heeft geen voorganger: alles is toegevoegd', () => {
    const notes = diffEntities({ previousManifest: null, manifest: manifestOf({ automations: [automation()] }) });
    assert.deepStrictEqual(notes.map(n => n.change), ['added']);
});

test('alle zes soorten krijgen een exacte diff — ook tabellen en kennisbanken', () => {
    // The upgrade CANNOT compare those two (there is no live payload to hash against). This diff compares manifest
    // against manifest, so here it can — and that is precisely the difference in the question asked.
    const before = manifestOf({
        automations: [{ ref: 'aut_1', title: 'A' }],
        apps: [{ ref: 'app_1', name: 'A' }],
        webpages: [{ ref: 'web_1', name: 'A' }],
        datatables: [{ ref: 'dt_1', name: 'A', key: 'a' }],
        agents: [{ ref: 'agt_1', name: 'A' }],
        knowledgeBases: [{ ref: 'kb_1', name: 'A' }],
    });
    const after = manifestOf({
        automations: [{ ref: 'aut_1', title: 'B' }],
        apps: [{ ref: 'app_1', name: 'B' }],
        webpages: [{ ref: 'web_1', name: 'B' }],
        datatables: [{ ref: 'dt_1', name: 'B', key: 'a' }],
        agents: [{ ref: 'agt_1', name: 'B' }],
        knowledgeBases: [{ ref: 'kb_1', name: 'B' }],
    }, 2);

    const notes = diffEntities({ previousManifest: before, manifest: after });
    assert.deepStrictEqual(
        notes.map(n => n.kind),
        ['automation', 'app', 'webpage', 'datatable', 'agent', 'knowledge_base'],
    );
    assert.ok(notes.every(n => n.change === 'changed'));
});

test('de boolean diff kijkt naar de HELE entiteit, ook naar een veld dat het model nooit ziet', () => {
    // The two layers have different scopes, on purpose: the diff is exact over everything, the allow-list determines only what may be
    // described. A change in a non-describable field is therefore still a change — there is simply nobody who writes a sentence about it.
    const before = manifestOf({ apps: [{ ref: 'app_1', name: 'Orders', somethingNextYear: { a: 1 } }] });
    const after = manifestOf({ apps: [{ ref: 'app_1', name: 'Orders', somethingNextYear: { a: 2 } }] });

    assert.strictEqual(diffEntities({ previousManifest: before, manifest: after })[0].change, 'changed');
    assert.strictEqual(
        modelPayload('app', before.solution.entities.apps[0], after.solution.entities.apps[0]),
        null,
        'niets beschrijfbaars → geen payload → geen modelaanroep',
    );
});

test('een entiteit die de nieuwe versie niet meer bevat krijgt geen regel', () => {
    // The notes block is the table of contents of the NEW version, and the three
    // states are added/changed/unchanged. An installation moreover never deletes anything, so "removed" would promise something that does not happen.
    const before = manifestOf({ automations: [automation(), automation({ ref: 'aut_2', title: 'Weg' })] });
    const after = manifestOf({ automations: [automation()] }, 2);
    assert.deepStrictEqual(
        diffEntities({ previousManifest: before, manifest: after }).map(n => n.entityId),
        ['aut_1'],
    );
});

// ── Laag 2: de zin, en wat er gebeurt als hij uitblijft ────────────────────

test('een gewijzigde entiteit krijgt een zin; ongewijzigd en toegevoegd kosten geen aanroep', async () => {
    const before = manifestOf({ automations: [automation(), automation({ ref: 'aut_2', title: 'Export' })] });
    const after = manifestOf({
        automations: [
            automation(),
            automation({ ref: 'aut_2', title: 'Export', description: 'anders' }),
            automation({ ref: 'aut_3', title: 'Nieuw' }),
        ],
    }, 2);

    const { deps, sent } = llm({ summary: 'De omschrijving is bijgewerkt.' });
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });

    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [
        ['unchanged', null],
        ['changed', 'De omschrijving is bijgewerkt.'],
        ['added', null],
    ]);
    assert.strictEqual(sent.filter(s => s.messages).length, 1, 'precies één aanroep, voor de gewijzigde entiteit');
});

test('een omgevallen modelaanroep laat GEEN verzonnen zin achter, en houdt de publicatie niet tegen', async () => {
    const before = manifestOf({ automations: [automation(), automation({ ref: 'aut_2', title: 'Export' })] });
    const after = manifestOf({
        automations: [
            automation({ description: 'anders' }),
            automation({ ref: 'aut_2', title: 'Export', description: 'ook anders' }),
        ],
    }, 2);

    let first = true;
    const { deps } = llm({
        chat: () => {
            if (first) { first = false; throw new Error('provider is down'); }
            return { structured: { summary: 'De omschrijving is bijgewerkt.' } };
        },
    });

    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    // The exact diff is still there — that is the layer that cannot fall over.
    assert.deepStrictEqual(notes.map(n => n.change), ['changed', 'changed']);
    assert.strictEqual(notes[0].text, null, 'geen zin, geen verzinsel');
    assert.strictEqual(notes[1].text, 'De omschrijving is bijgewerkt.', 'één omgevallen aanroep bevriest de rest niet');
});

test('null bij "changed" is een ONTBREKENDE samenvatting; null bij "unchanged" is geen nieuws', () => {
    // Confusing those two is the difference between "no news" and "we
    // could not write it down". There is one place where that question belongs.
    assert.strictEqual(summaryMissing({ change: 'changed', text: null }), true);
    assert.strictEqual(summaryMissing({ change: 'changed', text: '' }), true);
    assert.strictEqual(summaryMissing({ change: 'unchanged', text: null }), false);
    assert.strictEqual(summaryMissing({ change: 'added', text: null }), false);
    assert.strictEqual(summaryMissing({ change: 'changed', text: 'iets' }), false);
    assert.strictEqual(summaryMissing(null), false);
});

test('geen geconfigureerd model = geen zin, geen fout', async () => {
    // resolveModelForTierName returns null if nobody has configured one.
    // That is a real answer, not a fault — and no reason to fall back on a model that this workspace
    // never chose.
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);
    const { deps, sent } = llm({ model: null });

    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]]);
    assert.strictEqual(sent.filter(s => s.messages).length, 0, 'geen model, dus ook geen aanroep');
});

test('een onleesbare modelconfig gooit niet — de notes komen gewoon terug', async () => {
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);
    const { deps } = llm({ resolveThrows: true });

    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]]);
});

test('de tier-resolutie krijgt org-context mee', async () => {
    // Without an org the resolution ignores the org overrides and the EU mode, and then
    // a different model sees the text than the one the workspace chose.
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);
    const { deps, sent } = llm();

    await buildReleaseNotes({ previousManifest: before, manifest: after, userOrgId: 'org_1', userId: 'u_1', deps });
    assert.deepStrictEqual(sent[0].resolve, { tier: 'fast', opts: { userOrgId: 'org_1', userId: 'u_1' } });
});

test('modeluitvoer is onvertrouwd: leeg, fout getypeerd of te lang', async () => {
    assert.strictEqual(normalise(null), null);
    assert.strictEqual(normalise({}), null);
    assert.strictEqual(normalise({ summary: '   ' }), null);
    assert.strictEqual(normalise({ summary: 42 }), null);
    assert.strictEqual(normalise({ summary: 'x'.repeat(500) }).length, MAX_TEXT_CHARS);

    // En hetzelfde langs de echte weg: een geweigerde tool geeft structured null.
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);
    const { deps } = llm({ chat: () => ({ structured: null }) });
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    assert.strictEqual(notes[0].text, null);
});

test('na de deadline blijft de rest zonder zin, in plaats van te blijven wachten', async () => {
    const entities = { automations: [] };
    const next = { automations: [] };
    for (let i = 1; i <= 5; i++) {
        entities.automations.push(automation({ ref: `aut_${i}`, title: `R${i}` }));
        next.automations.push(automation({ ref: `aut_${i}`, title: `R${i}`, description: `anders ${i}` }));
    }
    let clock = 0;
    const { deps } = llm({ summary: 'gewijzigd' });
    const notes = diffEntities({ previousManifest: manifestOf(entities), manifest: manifestOf(next, 2) });
    // De klok springt over de deadline zodra de eerste ronde gedaan is.
    await describeChanges(notes, {
        previousManifest: manifestOf(entities), manifest: manifestOf(next, 2), userId: 'u_1', deps,
        deadlineMs: 10, now: () => (clock += 4),
    });
    assert.ok(notes.some(n => n.text === null), 'niet alles is beschreven');
    assert.ok(notes.every(n => n.change === 'changed'), 'de exacte diff staat er wel voor allemaal');
});

test('een release met heel veel gewijzigde entiteiten kost hooguit MAX_SUMMARIES aanroepen', async () => {
    const before = { automations: [] };
    const after = { automations: [] };
    for (let i = 1; i <= MAX_SUMMARIES + 6; i++) {
        before.automations.push(automation({ ref: `aut_${i}`, title: `R${i}` }));
        after.automations.push(automation({ ref: `aut_${i}`, title: `R${i}`, description: `anders ${i}` }));
    }
    const { deps, sent } = llm();
    const notes = await buildReleaseNotes({ previousManifest: manifestOf(before), manifest: manifestOf(after, 2), userId: 'u_1', deps });
    assert.strictEqual(sent.filter(s => s.messages).length, MAX_SUMMARIES);
    assert.strictEqual(notes.filter(n => n.text).length, MAX_SUMMARIES);
    assert.strictEqual(notes.length, MAX_SUMMARIES + 6, 'de exacte diff is er voor allemaal');
});

// ── De naad met de release-tabel ──────────────────────────────────────────

test('de envelop is wat publishRelease aanneemt: een plat object, geen array', () => {
    // `notes JSONB NOT NULL DEFAULT '{}'` en normalizeNotes weigert een array
    // met "Release notes must be an object". De lijst zit dus in een envelop.
    const notes = diffEntities({ previousManifest: null, manifest: manifestOf({ automations: [automation()] }) });
    const payload = releaseNotesPayload(notes);
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    assert.deepStrictEqual(payload.entities, notes);
    assert.strictEqual(payload.omitted, 0);
    assert.strictEqual(payload.textsDropped, false);
});

test('een notitie die niet past laat de publicatie niet afketsen — hij krimpt', () => {
    // Over MAX_NOTES_BYTES publishRelease throws, and then a NOTE holds back a
    // publication. Shrink in the right order: first the sentences (the enrichment), then the unchanged lines (the least news).
    const rows = [];
    for (let i = 0; i < 400; i++) {
        rows.push({
            kind: 'automation', entityId: `aut_${i}`, name: 'N'.repeat(100),
            change: i % 2 ? 'changed' : 'unchanged', text: i % 2 ? 'T'.repeat(150) : null,
        });
    }
    const budget = 20 * 1024;
    const payload = releaseNotesPayload(rows, { maxBytes: budget });

    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= budget, 'past binnen de grens');
    assert.strictEqual(payload.textsDropped, true, 'de zinnen gaan als eerste');
    assert.ok(payload.entities.every(n => n.text === null));
    assert.ok(payload.entities.every(n => n.change === 'changed'), 'ongewijzigd is het minste nieuws');
    // En wat wegviel is geteld, niet verzwegen.
    assert.strictEqual(payload.omitted, rows.length - payload.entities.length);
    assert.ok(payload.omitted > 0);
});

test('zelfs een absurd kleine grens levert een geldig object op', () => {
    const rows = [{ kind: 'app', entityId: 'app_1', name: 'x', change: 'changed', text: 'y' }];
    const payload = releaseNotesPayload(rows, { maxBytes: 10 });
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    assert.deepStrictEqual(payload.entities, []);
    assert.strictEqual(payload.omitted, 1);
});

// ── Privacy: de allow-list ─────────────────────────────────────────────────

test('GEEN klantgegeven uit de diff verlaat het systeem', async () => {
    // This is the test that the card means: the JSON diff of an entity can
    // contain a customer name, an e-mail address and an invoice number. What goes to the
    // model is the SHAPE of the change, never the content.
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({
        automations: [automation({
            definition: {
                steps: [
                    { id: 's1', type: 'ai_step', config: { prompt: 'Beste heer Van Dijk, uw factuur staat nog open.' } },
                    { id: 's2', type: 'send_email', config: { to: 'jan@vandijk.nl', subject: 'Factuur 2026-0398 herinnering' } },
                    { id: 's3', type: 'condition', config: { left: 'jan@vandijk.nl' } },
                ],
            },
        })],
    }, 2);

    const { deps, sent } = llm();
    await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });

    const wire = wireText(sent);
    assert.ok(wire.length > 0, 'er is wél een aanroep gedaan');
    for (const secret of PERSONAL) {
        assert.ok(!wire.includes(secret), `"${secret}" mag het model nooit bereiken`);
    }
    // Wat er wél in staat: het soort, het pad en het staptype uit de catalogus.
    assert.match(wire, /definition\.steps\[\]/);
    assert.match(wire, /condition/);
});

test('de NAAM van de entiteit gaat niet mee — het scherm toont hem zelf', async () => {
    // An automation may be named after a customer. The note row already carries the name,
    // so the model does not need it to write a sentence.
    const before = manifestOf({ automations: [automation({ title: 'Oude naam' })] });
    const after = manifestOf({ automations: [automation({ title: 'Herinnering Van Dijk BV' })] }, 2);

    const { deps, sent } = llm();
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });

    assert.strictEqual(notes[0].name, 'Herinnering Van Dijk BV', 'de rij draagt hem wel');
    // En de rij zelf is begrensd: hij gaat als JSONB de database in en daarna
    // op een scherm.
    const lang = diffEntities({
        previousManifest: null,
        manifest: manifestOf({ automations: [automation({ title: 'N'.repeat(400) })] }),
    });
    assert.strictEqual(lang[0].name.length, 120);
    const wire = wireText(sent);
    assert.ok(!wire.includes('Herinnering Van Dijk BV'));
    assert.ok(!wire.includes('Oude naam'));
    assert.match(wire, /"path":"title"/, 'dat de titel wijzigde is wél een feit');
});

test('een veld dat volgend jaar wordt toegevoegd bereikt het model niet vanzelf', () => {
    // Allow-list, not deny-list. This is the CLAUDE.md rule: build the payload
    // from an explicit list, never remove keys from an object.
    const before = { ref: 'agt_1', name: 'Helper', notebookIds: ['nb_klantdossier_van_dijk'] };
    const after = { ref: 'agt_1', name: 'Helper', notebookIds: ['nb_klantdossier_van_dijk', 'nb_2'] };
    assert.strictEqual(modelPayload('agent', before, after), null);
    assert.ok(!FIELD_ALLOW.agent.includes('notebookIds'));
});

test('alleen paden uit een GESLOTEN vocabulaire dragen hun waarde mee', () => {
    const before = {
        ref: 'dt_1', key: 'orders', name: 'Orders', rowScope: 'all',
        columns: [{ key: 'c1', name: 'Klantnaam', type: 'text' }],
    };
    const after = {
        ref: 'dt_1', key: 'orders', name: 'Orders', rowScope: 'own',
        columns: [
            { key: 'c1', name: 'Klantnaam', type: 'text' },
            { key: 'c2', name: 'Van Dijk korting', type: 'number' },
        ],
    };
    const payload = modelPayload('datatable', before, after);
    const json = JSON.stringify(payload);

    // rowScope and the column TYPE come from a fixed list and may go along.
    assert.ok(payload.changes.some(c => c.path === 'rowScope' && c.value === 'own'));
    assert.ok(payload.changes.some(c => c.path === 'columns[].type' && c.value === 'number' && c.change === 'added'));
    // De kolomNAAM is door iemand ingetypt en gaat nooit mee.
    assert.ok(!json.includes('Klantnaam'));
    assert.ok(!json.includes('Van Dijk'));
});

test('een waarde die WEL als token leest maar op geen toegelaten pad staat, reist niet mee', () => {
    // The first slot, tested separately. Not every item of personal data contains a space
    // or an at-sign: a telephone number, a customer number and a URL with a company name in it all read
    // as a neat token. They may not go along because their PATH is not there — not because their
    // shape gives them away.
    const before = {
        ref: 'aut_1',
        definition: { trigger: { type: 'webhook', url: 'https://oud.example.nl/hook', phone: '0611111111' } },
    };
    const after = {
        ref: 'aut_1',
        definition: { trigger: { type: 'webhook', url: 'https://vandijk-bv.example.nl/hook', phone: '0612345678' } },
    };
    const json = JSON.stringify(modelPayload('automation', before, after));
    assert.ok(!json.includes('vandijk-bv'), 'een URL met een klantnaam erin');
    assert.ok(!json.includes('0612345678'), 'een telefoonnummer');
    assert.ok(!json.includes('0611111111'));
    // De feiten zijn er wel: dát die twee velden wijzigden.
    assert.match(json, /definition\.trigger\.url/);
    assert.match(json, /definition\.trigger\.phone/);

    // The same for two fields that ARE in FIELD_ALLOW: the path may
    // be described, the value does not travel along.
    const agent = modelPayload('agent',
        { ref: 'agt_1', model: 'claude-opus-5' },
        { ref: 'agt_1', model: 'mistral-small-latest' });
    assert.deepStrictEqual(agent.changes, [{ path: 'model', change: 'changed' }]);

    const table = modelPayload('datatable',
        { ref: 'dt_1', subjectColumn: 'klant_11' },
        { ref: 'dt_1', subjectColumn: 'klantnummer_88213' });
    assert.deepStrictEqual(table.changes, [{ path: 'subjectColumn', change: 'changed' }]);
});

test('een enorme wijziging levert een begrensd aantal feiten op', () => {
    // A wall of paths is not read by a model, and each path is a piece of key vocabulary
    // that leaves the house. Bounded, therefore.
    const wide = (n, offset) => {
        const definition = {};
        for (let i = 0; i < n; i++) definition[`veld_${i}`] = i + offset;
        return { ref: 'app_1', definition };
    };
    const payload = modelPayload('app', wide(200, 0), wide(200, 1));
    assert.ok(payload.changes.length <= MAX_FACTS, `${payload.changes.length} feiten`);

    // Also on the array side, where the facts are piled up in one round
    // rather than passing the bound again per key.
    const steps = (n) => ({ ref: 'aut_1', definition: { steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, type: `type_${i}` })) } });
    const many = modelPayload('automation', steps(1), steps(60));
    assert.ok(many.changes.length <= MAX_FACTS, `${many.changes.length} feiten uit een array`);
});

test('vrije tekst op een toegelaten waardepad valt alsnog af', () => {
    // The second slot. Should free text ever land on a path from VALUE_PATHS,
    // then the value does not travel along — the fact that the field changed still does.
    const before = { ref: 'aut_1', triggerType: 'manual' };
    const after = { ref: 'aut_1', triggerType: 'mail van jan@vandijk.nl' };
    const payload = modelPayload('automation', before, after);
    assert.deepStrictEqual(payload.changes, [{ path: 'triggerType', change: 'changed' }]);
    assert.ok(!JSON.stringify(payload).includes('vandijk'));
});

test('een objectsleutel die geen schema is, wordt geen pad', () => {
    // Keys are normally schema (`steps`, `config`), but a form may be
    // keyed on an e-mail address. Then the key is data.
    const before = { ref: 'app_1', definition: { responses: { 'jan@vandijk.nl': { seen: false } } } };
    const after = { ref: 'app_1', definition: { responses: { 'jan@vandijk.nl': { seen: true } } } };
    const json = JSON.stringify(modelPayload('app', before, after));
    assert.ok(!json.includes('vandijk'));
    assert.match(json, /definition\.responses\.\*/);
});

test('diep werk rolt op in plaats van uitgeklapt te worden', () => {
    const deep = (leaf) => ({ ref: 'app_1', definition: { a: { b: { c: { d: { klant: leaf } } } } } });
    const payload = modelPayload('app', deep('Van Dijk BV'), deep('Jansen BV'));
    const json = JSON.stringify(payload);
    assert.ok(!json.includes('Van Dijk'));
    assert.ok(!json.includes('Jansen'));
    assert.deepStrictEqual(payload.changes, [{ path: 'definition.a.b.c', change: 'changed' }]);
});

test('de payload is precies { kind, changes } — geen rij, geen entiteit', async () => {
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);
    const { deps, sent } = llm();
    await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });

    const user = sent.find(s => s.messages).messages.find(m => m.role === 'user');
    const payload = JSON.parse(user.content);
    assert.deepStrictEqual(Object.keys(payload).sort(), ['changes', 'kind']);
    assert.strictEqual(payload.kind, 'automation');
    assert.ok(payload.changes.every(c => Object.keys(c).every(k => ['path', 'change', 'count', 'value'].includes(k))));
});

test('het model wordt verteld dat het niets mag verzinnen wat het niet ziet', async () => {
    // It receives only paths. Without this instruction a model fills in the
    // missing values itself, and then an invented e-mail address ends up in
    // the release note.
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);
    const { deps, sent } = llm();
    await buildReleaseNotes({ previousManifest: before, manifest: after, language: 'Dutch', userId: 'u_1', deps });

    const system = sent.find(s => s.messages).messages.find(m => m.role === 'system').content;
    assert.match(system, /Never invent/i);
    assert.match(system, /Dutch/);
});

test('stappen worden als multiset vergeleken, niet op index', async () => {
    // Eén stap vooraan invoegen verschuift anders elk volgend element en levert
    // een muur van "gewijzigd" op waar niets gewijzigd is.
    const steps = [
        { id: 's1', type: 'ai_step', config: { prompt: 'a' } },
        { id: 's2', type: 'send_email', config: { to: 'a@b.nl' } },
    ];
    const before = { ref: 'aut_1', definition: { steps } };
    const after = { ref: 'aut_1', definition: { steps: [{ id: 's0', type: 'condition', config: {} }, ...steps] } };
    const payload = modelPayload('automation', before, after);

    assert.ok(payload.changes.some(c => c.path === 'definition.steps[]' && c.change === 'added' && c.count === 1));
    assert.ok(payload.changes.some(c => c.path === 'definition.steps[].type' && c.change === 'added' && c.value === 'condition'));
    assert.ok(!payload.changes.some(c => c.value === 'ai_step'), 'de ongewijzigde stappen leveren geen feit op');
});

test('een wijziging binnen een stap is een feit zonder inhoud', () => {
    const before = { ref: 'aut_1', definition: { steps: [{ id: 's1', type: 'send_email', config: { to: 'jan@vandijk.nl' } }] } };
    const after = { ref: 'aut_1', definition: { steps: [{ id: 's1', type: 'send_email', config: { to: 'piet@example.nl' } }] } };
    const payload = modelPayload('automation', before, after);
    assert.deepStrictEqual(payload.changes, [{ path: 'definition.steps[]', change: 'changed' }]);
});

test('VALUE_PATHS en FIELD_ALLOW zijn bevroren lijsten, geen berekende', () => {
    // An allow-list that is topped up somewhere is no longer an allow-list.
    assert.ok(Object.isFrozen(FIELD_ALLOW));
    for (const list of Object.values(FIELD_ALLOW)) assert.ok(Object.isFrozen(list));
    // A Set is NOT frozen by Object.freeze (the lock sits on the own
    // properties, not on the content), so the list is a frozen array.
    assert.ok(Object.isFrozen(VALUE_PATHS));
    assert.ok(Array.isArray(VALUE_PATHS));
    assert.throws(() => VALUE_PATHS.push('systemPrompt'), 'de lijst kan niet elders aangevuld worden');
    assert.ok(!VALUE_PATHS.includes('scheduleCron'), 'de cron reist als feit, niet als waarde');
    assert.ok(!VALUE_PATHS.includes('model'), 'het model-id van een agent reist als feit, niet als waarde');
});

test('summariseChange gooit nooit — ook niet zonder deps of met een kapotte client', async () => {
    const entity = automation();
    const changed = automation({ description: 'anders' });
    const boom = { llmClient: { chatForcedTool: async () => { throw new Error('boom'); } }, resolveModelForTierName: async () => 'm' };
    assert.strictEqual(await summariseChange({ kind: 'automation', before: entity, after: changed, deps: boom }), null);

    const nonsense = { llmClient: { chatForcedTool: async () => ({ structured: { summary: {} } }) }, resolveModelForTierName: async () => 'm' };
    assert.strictEqual(await summariseChange({ kind: 'automation', before: entity, after: changed, deps: nonsense }), null);

    // An unknown kind has no allow-list and therefore no payload.
    assert.strictEqual(await summariseChange({ kind: 'notebook', before: entity, after: changed, deps: nonsense }), null);
});

test('buildReleaseNotes gooit niet als de hele tekstlaag omvalt', async () => {
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);
    const deps = {
        resolveModelForTierName: async () => 'm',
        llmClient: { chatForcedTool: () => { throw new Error('synchroon stuk'); } },
    };
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]]);
});

// ── De begrenzing op een aanroep die nooit settelt ─────────────────────────

test('withTimeout laat een belofte die NOOIT settelt niet eeuwig hangen', async () => {
    // This is the only thing that bounds a half-open socket: no answer, no
    // error. The deadline in describeChanges does not rescue it — that is checked
    // BEFORE the await, not during. Should someone remove the race, then the
    // caller hangs forever, and as soon as a route awaits it, the publication
    // request itself hangs with it.
    const never = new Promise(() => {});
    await assert.rejects(() => withTimeout(never, 10, 'release note'), /release note timed out after 10ms/);
});

test('withTimeout ruimt zijn timer op zodra de belofte wél settelt', async () => {
    // Anders houdt elke geslaagde aanroep de event-loop nog TIMEOUT_MS open —
    // zichtbaar zodra de suite zonder --test-force-exit draait.
    const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    assert.strictEqual(await withTimeout(Promise.resolve('klaar'), 60_000, 'x'), 'klaar');
    await new Promise(r => setImmediate(r));
    const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    assert.ok(after <= before, 'geen timer blijft achter');
});

test('een aanroep die blijft hangen levert GEEN zin, en houdt niets tegen', async () => {
    // Gemeten met de echte withTimeout: een chatForcedTool die nooit settelt.
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);
    const deps = {
        resolveModelForTierName: async () => 'fast-model',
        llmClient: { chatForcedTool: () => new Promise(() => {}) },
    };
    const started = Date.now();
    const notes = await buildReleaseNotes({
        previousManifest: before, manifest: after, userId: 'u_1', timeoutMs: 30, deps,
    });
    assert.ok(Date.now() - started < 5_000, 'de race kapt af, de aanroep hangt niet');
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]]);
    assert.strictEqual(summaryMissing(notes[0]), true, '"we konden het niet opschrijven", niet "geen nieuws"');
});

// ── Wiens model: onbekend versmalt ─────────────────────────────────────────

test('zonder gebruiker vertrekt er GEEN modelaanroep', async () => {
    // A tier resolution without a user ignores the org override AND the EU mode
    // (modelResolver.applyEUOverrides/isEUModeActive) and falls back to the
    // GLOBAL fast tier. Then the shape of someone else's Solution would go to the model
    // of the instance rather than to the model that this workspace chose. Unknown should narrow, not widen.
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);

    const { deps, sent } = llm();
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, deps });
    assert.deepStrictEqual(sent, [], 'geen resolutie en geen aanroep');
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]],
        'de exacte diff staat er nog steeds — publiceren gaat gewoon door');
});

test('een persoonlijk project zonder organisatie mag wél — de gebruiker beslist', async () => {
    // `userOrgId` may be null: a project without an organisation has none.
    // The user is the context that carries the EU mode and the Privacy Shield.
    const before = manifestOf({ automations: [automation()] });
    const after = manifestOf({ automations: [automation({ description: 'anders' })] }, 2);

    const { deps, sent } = llm({ summary: 'De omschrijving is bijgewerkt.' });
    const notes = await buildReleaseNotes({
        previousManifest: before, manifest: after, userOrgId: null, userId: 'u_1', deps,
    });
    assert.strictEqual(notes[0].text, 'De omschrijving is bijgewerkt.');
    assert.deepStrictEqual(sent[0].resolve.opts, { userOrgId: null, userId: 'u_1' });
});

test('summariseChange zonder gebruiker resolveert niets en roept niets aan', async () => {
    const { deps, sent } = llm();
    const out = await summariseChange({
        kind: 'automation', before: automation(), after: automation({ description: 'anders' }), deps,
    });
    assert.strictEqual(out, null);
    assert.deepStrictEqual(sent, []);
});

// ── De middelste krimpstap ────────────────────────────────────────────────

test('de tweede krimpstap houdt ALLE regels en haalt alleen de zinnen weg', async () => {
    // The existing shrink test touches only the third branch (the halving loop). This
    // one touches the second, and that branch carries the only signal that separates "we could not
    // write it down" from "the sentences were removed to make it fit": `textsDropped`. If that flag is
    // wrong, every changed line on the screen reads as a failed summary.
    const rows = Array.from({ length: 40 }, (_, i) => ({
        kind: 'automation', entityId: `aut_${i}`, name: `Automation ${i}`,
        change: 'changed', text: 'T'.repeat(150),
    }));
    const full = Buffer.byteLength(JSON.stringify({ entities: rows, omitted: 0, textsDropped: false }), 'utf8');
    const budget = 5_000;
    assert.ok(full > budget, 'de fixture past er echt niet in');

    const payload = releaseNotesPayload(rows, { maxBytes: budget });
    assert.strictEqual(payload.entities.length, rows.length, 'geen enkele regel is weggevallen');
    assert.strictEqual(payload.omitted, 0, 'er is niets weggelaten om over te rapporteren');
    assert.strictEqual(payload.textsDropped, true, 'de zinnen zijn eruit gehaald, en dat staat er');
    assert.ok(payload.entities.every(n => n.text === null));
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= budget);

    // And the pitfall that this flag covers: without it every row here is
    // "we could not write it down", even though the sentence WAS there.
    assert.strictEqual(summaryMissing(payload.entities[0]), true);
});

test('een grens die kleiner is dan de lege envelop levert die lege envelop', () => {
    // No infinite loop and no null: smaller than `{"entities":[],...}` is not possible, and then the honest
    // outcome is the smallest valid envelope with the count of what does not fit.
    const rows = [
        { kind: 'app', entityId: 'app_1', name: 'x', change: 'changed', text: 'y' },
        { kind: 'app', entityId: 'app_2', name: 'x', change: 'unchanged', text: null },
    ];
    const payload = releaseNotesPayload(rows, { maxBytes: 10 });
    assert.deepStrictEqual(payload, { entities: [], omitted: 2, textsDropped: true });
});

test('de enveloppegrens is een geëxporteerde constante, geen los getal', () => {
    // stores/blueprintStore.releases.test.js legt hem naast MAX_NOTES_BYTES.
    assert.strictEqual(MAX_NOTES_ENVELOPE_BYTES, 64 * 1024);
    const rows = Array.from({ length: 400 }, (_, i) => ({
        kind: 'automation', entityId: `a${i}`, name: 'N'.repeat(100), change: 'changed', text: 'T'.repeat(150),
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(releaseNotesPayload(rows)), 'utf8') <= MAX_NOTES_ENVELOPE_BYTES);
});

test('de standaardgrenzen zijn wachttijden, geen eeuwigheden', () => {
    // The race above times out at `timeoutMs`, and that falls back without a value to
    // TIMEOUT_MS. A bound large enough never to bite is the same as no bound — and then the caller
    // hangs regardless. Both values are therefore pinned here with an upper bound; the publication route
    // moreover places still smaller limits on top (packaging.js, NOTE_CALL_TIMEOUT_MS).
    assert.ok(TIMEOUT_MS > 0 && TIMEOUT_MS <= 30_000, `één regel is geen ${TIMEOUT_MS}ms wachten waard`);
    assert.ok(DEADLINE_MS > 0 && DEADLINE_MS <= 60_000, `de hele tekstlaag mag geen ${DEADLINE_MS}ms duren`);
});
