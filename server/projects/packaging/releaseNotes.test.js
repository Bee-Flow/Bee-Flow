/**
 * "What changed" tussen twee versies van een Blueprint.
 *
 * Twee lagen, en de tests gaan vooral over het onderscheid ertussen:
 *
 *   1. de BOOLEAN DIFF (added/changed/unchanged) is exact, komt uit dezelfde
 *      hashDefinition als de upgrade, en is er altijd — ook als er geen model,
 *      geen provider en geen netwerk is;
 *   2. de `text` is een fast-tier zin over de VORM van de wijziging, en mag
 *      omvallen. Valt hij om, dan staat er geen verzonnen zin maar géén zin,
 *      en het verschil met "er is niets veranderd" moet leesbaar blijven.
 *
 * En de derde as: PRIVACY. De JSON-diff van een entiteit kan klantgegevens
 * bevatten. Wat naar het model gaat is een allow-list van velden en van
 * waardepaden — nooit de diff zelf.
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

/** Een routine zoals capture hem oplevert: `title`, niet `name`. */
function routine(overrides = {}) {
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

/** Alles wat naar het model ging, als één doorzoekbare string. */
function wireText(sent) {
    return sent
        .filter(s => Array.isArray(s.messages))
        .map(s => s.messages.map(m => String(m.content)).join('\n'))
        .join('\n');
}

// ── Laag 1: de boolean diff ────────────────────────────────────────────────

test('toegevoegd, gewijzigd en ongewijzigd — alle drie exact, zonder één modelaanroep', () => {
    const before = manifestOf({
        automations: [routine(), routine({ ref: 'aut_2', title: 'Wekelijkse export' })],
    });
    const after = manifestOf({
        automations: [
            routine(),
            routine({ ref: 'aut_2', title: 'Wekelijkse export', description: 'Nu ook met totalen' }),
            routine({ ref: 'aut_3', title: 'Nieuwe controle' }),
        ],
    }, 2);

    const notes = diffEntities({ previousManifest: before, manifest: after });
    assert.deepStrictEqual(notes.map(n => [n.entityId, n.change]), [
        ['aut_1', 'unchanged'],
        ['aut_2', 'changed'],
        ['aut_3', 'added'],
    ]);
    // De naam komt uit `title` als er geen `name` is — dat is de vorm die
    // capture voor routines oplevert.
    assert.deepStrictEqual(notes.map(n => n.name), ['Herinnering Van Dijk BV', 'Wekelijkse export', 'Nieuwe controle']);
    assert.ok(notes.every(n => n.kind === 'automation' && n.text === null));
});

test('een sleutel in een andere volgorde is geen wijziging — jsonb bewaart geen key-volgorde', () => {
    // Dit is de reden dat er precies één hasher in dit product is. Een gewone
    // JSON.stringify zou byte-identieke inhoud hier verschillend hashen.
    const a = manifestOf({ apps: [{ ref: 'app_1', name: 'Orders', description: 'x', icon: 'box' }] });
    const b = manifestOf({ apps: [{ ref: 'app_1', icon: 'box', description: 'x', name: 'Orders' }] });
    assert.strictEqual(diffEntities({ previousManifest: a, manifest: b })[0].change, 'unchanged');
});

test('de eerste versie heeft geen voorganger: alles is toegevoegd', () => {
    const notes = diffEntities({ previousManifest: null, manifest: manifestOf({ automations: [routine()] }) });
    assert.deepStrictEqual(notes.map(n => n.change), ['added']);
});

test('alle zes soorten krijgen een exacte diff — ook tabellen en kennisbanken', () => {
    // De upgrade KAN die twee niet vergelijken (er is geen levende payload om
    // tegen te hashen). Deze diff vergelijkt manifest tegen manifest, dus hier
    // kan het wel — en dat is precies het verschil in vraagstelling.
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
    // De twee lagen hebben verschillende reikwijdtes, met opzet: de diff is
    // exact over alles, de allow-list bepaalt alleen wat er beschreven mag
    // worden. Een wijziging in een niet-beschrijfbaar veld is dus wél een
    // wijziging — er is alleen niemand die er een zin over schrijft.
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
    // Het notitieblok is de inhoudsopgave van de NIEUWE versie, en de drie
    // toestanden zijn added/changed/unchanged. Een installatie verwijdert
    // bovendien nooit iets, dus "removed" zou iets beloven wat niet gebeurt.
    const before = manifestOf({ automations: [routine(), routine({ ref: 'aut_2', title: 'Weg' })] });
    const after = manifestOf({ automations: [routine()] }, 2);
    assert.deepStrictEqual(
        diffEntities({ previousManifest: before, manifest: after }).map(n => n.entityId),
        ['aut_1'],
    );
});

// ── Laag 2: de zin, en wat er gebeurt als hij uitblijft ────────────────────

test('een gewijzigde entiteit krijgt een zin; ongewijzigd en toegevoegd kosten geen aanroep', async () => {
    const before = manifestOf({ automations: [routine(), routine({ ref: 'aut_2', title: 'Export' })] });
    const after = manifestOf({
        automations: [
            routine(),
            routine({ ref: 'aut_2', title: 'Export', description: 'anders' }),
            routine({ ref: 'aut_3', title: 'Nieuw' }),
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
    const before = manifestOf({ automations: [routine(), routine({ ref: 'aut_2', title: 'Export' })] });
    const after = manifestOf({
        automations: [
            routine({ description: 'anders' }),
            routine({ ref: 'aut_2', title: 'Export', description: 'ook anders' }),
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
    // De exacte diff staat er nog — dat is de laag die niet kan omvallen.
    assert.deepStrictEqual(notes.map(n => n.change), ['changed', 'changed']);
    assert.strictEqual(notes[0].text, null, 'geen zin, geen verzinsel');
    assert.strictEqual(notes[1].text, 'De omschrijving is bijgewerkt.', 'één omgevallen aanroep bevriest de rest niet');
});

test('null bij "changed" is een ONTBREKENDE samenvatting; null bij "unchanged" is geen nieuws', () => {
    // Die twee door elkaar halen is het verschil tussen "geen nieuws" en "we
    // konden het niet opschrijven". Er is één plek waar die vraag hoort.
    assert.strictEqual(summaryMissing({ change: 'changed', text: null }), true);
    assert.strictEqual(summaryMissing({ change: 'changed', text: '' }), true);
    assert.strictEqual(summaryMissing({ change: 'unchanged', text: null }), false);
    assert.strictEqual(summaryMissing({ change: 'added', text: null }), false);
    assert.strictEqual(summaryMissing({ change: 'changed', text: 'iets' }), false);
    assert.strictEqual(summaryMissing(null), false);
});

test('geen geconfigureerd model = geen zin, geen fout', async () => {
    // resolveModelForTierName geeft null als niemand er een geconfigureerd
    // heeft. Dat is een echt antwoord, geen storing — en geen reden om terug te
    // vallen op een model dat deze werkruimte nooit gekozen heeft.
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);
    const { deps, sent } = llm({ model: null });

    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]]);
    assert.strictEqual(sent.filter(s => s.messages).length, 0, 'geen model, dus ook geen aanroep');
});

test('een onleesbare modelconfig gooit niet — de notes komen gewoon terug', async () => {
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);
    const { deps } = llm({ resolveThrows: true });

    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]]);
});

test('de tier-resolutie krijgt org-context mee', async () => {
    // Zonder org negeert de resolutie de org-overrides en de EU-modus, en dan
    // ziet een ander model de tekst dan de werkruimte gekozen heeft.
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);
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
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);
    const { deps } = llm({ chat: () => ({ structured: null }) });
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    assert.strictEqual(notes[0].text, null);
});

test('na de deadline blijft de rest zonder zin, in plaats van te blijven wachten', async () => {
    const entities = { automations: [] };
    const next = { automations: [] };
    for (let i = 1; i <= 5; i++) {
        entities.automations.push(routine({ ref: `aut_${i}`, title: `R${i}` }));
        next.automations.push(routine({ ref: `aut_${i}`, title: `R${i}`, description: `anders ${i}` }));
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
        before.automations.push(routine({ ref: `aut_${i}`, title: `R${i}` }));
        after.automations.push(routine({ ref: `aut_${i}`, title: `R${i}`, description: `anders ${i}` }));
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
    const notes = diffEntities({ previousManifest: null, manifest: manifestOf({ automations: [routine()] }) });
    const payload = releaseNotesPayload(notes);
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    assert.deepStrictEqual(payload.entities, notes);
    assert.strictEqual(payload.omitted, 0);
    assert.strictEqual(payload.textsDropped, false);
});

test('een notitie die niet past laat de publicatie niet afketsen — hij krimpt', () => {
    // Over MAX_NOTES_BYTES gooit publishRelease, en dan houdt een NOTITIE een
    // publicatie tegen. Krimpen in de goede volgorde: eerst de zinnen (de
    // verrijking), dan de ongewijzigde regels (het minste nieuws).
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
    // Dit is de test die de kaart bedoelt: de JSON-diff van een entiteit kan
    // een klantnaam, een e-mailadres en een factuurnummer bevatten. Wat naar
    // het model gaat is de VORM van de wijziging, nooit de inhoud.
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({
        automations: [routine({
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
    // Een routine kan naar een klant genoemd zijn. De note-rij draagt de naam
    // al, dus het model heeft hem niet nodig om een zin te schrijven.
    const before = manifestOf({ automations: [routine({ title: 'Oude naam' })] });
    const after = manifestOf({ automations: [routine({ title: 'Herinnering Van Dijk BV' })] }, 2);

    const { deps, sent } = llm();
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });

    assert.strictEqual(notes[0].name, 'Herinnering Van Dijk BV', 'de rij draagt hem wel');
    // En de rij zelf is begrensd: hij gaat als JSONB de database in en daarna
    // op een scherm.
    const lang = diffEntities({
        previousManifest: null,
        manifest: manifestOf({ automations: [routine({ title: 'N'.repeat(400) })] }),
    });
    assert.strictEqual(lang[0].name.length, 120);
    const wire = wireText(sent);
    assert.ok(!wire.includes('Herinnering Van Dijk BV'));
    assert.ok(!wire.includes('Oude naam'));
    assert.match(wire, /"path":"title"/, 'dat de titel wijzigde is wél een feit');
});

test('een veld dat volgend jaar wordt toegevoegd bereikt het model niet vanzelf', () => {
    // Allow-list, geen deny-list. Dit is de CLAUDE.md-regel: bouw de payload
    // uit een expliciete lijst, verwijder nooit sleutels uit een object.
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

    // rowScope en het kolomTYPE komen uit een vaste lijst en mogen mee.
    assert.ok(payload.changes.some(c => c.path === 'rowScope' && c.value === 'own'));
    assert.ok(payload.changes.some(c => c.path === 'columns[].type' && c.value === 'number' && c.change === 'added'));
    // De kolomNAAM is door iemand ingetypt en gaat nooit mee.
    assert.ok(!json.includes('Klantnaam'));
    assert.ok(!json.includes('Van Dijk'));
});

test('een waarde die WEL als token leest maar op geen toegelaten pad staat, reist niet mee', () => {
    // Het eerste slot, apart getoetst. Niet elk persoonsgegeven bevat een spatie
    // of een apenstaartje: een telefoonnummer, een klantnummer en een URL met
    // een bedrijfsnaam erin lezen alle drie als keurig token. Ze mogen niet mee
    // omdat hun PAD er niet bij staat — niet omdat hun vorm ze verraadt.
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

    // Hetzelfde voor twee velden die WEL in FIELD_ALLOW staan: het pad mag
    // beschreven worden, de waarde reist niet mee.
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
    // Een muur van paden leest geen model, en elk pad is een stukje
    // sleutelvocabulaire dat het huis verlaat. Begrensd, dus.
    const wide = (n, offset) => {
        const definition = {};
        for (let i = 0; i < n; i++) definition[`veld_${i}`] = i + offset;
        return { ref: 'app_1', definition };
    };
    const payload = modelPayload('app', wide(200, 0), wide(200, 1));
    assert.ok(payload.changes.length <= MAX_FACTS, `${payload.changes.length} feiten`);

    // Ook langs de array-kant, waar de feiten in één ronde worden opgestapeld
    // in plaats van per sleutel opnieuw langs de grens te komen.
    const steps = (n) => ({ ref: 'aut_1', definition: { steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, type: `type_${i}` })) } });
    const many = modelPayload('automation', steps(1), steps(60));
    assert.ok(many.changes.length <= MAX_FACTS, `${many.changes.length} feiten uit een array`);
});

test('vrije tekst op een toegelaten waardepad valt alsnog af', () => {
    // Het tweede slot. Mocht er ooit vrije tekst op een pad uit VALUE_PATHS
    // belanden, dan reist de waarde niet mee — het feit dat het veld wijzigde
    // wel.
    const before = { ref: 'aut_1', triggerType: 'manual' };
    const after = { ref: 'aut_1', triggerType: 'mail van jan@vandijk.nl' };
    const payload = modelPayload('automation', before, after);
    assert.deepStrictEqual(payload.changes, [{ path: 'triggerType', change: 'changed' }]);
    assert.ok(!JSON.stringify(payload).includes('vandijk'));
});

test('een objectsleutel die geen schema is, wordt geen pad', () => {
    // Sleutels zijn normaal schema (`steps`, `config`), maar een formulier kan
    // op een e-mailadres gesleuteld zijn. Dan is de sleutel data.
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
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);
    const { deps, sent } = llm();
    await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });

    const user = sent.find(s => s.messages).messages.find(m => m.role === 'user');
    const payload = JSON.parse(user.content);
    assert.deepStrictEqual(Object.keys(payload).sort(), ['changes', 'kind']);
    assert.strictEqual(payload.kind, 'automation');
    assert.ok(payload.changes.every(c => Object.keys(c).every(k => ['path', 'change', 'count', 'value'].includes(k))));
});

test('het model wordt verteld dat het niets mag verzinnen wat het niet ziet', async () => {
    // Het krijgt alleen paden. Zonder deze instructie vult een model de
    // ontbrekende waarden zelf in, en dan staat er een verzonnen e-mailadres in
    // de releasenotitie.
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);
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
    // Een allow-list die ergens wordt aangevuld is geen allow-list meer.
    assert.ok(Object.isFrozen(FIELD_ALLOW));
    for (const list of Object.values(FIELD_ALLOW)) assert.ok(Object.isFrozen(list));
    // Een Set is met Object.freeze NIET bevroren (het slot zit op de eigen
    // properties, niet op de inhoud), dus de lijst is een bevroren array.
    assert.ok(Object.isFrozen(VALUE_PATHS));
    assert.ok(Array.isArray(VALUE_PATHS));
    assert.throws(() => VALUE_PATHS.push('systemPrompt'), 'de lijst kan niet elders aangevuld worden');
    assert.ok(!VALUE_PATHS.includes('scheduleCron'), 'de cron reist als feit, niet als waarde');
    assert.ok(!VALUE_PATHS.includes('model'), 'het model-id van een agent reist als feit, niet als waarde');
});

test('summariseChange gooit nooit — ook niet zonder deps of met een kapotte client', async () => {
    const entity = routine();
    const changed = routine({ description: 'anders' });
    const boom = { llmClient: { chatForcedTool: async () => { throw new Error('boom'); } }, resolveModelForTierName: async () => 'm' };
    assert.strictEqual(await summariseChange({ kind: 'automation', before: entity, after: changed, deps: boom }), null);

    const nonsense = { llmClient: { chatForcedTool: async () => ({ structured: { summary: {} } }) }, resolveModelForTierName: async () => 'm' };
    assert.strictEqual(await summariseChange({ kind: 'automation', before: entity, after: changed, deps: nonsense }), null);

    // Een onbekend soort heeft geen allow-list en dus geen payload.
    assert.strictEqual(await summariseChange({ kind: 'notebook', before: entity, after: changed, deps: nonsense }), null);
});

test('buildReleaseNotes gooit niet als de hele tekstlaag omvalt', async () => {
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);
    const deps = {
        resolveModelForTierName: async () => 'm',
        llmClient: { chatForcedTool: () => { throw new Error('synchroon stuk'); } },
    };
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, userId: 'u_1', deps });
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]]);
});

// ── De begrenzing op een aanroep die nooit settelt ─────────────────────────

test('withTimeout laat een belofte die NOOIT settelt niet eeuwig hangen', async () => {
    // Dit is het enige dat een half-open socket begrenst: geen antwoord, geen
    // fout. De deadline in describeChanges redt het niet — die wordt getoetst
    // VOOR de await, niet tijdens. Haalt iemand de race weg, dan hangt de
    // aanroeper voor altijd, en zodra een route hem await hangt daarmee het
    // publicatieverzoek zelf.
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
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);
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
    // Een tier-resolutie zonder gebruiker negeert de org-override én de EU-modus
    // (modelResolver.applyEUOverrides/isEUModeActive) en valt terug op de
    // GLOBALE fast-tier. Dan zou de vorm van andermans Oplossing naar het model
    // van de instantie gaan in plaats van naar het model dat die werkruimte
    // koos. Onbekend hoort te versmallen, niet te verbreden.
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);

    const { deps, sent } = llm();
    const notes = await buildReleaseNotes({ previousManifest: before, manifest: after, deps });
    assert.deepStrictEqual(sent, [], 'geen resolutie en geen aanroep');
    assert.deepStrictEqual(notes.map(n => [n.change, n.text]), [['changed', null]],
        'de exacte diff staat er nog steeds — publiceren gaat gewoon door');
});

test('een persoonlijk project zonder organisatie mag wél — de gebruiker beslist', async () => {
    // `userOrgId` mag null zijn: een project zonder organisatie heeft er geen.
    // De gebruiker is de context die de EU-modus en de Privacy Shield draagt.
    const before = manifestOf({ automations: [routine()] });
    const after = manifestOf({ automations: [routine({ description: 'anders' })] }, 2);

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
        kind: 'automation', before: routine(), after: routine({ description: 'anders' }), deps,
    });
    assert.strictEqual(out, null);
    assert.deepStrictEqual(sent, []);
});

// ── De middelste krimpstap ────────────────────────────────────────────────

test('de tweede krimpstap houdt ALLE regels en haalt alleen de zinnen weg', async () => {
    // De bestaande krimptest raakt alleen de derde tak (de halveringslus). Deze
    // raakt de tweede, en die tak draagt het enige signaal dat "we konden het
    // niet opschrijven" van "de zinnen zijn eruit gehaald om te passen"
    // scheidt: `textsDropped`. Staat die vlag verkeerd, dan leest elke
    // gewijzigde regel op het scherm als een mislukte samenvatting.
    const rows = Array.from({ length: 40 }, (_, i) => ({
        kind: 'automation', entityId: `aut_${i}`, name: `Routine ${i}`,
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

    // En de valkuil die deze vlag afdekt: zonder hem is elke rij hier
    // "we konden het niet opschrijven", terwijl de zin er WEL was.
    assert.strictEqual(summaryMissing(payload.entities[0]), true);
});

test('een grens die kleiner is dan de lege envelop levert die lege envelop', () => {
    // Geen oneindige lus en geen null: kleiner dan `{"entities":[],...}` kan
    // niet, en dan is de eerlijke uitkomst de kleinste geldige envelop mét de
    // telling van wat er niet in past.
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
    // De race hierboven kapt af op `timeoutMs`, en die valt zonder opgave terug
    // op TIMEOUT_MS. Een grens die groot genoeg is om nooit te bijten is
    // hetzelfde als geen grens — en dan hangt de aanroeper alsnog. Beide
    // waarden staan hier dus met een bovengrens vast; de publicatieroute zet er
    // bovendien nog kleinere overheen (packaging.js, NOTE_CALL_TIMEOUT_MS).
    assert.ok(TIMEOUT_MS > 0 && TIMEOUT_MS <= 30_000, `één regel is geen ${TIMEOUT_MS}ms wachten waard`);
    assert.ok(DEADLINE_MS > 0 && DEADLINE_MS <= 60_000, `de hele tekstlaag mag geen ${DEADLINE_MS}ms duren`);
});
