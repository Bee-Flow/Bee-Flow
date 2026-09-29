/**
 * "Wat hangt er aan deze webpagina?" — en wat het antwoord NOOIT mag zeggen.
 *
 * Deze lijst voedt het Gebruikt-door-tabblad en straks de verwijderpoort, dus
 * de fout die telt is die ene: NIET WETEN dat terugkomt als ER IS NIETS. Elke
 * deelvraag heeft daarom twee tests — één waarin hij echt antwoordt, en één
 * waarin hij omvalt en dat moet ZEGGEN in plaats van nul te melden.
 *
 * Twee soorten zijn NIET te beantwoorden en hebben daarom geen scan: `agent`
 * (de bevoegdheid ontstaat bij de aanroep, er is geen rij) en `chat` (een
 * pagina in het zijpaneel reist per beurt mee en wordt nergens vastgelegd).
 * Het bouwgesprek op `webpages.chat_messages` telt bewust NIET mee: dat gaat
 * mee als de pagina weg is en kan dus niet stukgaan aan de verwijdering — het
 * als rij melden liet vrijwel elke pagina "in gebruik" heten, met de naam van
 * de pagina zelf als rij-titel.
 *
 * Draaien: cd server && node --test --test-reporter=tap core/webpages/webpageUsage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    usageForWebpage, redactForeign, scanAgent, scanChat, KINDS, REASONS,
} = require('./webpageUsage');

const PAGE = Object.freeze({
    id: 'wp-1',
    name: 'Prijslijst',
    userId: 'owner-1',
    projectId: 'proj-1',
});

/**
 * Een nep-pg-client.
 *   tables      — welke tabellen bestaan (de rest antwoordt to_regclass NULL)
 *   project     — de rij die de Oplossing-scan terugkrijgt (null = geen rij)
 *   automations — de rijen die de routine-scan terugkrijgt
 *   failOn      — scans waarvan de query gooit ('solution' | 'automation')
 *   probeFails  — de to_regclass-probe zelf valt om. Iets ANDERS dan een tabel
 *                 die er niet is, en dat verschil is een eigen test waard:
 *                 "deze installatie heeft geen Oplossingen" is een zin die
 *                 onwaar mag zijn over een installatie die ze wél heeft.
 */
function db({
    tables = ['projects', 'automations', 'webpages'], project = null, automations = [],
    failOn = [], probeFails = false,
} = {}) {
    const queries = [];
    return {
        queries,
        sqlFor(fragment) { return queries.find(q => q.sql.includes(fragment)); },
        query: async (sql, params) => {
            if (/to_regclass\(\$1\) AS t/.test(sql)) {
                queries.push({ sql, params });
                if (probeFails) throw new Error('pg is down');
                return { rows: [{ t: tables.includes(params[0]) ? params[0] : null }] };
            }
            queries.push({ sql, params });
            if (/FROM projects/.test(sql)) {
                if (failOn.includes('solution')) throw new Error('projects is down');
                return { rows: project ? [project] : [] };
            }
            if (/FROM automations/.test(sql)) {
                if (failOn.includes('automation')) throw new Error('automations is down');
                return { rows: automations };
            }
            throw new Error(`unexpected query: ${sql}`);
        },
    };
}

const PROJECT_ROW = {
    id: 'proj-1', name: 'Offertes', owner_id: 'owner-1', updated_at: '2026-09-01T00:00:00Z',
};

const rowsOf = (out, kind) => out.rows.filter(r => r.kind === kind);

// ── de Oplossing ────────────────────────────────────────────────────

test('solution: de Oplossing waarin de pagina ligt komt terug in het rijcontract', async () => {
    const d = db({ project: PROJECT_ROW });
    const out = await usageForWebpage(PAGE, { db: d });

    assert.deepStrictEqual(rowsOf(out, 'solution'), [{
        kind: 'solution',
        id: 'proj-1',
        title: 'Offertes',
        role: 'contains',
        ownerId: 'owner-1',
        lastAt: '2026-09-01T00:00:00Z',
    }]);
    assert.deepStrictEqual(out.sources.solution, { status: 'checked', found: 1 });
    assert.ok(!out.partial.includes('solution'));
});

test('solution: een pagina zonder Oplossing is GECONTROLEERD leeg — en vraagt de tabel niet eens', async () => {
    const d = db({ tables: ['webpages'] });
    const out = await usageForWebpage({ ...PAGE, projectId: null }, { db: d });

    assert.deepStrictEqual(rowsOf(out, 'solution'), []);
    assert.deepStrictEqual(out.sources.solution, { status: 'checked', found: 0 });
    assert.strictEqual(d.queries.filter(q => /to_regclass/.test(q.sql) && q.params[0] === 'projects').length, 0,
        'zonder project_id is de vraag al beantwoord; een probe zou elke losse pagina op een installatie zonder Oplossingen als "niet gecontroleerd" melden');
});

test('solution: geen projects-tabel is NIET nul — de soort meldt zich als niet gecontroleerd', async () => {
    const d = db({ tables: ['automations', 'webpages'] });
    const out = await usageForWebpage(PAGE, { db: d });

    assert.deepStrictEqual(rowsOf(out, 'solution'), []);
    assert.strictEqual(out.sources.solution.status, 'unavailable');
    assert.strictEqual(out.sources.solution.found, null, 'een aantal waar niemand voor kan instaan is geen aantal');
    assert.strictEqual(out.sources.solution.reason, REASONS.NO_PROJECTS_TABLE);
    assert.ok(out.partial.includes('solution'));
    assert.strictEqual(out.complete, false);
});

test('solution: een query die omvalt meldt zich, en wist de andere deelvragen niet', async () => {
    const d = db({ project: PROJECT_ROW, automations: [AUTOMATION_ROW], failOn: ['solution'] });
    const out = await usageForWebpage(PAGE, { db: d });

    assert.strictEqual(out.sources.solution.status, 'unavailable');
    assert.strictEqual(out.sources.solution.reason, REASONS.SCAN_FAILED);
    assert.ok(out.partial.includes('solution'));
    assert.strictEqual(out.sources.automation.status, 'checked',
        'een omgevallen scan mag de andere niet meesleuren');
    assert.strictEqual(rowsOf(out, 'automation').length, 1);
});

test('solution: een wijzer naar een verwijderde Oplossing is gecontroleerd leeg, geen naamloze rij', async () => {
    const d = db({ project: null });
    const out = await usageForWebpage(PAGE, { db: d });

    assert.deepStrictEqual(rowsOf(out, 'solution'), []);
    assert.deepStrictEqual(out.sources.solution, { status: 'checked', found: 0 });
});

// ── de routines ─────────────────────────────────────────────────────
//
// De soort die er eerst helemaal niet was — niet als scan en ook niet als
// onbeantwoorde soort, dus er was geen enkel veld waarin het antwoord "ik heb
// niet gekeken" terechtkwam. Een routine bindt een pagina DUURZAAM (het
// meegeleverde sjabloon in automation/templates.js draagt een
// `webpage_db_exec`-stap met een literal `webpageId`), en zonder deze scan
// verdween zij uit élk scherm dat de vraag stelt om daarna stil te falen.

const AUTOMATION_ROW = {
    id: 'auto-1', title: 'Facturen verwerken', owner_id: 'owner-1', last_at: '2026-09-02T00:00:00Z',
};

test('automation: een routine die de pagina bij naam noemt komt terug in het rijcontract', async () => {
    const d = db({ automations: [AUTOMATION_ROW] });
    const out = await usageForWebpage({ ...PAGE, projectId: null }, { db: d });

    assert.deepStrictEqual(rowsOf(out, 'automation'), [{
        kind: 'automation',
        id: 'auto-1',
        title: 'Facturen verwerken',
        role: 'readwrite',
        ownerId: 'owner-1',
        lastAt: '2026-09-02T00:00:00Z',
    }]);
    assert.deepStrictEqual(out.sources.automation, { status: 'checked', found: 1 });
});

test('automation: geen routine is GECONTROLEERD leeg', async () => {
    const d = db({ automations: [] });
    const out = await usageForWebpage({ ...PAGE, projectId: null }, { db: d });

    assert.deepStrictEqual(rowsOf(out, 'automation'), []);
    assert.deepStrictEqual(out.sources.automation, { status: 'checked', found: 0 });
    assert.ok(!out.partial.includes('automation'));
});

test('automation: het id gaat via de VARS-parameter, nooit in het jsonpath', async () => {
    const d = db({ automations: [] });
    await usageForWebpage({ ...PAGE, projectId: null }, { db: d });

    const q = d.sqlFor('FROM automations');
    assert.deepStrictEqual(q.params, ['wp-1'], 'het id is een parameter, geen tekst in het pad');
    assert.ok(/jsonb_build_object\('id', \$1::text\)/.test(q.sql),
        'een waarde met een aanhalingsteken zou anders de stringliteraal IN het jsonpath sluiten');
    assert.ok(/\$\.\*\*\.webpageId\.value/.test(q.sql), 'de gebonden vorm {kind:literal, value:…}');
    assert.ok(/\$\.\*\*\.webpageId \?/.test(q.sql), 'en de kale vorm die oudere definities dragen');
});

test('automation: geen automations-tabel is NIET nul', async () => {
    const d = db({ tables: ['projects', 'webpages'] });
    const out = await usageForWebpage({ ...PAGE, projectId: null }, { db: d });

    assert.strictEqual(out.sources.automation.status, 'unavailable');
    assert.strictEqual(out.sources.automation.found, null);
    assert.strictEqual(out.sources.automation.reason, REASONS.NO_AUTOMATIONS_TABLE);
    assert.ok(out.partial.includes('automation'));
});

test('automation: een query die omvalt meldt zich als scan-failed', async () => {
    const d = db({ failOn: ['automation'] });
    const out = await usageForWebpage({ ...PAGE, projectId: null }, { db: d });

    assert.strictEqual(out.sources.automation.status, 'unavailable');
    assert.strictEqual(out.sources.automation.reason, REASONS.SCAN_FAILED);
});

// ── een probe die zelf omvalt ───────────────────────────────────────

test('een omgevallen PROBE is iets anders dan een tabel die er niet is', async () => {
    const d = db({ probeFails: true });
    const out = await usageForWebpage(PAGE, { db: d });

    // Allebei blokkeren ze de verwijdering, maar de client bouwt op
    // `no-projects-table` de zin "deze installatie heeft geen Oplossingen" —
    // en die zin is onwaar over een installatie die ze wél heeft.
    assert.strictEqual(out.sources.solution.reason, REASONS.PROBE_FAILED);
    assert.strictEqual(out.sources.automation.reason, REASONS.PROBE_FAILED);
    assert.notStrictEqual(REASONS.PROBE_FAILED, REASONS.NO_PROJECTS_TABLE);
});

// ── de gesprekken en de agents ──────────────────────────────────────

test('chat: het BOUWGESPREK is geen afhankelijkheid — het gaat mee met de pagina', async () => {
    const d = db({ project: PROJECT_ROW });
    const out = await usageForWebpage(PAGE, { db: d });

    assert.deepStrictEqual(rowsOf(out, 'chat'), [],
        'een ding dat samen met de pagina verdwijnt kan niet stukgaan aan de verwijdering');
    // En er wordt niet naar chat_messages gevraagd: die kolom beantwoordt de
    // vraag niet die deze soort stelt.
    assert.strictEqual(d.sqlFor('chat_messages'), undefined);
});

test('chat: de vraag die er wél is — een pagina in het zijpaneel — is niet vastgelegd', async () => {
    const d = db({ project: PROJECT_ROW });
    const out = await usageForWebpage(PAGE, { db: d });

    assert.strictEqual(out.sources.chat.status, 'unavailable');
    assert.strictEqual(out.sources.chat.found, null);
    assert.strictEqual(out.sources.chat.reason, REASONS.NOT_RECORDED);
    assert.ok(out.partial.includes('chat'),
        'de soort met deze naam mag zich niet als beantwoord melden over een vraag die niemand kan beantwoorden');
});

test('chat: er wordt niets aan de database gevraagd — er is niets te vragen', async () => {
    const out = await scanChat();
    assert.deepStrictEqual(out.rows, []);
    assert.strictEqual(out.unchecked, REASONS.NOT_RECORDED);
});

test('agent: niet vast te stellen — dus onbeantwoord, nooit nul', async () => {
    const d = db({ project: PROJECT_ROW });
    const out = await usageForWebpage(PAGE, { db: d });

    assert.deepStrictEqual(rowsOf(out, 'agent'), []);
    assert.strictEqual(out.sources.agent.status, 'unavailable');
    assert.strictEqual(out.sources.agent.found, null);
    assert.strictEqual(out.sources.agent.reason, REASONS.NOT_RECORDED);
    assert.ok(out.partial.includes('agent'));
    assert.strictEqual(out.complete, false,
        'zolang één deelvraag onbeantwoord is, mag geen scherm "niets gebruikt deze pagina" zeggen');
});

test('agent: er wordt niets gevraagd aan de database — er is niets te vragen', async () => {
    const out = await scanAgent();
    assert.deepStrictEqual(out.rows, []);
    assert.strictEqual(out.unchecked, REASONS.NOT_RECORDED);
});

// ── het geheel ──────────────────────────────────────────────────────

test('elke soort komt in `sources` voor, ook als hij niets vond', async () => {
    const d = db({ project: PROJECT_ROW, automations: [AUTOMATION_ROW] });
    const out = await usageForWebpage(PAGE, { db: d });

    assert.deepStrictEqual(Object.keys(out.sources).sort(), [...KINDS].sort(),
        'een soort die uit het antwoord verdwijnt, verkleint stilletjes de vraag');
    assert.deepStrictEqual(out.partial, ['chat', 'agent'],
        'twee soorten zijn structureel onbeantwoordbaar en zeggen dat allebei');
});

test('de scan leest de PAGINARIJ, niet alleen haar id', async () => {
    // Wie de route ooit "opschoont" tot `usageForWebpage({ id })` breekt niets
    // zichtbaars: scanSolution ziet dan geen projectId en meldt "gecontroleerd,
    // nul rijen" voor een pagina die wél in een Oplossing ligt — een echte
    // afhankelijkheid die als een BEVESTIGDE nul uit de lijst valt.
    const withRow = await usageForWebpage(PAGE, { db: db({ project: PROJECT_ROW }) });
    assert.strictEqual(rowsOf(withRow, 'solution').length, 1);

    const idOnly = await usageForWebpage({ id: PAGE.id }, { db: db({ project: PROJECT_ROW }) });
    assert.deepStrictEqual(rowsOf(idOnly, 'solution'), []);
    assert.deepStrictEqual(idOnly.sources.solution, { status: 'checked', found: 0 },
        'dit is de stand die de route NIET mag veroorzaken — zie routes/webpagesUsage.test.js');
});

test('zonder pagina wordt er niets beweerd: elke soort onbeantwoord', async () => {
    for (const bad of [null, undefined, {}, { id: '' }]) {
        const out = await usageForWebpage(bad, { db: db() });
        assert.deepStrictEqual(out.rows, []);
        assert.deepStrictEqual(out.partial.sort(), [...KINDS].sort());
        assert.strictEqual(out.complete, false);
        for (const kind of KINDS) assert.strictEqual(out.sources[kind].found, null);
    }
});

// ── wat een ander te horen krijgt ───────────────────────────────────

test('redactForeign: andermans Oplossing houdt soort en rol, en verliest zijn naam', () => {
    const rows = [
        { kind: 'solution', id: 'p1', title: 'Offertes van een collega', role: 'contains', ownerId: 'someone-else' },
        { kind: 'automation', id: 'auto-1', title: 'Facturen', role: 'readwrite', ownerId: 'owner-1' },
        { kind: 'solution', id: 'p2', title: 'Org-breed', role: 'contains', ownerId: null },
    ];
    const [foreign, mine, ownerless] = redactForeign(rows, 'owner-1');

    assert.strictEqual(foreign.title, null);
    assert.strictEqual(foreign.foreign, true);
    assert.strictEqual(foreign.kind, 'solution');
    assert.strictEqual(foreign.role, 'contains');
    assert.strictEqual(mine.title, 'Facturen', 'de eigen rij blijft heel');
    assert.strictEqual(mine.foreign, undefined);
    assert.strictEqual(ownerless.title, 'Org-breed', 'een rij zonder eigenaar is van niemand privé');
});
