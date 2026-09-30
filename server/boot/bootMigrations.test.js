'use strict';

/**
 * Elk bestand in server/migrations/ is verantwoord — afgedwongen.
 *
 * De wond die deze test dichthoudt: elf van de vijfentwintig add-nl-catalogi
 * stonden jarenlang op de plank. Geen fout, geen rode test — een catalogus die
 * nergens geregistreerd staat draait nergens, en het symptoom (een stil Engels
 * scherm) is onzichtbaar voor wie de feature bouwde. Zes ervan waren bovendien
 * alleen als handmatig script te draaien (ze draaiden bij require en riepen
 * process.exit — dodelijk in een boot-ladder).
 *
 * Vanaf nu is elk migratiebestand precies één van deze dingen:
 *   1. geregistreerd in bootMigrations (LOOSE_MIGRATIONS of NL_TRANSLATIONS),
 *   2. expliciet handmatig (MANUAL_MIGRATIONS, met reden),
 *   3. aangeroepen door runtime-code (een store-ladder zoals
 *      automationStore/core.js, of een route/seed die hem draait of citeert),
 *   4. opgenomen: zijn DDL is sindsdien in het schema van een store gevouwen
 *      (ABSORBED hieronder, met een controleerbare claim).
 * Een nieuw bestand dat nergens in past is een RODE TEST met een aanwijzing,
 * geen vergeten bestand.
 *
 * ── En de andere kant op: NIEUWE kolommen ────────────────────────────────
 *
 * De `schema_migrations`-ledger van bootMigrations.js registreert alleen de
 * twee lijsten hierboven; store-DDL staat er niet in. Een nieuwe kolom hoort
 * in de idempotente boot-DDL van zijn eigen store, en dan via `runDdl`
 * (stores/lib/_ddl.js) —
 * niet in een los migratiebestand, en niet in een `DO $$ … EXCEPTION WHEN
 * OTHERS THEN NULL`-blok, want dat slikt een statement-timeout net zo hard in
 * als "kolom bestaat al" en de store meldt zich gezond op een half schema.
 * COLUMN_LADDERS hieronder is de controleerbare claim per kolom: het genoemde
 * bestand bestaat, noemt de kolom, en noemt hem in zijn runDdl-lijst.
 *
 * Statisch en DB-vrij met opzet, net als migrateDb.registration.test.js:
 * registratie is een tekstueel feit; dat de ladder echt draait en idempotent
 * is bewijst migrateDb.integration.test.js tegen echte Postgres.
 *
 * Run: cd server && node --test --test-force-exit boot/bootMigrations.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const { LOOSE_MIGRATIONS, NL_TRANSLATIONS, MANUAL_MIGRATIONS } = require('./bootMigrations');

/**
 * Migratiebestanden waarvan de DDL sindsdien in de eigen schema-ladder van een
 * store is gevouwen. Elke entry is een claim die deze test zelf controleert:
 * het opnemende bestand bestaat én bevat de genoemde marker nog. Verdwijnt de
 * marker daar, dan is de claim vals en hoort de migratie alsnog in een lijst.
 */
const ABSORBED = new Map([
    ['nc-pending-bindings-2026-05', { into: 'stores/user/schema.js', marker: 'CREATE TABLE IF NOT EXISTS pending_nc_bindings' }],
    ['nc-pending-bindings-pairing-code-2026-05', { into: 'stores/user/schema.js', marker: 'pairing_code' }],
    ['stripe-cancel-and-period-end-2026-05', { into: 'stores/user/schema.js', marker: 'cancel_at_period_end' }],
]);

/**
 * Kolommen die via de store-ladder komen in plaats van via een migratiebestand.
 * Elke entry is een claim die deze test narekent: het bestand bestaat, de kolom
 * staat erin, en hij staat in een `runDdl(...)`-aanroep — niet in een stil
 * `DO $$ … EXCEPTION`-blok ernaast.
 *
 * `table` is optioneel en hoort erbij zodra de kolomnaam GEWOON is. `version`
 * bestaat op summary_templates én (via een migratiebestand) op skills; zonder
 * tabelnaam zou de "geen eigen migratiebestand"-test die twee als dezelfde
 * kolom lezen en rood gaan op een migratie die met deze store niets te maken
 * heeft. De tabelnaam maakt van de claim een claim over één kolom van één
 * tabel — wat hij altijd al was, en sinds de A1c-ronde ook wat de matcher
 * narekent: het statement dat de kolom toevoegt moet díé tabel noemen.
 *
 * `kind: 'table'` is de tweede vorm: dan gaat de claim over een TABEL die de
 * ladder maakt (`CREATE TABLE IF NOT EXISTS <table>`) en hoort er geen `column`
 * bij. Elke andere `kind` is een bezwaar — een claim die je niet kunt
 * opschrijven faalt niet, hij zwijgt.
 */
const COLUMN_LADDERS = [
    // O3: waar een Oplossing vandaan komt. Zachte verwijzing, geen FK — een
    // verwijderde Blueprint mag het project niet meenemen.
    { column: 'installed_from_blueprint_id', into: 'stores/projectStore.js', tag: 'projectStore' },
    // O4: en wat die herkomst er verder over zegt. `installed_from_org_id` is
    // de bron-organisatie (vastgesteld bij een galerij-installatie, beweerd bij
    // een bestandsinstallatie) en beslist NOOIT iets — toegang komt van
    // blueprintStore.canRead over de echte galerijrij. `installed_version`
    // krijgt zijn tabelnaam mee omdat die kolomnaam GEWOON is: hij bestaat ook
    // op project_solution_entities.
    { column: 'installed_from_org_id', table: 'projects', into: 'stores/projectStore.js', tag: 'projectStore' },
    { column: 'installed_version', table: 'projects', into: 'stores/projectStore.js', tag: 'projectStore' },
    // The collaborative project workspace: `kind` tells a project from a
    // Studio Solution (NULL = from before the split; the backfill migration
    // only UPDATEs it), and `files_kb_id` names the knowledge base holding the
    // files uploaded into the project. Both come from the store's ladder.
    { column: 'kind', table: 'projects', into: 'stores/projectStore.js', tag: 'projectStore' },
    { column: 'files_kb_id', table: 'projects', into: 'stores/projectStore.js', tag: 'projectStore' },
    // Documents and meeting notes filed into a project: soft references on
    // their own rows, cleared when the project is deleted.
    { column: 'project_id', table: 'studio_documents', into: 'stores/documentStore.js', tag: 'documentStore' },
    { column: 'project_id', table: 'transcriptions', into: 'stores/transcriptionStore.js', tag: 'transcriptionStore' },

    // O4: de publicatiegeschiedenis zelf. `kind: 'table'`, want de claim gaat over
    // een TABEL die de ladder maakt en niet over een kolom. De galerijrij
    // (project_blueprints) wordt bij elke publicatie overschreven en is dus een
    // uitspraak over het heden; project_releases is wat er ooit is uitgegeven,
    // één onveranderlijke rij per publicatie met het manifest zoals gepubliceerd.
    { table: 'project_releases', kind: 'table', into: 'stores/blueprintStore.js', tag: 'blueprintStore' },
    // M4 stap 3: met welk sjabloon (en welke versie ervan) een notitie
    // geschreven is. De versie staat bij de NOTITIE en niet alleen bij het
    // sjabloon, anders leest het scherm een uitspraak over het verleden af aan
    // het heden.
    { column: 'version', table: 'summary_templates', into: 'stores/summaryTemplateStore.js', tag: 'summaryTemplateStore' },
    { column: 'summary_template_id', table: 'transcriptions', into: 'stores/transcriptionStore.js', tag: 'transcriptionStore' },
    { column: 'summary_template_version', table: 'transcriptions', into: 'stores/transcriptionStore.js', tag: 'transcriptionStore' },
    // A1c: de persona-editor en de twee testset-tabellen. Alle drie uit
    // stores/agent/initSchema.js, alle drie zonder eigen migratiebestand.
    { column: 'persona', table: 'agents', into: 'stores/agent/initSchema.js', tag: 'agentSchema' },
    { table: 'agent_tests', kind: 'table', into: 'stores/agent/initSchema.js', tag: 'agentSchema' },
    { table: 'agent_test_runs', kind: 'table', into: 'stores/agent/initSchema.js', tag: 'agentSchema' },
    // A4 deel D: WIE de verwachting van een test schreef. `written_by` is de
    // per-veld herkomst uit core/agentRuntime/testSuggest.js, `suggested_by`
    // het model dat het voorstel deed. Allebei NULL voor een test die iemand
    // zelf tikte — en dat onderscheid is precies waarom ze een kolom zijn en
    // geen sleutel in `expect`: `expect` is wat de grader leest, en een
    // herkomstveld dat daarin meereist zou een verwachting worden.
    { column: 'written_by', table: 'agent_tests', into: 'stores/agent/initSchema.js', tag: 'agentSchema' },
    { column: 'suggested_by', table: 'agent_tests', into: 'stores/agent/initSchema.js', tag: 'agentSchema' },
    // BIJT: de invoegvolgorde-teller die `ran_at DESC` als tiebreaker
    // vervangt (stores/agent/agentTests.js) — runs uit dezelfde milliseconde
    // kwamen anders terug in id-volgorde, willekeurig en soms exact omgekeerd.
    { column: 'seq', table: 'agent_test_runs', into: 'stores/agent/initSchema.js', tag: 'agentSchema' },

    // W4: de versielijst als leesbare geschiedenis. `seq` is het nummer dat de
    // lezer ziet (v14) — created_at kan dat niet zijn, want dat is transactietijd.
    // `actor_user_id` is een ZACHTE verwijzing: een verwijderd account mag de
    // geschiedenis van de pagina niet meenemen. `line_delta` is NULL wanneer er
    // niets is gemeten, en dat is iets anders dan 0 regels.
    { column: 'seq', table: 'webpage_versions', into: 'stores/webpage/schema.js', tag: 'webpageSchema' },
    { column: 'actor_user_id', table: 'webpage_versions', into: 'stores/webpage/schema.js', tag: 'webpageSchema' },
    { column: 'line_delta', table: 'webpage_versions', into: 'stores/webpage/schema.js', tag: 'webpageSchema' },

    // M5: de per-vergadering opnamevoorkeur. Eigen tabel, eigen store-ladder,
    // geen migratiebestand.
    { table: 'meeting_prefs', kind: 'table', into: 'stores/meetingPrefsStore.js', tag: 'meetingPrefsStore' },

    // P4 deel C: "welke knop draait deze routine". De spiegel van
    // automation_datatable_usage, en met opzet een EIGEN tabel: die index is
    // per tabel-doel gekeyd (`datatable_id … REFERENCES datatables(id)`), dus
    // een app→routine-rij heeft er geen waarde voor en de INSERT zou nul rijen
    // schrijven en zichzelf geslaagd noemen. Eigen store, eigen ladder, geen
    // migratiebestand.
    { table: 'automation_usage', kind: 'table', into: 'stores/automationUsageStore.js', tag: 'automationUsageStore' },
    // Het DERDE antwoord van diezelfde index: "deze app is nog nooit
    // geindexeerd". `automation_usage` kan alleen rijen tonen, en nul rijen
    // betekent daar zowel "geen enkele knop" als "nog nooit gekeken" — op de
    // dag van uitrol is dat tweede waar voor élke bestaande app. Deze
    // bijhoudtabel maakt de twee scheidbaar en is tegelijk de werklijst van de
    // backfill. Zelfde store, zelfde ladder, zelfde tag: één runDdl-blok.
    { table: 'automation_usage_indexed', kind: 'table', into: 'stores/automationUsageStore.js', tag: 'automationUsageStore' },
];

function migrationNames() {
    return fs.readdirSync(path.join(SERVER, 'migrations'))
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map((f) => f.slice(0, -3))
        .sort();
}

/**
 * Alle niet-test runtimebron buiten migrations/ en de ladder zelf: daar staat
 * de bedrading van store-ladders (automationStore/core.js MIGRATIONS,
 * studioAppStore, knowledgeBases) en van seeds/routes. bootMigrations.js en
 * migrateDb.js tellen bewust niet mee — anders zou "staat in de lijst" en
 * "wordt door code gedraaid" hetzelfde feit zijn.
 */
function runtimeSources() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === 'migrations') continue;
                walk(p);
                continue;
            }
            if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue;
            if (p === path.join(SERVER, 'migrateDb.js') || p === path.join(__dirname, 'bootMigrations.js')) continue;
            out.push(fs.readFileSync(p, 'utf8'));
        }
    };
    for (const dir of ['stores', 'core', 'routes', 'modules', 'automation', 'boot']) {
        const p = path.join(SERVER, dir);
        if (fs.existsSync(p)) walk(p);
    }
    for (const e of fs.readdirSync(SERVER, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js') && e.name !== 'migrateDb.js') {
            out.push(fs.readFileSync(path.join(SERVER, e.name), 'utf8'));
        }
    }
    return out;
}

test('elk migratiebestand is geregistreerd, handmatig, opgenomen, of door runtime-code bedraad', () => {
    const accounted = new Set([...LOOSE_MIGRATIONS, ...NL_TRANSLATIONS, ...MANUAL_MIGRATIONS, ...ABSORBED.keys()]);
    const sources = runtimeSources();
    const orphans = migrationNames()
        .filter((n) => !accounted.has(n))
        .filter((n) => !sources.some((src) => src.includes(n)));
    assert.deepStrictEqual(orphans, [],
        'deze migraties draaien nergens en zijn nergens verantwoord.\n' +
        'Zet ze in LOOSE_MIGRATIONS of NL_TRANSLATIONS (boot/bootMigrations.js) als ze bij\n' +
        'elke boot horen te draaien, in MANUAL_MIGRATIONS als een operator ze bewust met de\n' +
        'hand draait, of in ABSORBED in deze test als hun DDL in een store-schema is gevouwen.');
});

test('geen naam staat in twee categorieën tegelijk', () => {
    // Twee lijsten die dezelfde migratie draaien is dubbel werk; een naam die
    // én handmatig én automatisch is, is een tegenspraak in het contract.
    const lists = { LOOSE_MIGRATIONS, NL_TRANSLATIONS, MANUAL_MIGRATIONS, ABSORBED: [...ABSORBED.keys()] };
    const seen = new Map();
    const dupes = [];
    for (const [list, names] of Object.entries(lists)) {
        for (const n of names) {
            if (seen.has(n)) dupes.push(`${n} (${seen.get(n)} én ${list})`);
            seen.set(n, list);
        }
    }
    assert.deepStrictEqual(dupes, []);
});

test('elke geregistreerde of handmatige naam bestaat op schijf', () => {
    const missing = [...LOOSE_MIGRATIONS, ...NL_TRANSLATIONS, ...MANUAL_MIGRATIONS, ...ABSORBED.keys()]
        .filter((n) => !fs.existsSync(path.join(SERVER, 'migrations', `${n}.js`)));
    assert.deepStrictEqual(missing, [], 'de ladder of een claim noemt een migratie die niet bestaat');
});

test('elke entry die de ladder draait exporteert up() en draait niets bij require', () => {
    // runList doet `require(naam).up()`. Een bestand zonder up-export crasht de
    // ladder; een bestand dat bij require zelf gaat draaien (het oude
    // `run().catch(...)` mét process.exit) legt de BOOT plat.
    //
    // Genuinely textual, met opzet: de enige manier om "draait niets bij
    // require" ECHT te proberen is het bestand vereisen — en precies dát is
    // onveilig als de eigenschap kapot is (een `process.exit()` bij require
    // beëindigt dan dit testproces zelf, in plaats van één rode assertie te
    // geven). Hetzelfde geldt voor de up()-export: eerst moet vaststaan dat
    // require veilig is voordat "vereis het en kijk of up() een functie is"
    // een zinnig behavioural alternatief zou zijn.
    for (const n of [...LOOSE_MIGRATIONS, ...NL_TRANSLATIONS]) {
        const src = fs.readFileSync(path.join(SERVER, 'migrations', `${n}.js`), 'utf8');
        assert.match(src, /module\.exports\s*=\s*\{\s*up\b|module\.exports\.up\s*=/,
            `${n}: exporteert geen up() — runList kan hem niet draaien`);
        const bare = src
            .replace(/if\s*\(\s*require\.main\s*===\s*module\s*\)\s*\{[\s\S]*?\n\}/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.ok(!/^\s*(up|run)\s*\(\s*\)/m.test(bare),
            `${n}: roept zichzelf bij require aan — zet de aanroep achter een require.main-guard`);
    }
});

test('elke ABSORBED-claim klopt nog', () => {
    for (const [name, { into, marker }] of ABSORBED) {
        const p = path.join(SERVER, into);
        assert.ok(fs.existsSync(p), `${name}: opnemend bestand ${into} bestaat niet meer`);
        assert.ok(fs.readFileSync(p, 'utf8').includes(marker),
            `${name}: ${into} bevat "${marker}" niet meer — de opname-claim is vals, registreer de migratie alsnog`);
    }
});

/**
 * ── De matcher achter COLUMN_LADDERS ──────────────────────────────────────
 *
 * Losgetrokken uit de test omdat een matcher die een claim niet KAN uitdrukken
 * niet faalt — hij zwijgt, en dan bewaakt de lijst precies die toevoegingen
 * niet die nieuw genoeg zijn om bewaking te verdienen. Hij is nu zelf getoetst
 * (zie de matcher-tests onderaan dit bestand).
 *
 * Een entry claimt ÉÉN schema-toevoeging:
 *
 *   { column, table?, into, tag }            — een KOLOM in de ladder
 *   { table, kind: 'table', into, tag }      — een TABEL die de ladder maakt
 *
 * `kind: 'table'` bestaat omdat `agent_tests` en `agent_test_runs` geen
 * kolommen zijn: hun toevoeging is een CREATE TABLE, en "de naam staat in het
 * blok" zou daar ook waar zijn van een index of een FK die de tabel alleen
 * NOEMT. De claim is dat de ladder hem MAAKT.
 */

/**
 * Index van het sluitteken dat hoort bij het openteken op `open`, of -1.
 *
 * Strings (', " en `) en commentaar tellen niet mee: de SQL in deze bestanden
 * zit vol haakjes (`agent_conversations(user_id)`) en de Nederlandse
 * commentaarregels vol apostroffen. Zonder dat onderscheid telt de scanner de
 * inhoud van een statement mee als code.
 */
function matchDelimiter(src, open) {
    const OPEN = src[open];
    const CLOSE = { '(': ')', '[': ']' }[OPEN];
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') {
            i = src.indexOf('\n', i);
            if (i < 0) return -1;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const e = src.indexOf('*/', i + 2);
            if (e < 0) return -1;
            i = e + 1;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
            if (j >= src.length) return -1;
            i = j;
            continue;
        }
        if (c === OPEN) depth++;
        else if (c === CLOSE && --depth === 0) return i;
    }
    return -1;
}

/**
 * ELKE `runDdl('<tag>', …)`-aanroep in een bron, als tekst.
 *
 * Twee dingen zaten hier fout, en samen maakten ze de A1c-claims
 * onopschrijfbaar:
 *
 *   1. Er werd alleen naar de EERSTE aanroep gekeken (`indexOf`). Een tag is
 *      per store, niet per aanroep — stores/agent/initSchema.js heeft er tien
 *      onder 'agentSchema' — dus alles voorbij de eerste las als "staat buiten
 *      de ladder".
 *   2. Het blok werd afgekapt op de eerste `]);`. Dat is niet het einde van de
 *      aanroep: het flatMap-blok sluit met `]));` en liep daardoor dóór tot in
 *      het volgende blok, terwijl een blok dat ermee eindigt precies één regel
 *      te vroeg stopte.
 *
 * Daarom nu de CALL zelf, van `(` tot het bijbehorende `)` — dat is per
 * definitie alles wat aan runDdl wordt meegegeven, hoe het ook is opgebouwd.
 */
function runDdlCalls(src, tag) {
    const needle = `runDdl('${tag}'`;
    const out = [];
    for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + needle.length)) {
        const open = at + 'runDdl'.length;
        const close = matchDelimiter(src, open);
        if (close > open) out.push(src.slice(open, close + 1));
    }
    return out;
}

/**
 * De bron zonder commentaar.
 *
 * Een NOEMING in een `//`- of `/* *\/`-commentaar telde als bewijs dat de
 * ladder de kolom maakt: `knowledge_base_ids` staat in een toelichting BINNEN
 * hetzelfde runDdl-blok, dus wis je de echte ALTER, dan bleef de claim groen op
 * het commentaar dat erover ging. Commentaar maakt geen kolom.
 */
function stripComments(src) {
    return String(src)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** De losse DDL-statements in een blok: de template-literals die erin staan. */
function ddlStatements(block) {
    const out = [];
    const re = /`([^`]*)`/g;
    let m;
    while ((m = re.exec(block))) out.push(m[1]);
    return out;
}

/** Waar één entry over gaat, als regex. Zie de kop hierboven voor de vormen. */
function claimNeedle({ column, table, kind }) {
    return kind === 'table'
        ? new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${table}\\b`)
        // Op WOORD, niet op substring: `version` mag niet matchen op
        // `published_version`.
        : new RegExp(`\\b${column}\\b`);
}

function claimLabel({ column, table, kind }) {
    if (kind === 'table') return `tabel ${table}`;
    return table ? `${column} (${table})` : `${column}`;
}

/**
 * De bezwaren tegen één ladderclaim. Leeg = de claim klopt.
 *
 * Alles wat niet na te rekenen is, is een BEZWAAR — nooit stilte. Een entry
 * die niets noemt, een `into` dat niet te lezen is en een tag zonder aanroep
 * verschillen in melding maar niet in uitkomst: geen van drieën is een groene
 * claim.
 */
function ladderProblems(entry) {
    const { column, table, into, tag, kind } = entry || {};
    const label = claimLabel(entry || {});

    if (kind !== undefined && kind !== 'table') return [`${label}: onbekende kind '${kind}'`];
    if (kind === 'table' ? !table : !column) {
        return [`${JSON.stringify(entry)}: noemt geen kolom (of geen tabel bij kind: 'table')`];
    }
    if (!into || !tag) return [`${label}: mist into of tag`];

    let raw;
    try {
        raw = fs.readFileSync(path.join(SERVER, into), 'utf8');
    } catch (e) {
        // Ontbrekend en onleesbaar zijn verschillende waarden — vandaar de code
        // in de melding — maar geen van beide betekent "klopt".
        return [`${label}: ${into} is niet te lezen (${e.code || e.message})`];
    }
    // Commentaar telt niet mee: een noeming in een toelichting is geen DDL.
    const src = stripComments(raw);

    const problems = [];
    const needle = claimNeedle(entry);
    if (!needle.test(src)) problems.push(`${label}: staat niet meer in ${into}`);
    if (!/require\(['"][^'"]*_ddl['"]\)/.test(raw)) {
        problems.push(`${into}: importeert stores/lib/_ddl.js niet meer`);
    }

    // De toevoeging moet BINNEN een runDdl-aanroep met deze tag staan. Een
    // ADD COLUMN die naar een `DO $$ … EXCEPTION WHEN OTHERS THEN NULL`
    // terugverhuist leest als "bestond al" bij élke fout — precies de stilte
    // die U5 heeft afgeschaft.
    const blocks = runDdlCalls(src, tag);
    if (!blocks.length) return [...problems, `${into}: geen runDdl('${tag}', …)-aanroep meer`];
    // En in HETZELFDE statement als de tabel. Een kolomclaim zonder die eis
    // zegt niets over WELKE tabel de kolom krijgt: `agents.persona` bleef groen
    // toen de ALTER naar `agent_conversations` verhuisde, want die tabel staat
    // in hetzelfde blok. De kop van COLUMN_LADDERS belooft het tegenovergestelde.
    const statements = blocks.flatMap(ddlStatements);
    const fits = (st) => needle.test(st) && (kind === 'table' || !table || st.includes(table));
    if (!statements.some(fits)) {
        problems.push(`${label}: staat in ${into}, maar buiten het runDdl('${tag}')-blok`
            + (table && kind !== 'table' ? ` dat ${table} noemt` : '')
            + ' — daar wordt een echte fout weer stil');
    }
    return problems;
}

/**
 * Migratiebestanden die dezelfde toevoeging ÓÓK doen. Twee plekken die dezelfde
 * kolom toevoegen is twee plekken die uit elkaar lopen.
 *
 * Staat er een `table` bij een kolomclaim, dan telt een migratie pas mee als
 * hij ook díé tabel noemt — twee tabellen mogen dezelfde kolomnaam hebben.
 */
function migrationsClaiming(entry) {
    const { table, kind } = entry;
    const needle = claimNeedle(entry);
    return migrationNames().filter((n) => {
        const src = fs.readFileSync(path.join(SERVER, 'migrations', `${n}.js`), 'utf8');
        if (kind === 'table') return needle.test(src);
        if (!src.includes('ADD COLUMN') || !needle.test(src)) return false;
        return table ? src.includes(table) : true;
    });
}

test('elke nieuwe kolom staat in de runDdl-ladder van zijn eigen store', () => {
    for (const entry of COLUMN_LADDERS) {
        assert.deepStrictEqual(ladderProblems(entry), [],
            `${entry.column || entry.table}: de ladderclaim klopt niet meer`);
    }
});

test('een kolom uit COLUMN_LADDERS krijgt géén eigen migratiebestand', () => {
    // Twee plekken die dezelfde kolom toevoegen is twee plekken die uit elkaar
    // lopen, en de migratieladder is precies wat hier niet bij hoort te groeien.
    //
    // De vergelijking is op WOORD, niet op substring: `version` zou anders
    // matchen op `published_version`, en dan meldt de test een botsing die er
    // niet is. Staat er een `table` bij, dan telt een migratie pas mee als hij
    // ook díé tabel noemt — twee tabellen mogen dezelfde kolomnaam hebben.
    for (const entry of COLUMN_LADDERS) {
        assert.deepStrictEqual(migrationsClaiming(entry), [],
            `${claimLabel(entry)}: hoort in de store-ladder, niet ook in een migratiebestand`);
    }
});

// ── A1c: de drie schema-toevoegingen die nog GEEN claim hebben ──────────────
//
// `agents.persona` en de twee testset-tabellen komen alle drie uit
// stores/agent/initSchema.js en staan in geen enkele lijst. Ze horen in
// COLUMN_LADDERS hierboven; die lijst wordt door de hoofdsessie geplaatst.
// Wat híér staat is de VORM, want dat is wat kapot was: de matcher kon deze
// drie claims niet uitdrukken, en een claim die je niet kunt opschrijven
// faalt niet — hij zwijgt. Zodra de drie regels in COLUMN_LADDERS staan dekt
// de laddertest ze inhoudelijk en pint deze fixture alleen nog de vorm.
const INIT_SCHEMA = 'stores/agent/initSchema.js';

// GEEN tweede kopie: een filter OVER de bewaakte lijst. Als losse fixture was
// dit een tweede lijst met dezelfde drie claims, en dan verandert er niets aan
// de uitslag wanneer ze uit COLUMN_LADDERS verdwijnen — de matchertests hier
// bleven groen op hun eigen kopie terwijl de bewaakte lijst leegliep.
const A1C_LADDERS = COLUMN_LADDERS.filter((e) => e.into === INIT_SCHEMA);
const readInitSchema = () => fs.readFileSync(path.join(SERVER, INIT_SCHEMA), 'utf8');

test('de matcher vindt een kolom in een LATER runDdl-blok met dezelfde tag', () => {
    // De wond: het blok werd afgebakend op de EERSTE `runDdl('<tag>'` in het
    // bestand, en die tag is niet uniek — stores/agent/initSchema.js heeft er
    // tien onder 'agentSchema'. `persona` staat in het zevende. De matcher las
    // hem dus als "staat buiten de ladder" en de claim was niet op te
    // schrijven: een kolom die er juist wél goed in staat kon niet groen.
    const src = readInitSchema();

    // Genuinely textual, met opzet: dit is geen claim over gedrag, maar de
    // PREMISSE die de behavioural assertie hieronder pas zinnig maakt — dat de
    // echte, groeiende bron nog steeds de tag twee keer bevat en `persona` nog
    // steeds voorbij het eerste blok staat. Verdwijnt die premisse (iemand
    // herschikt initSchema.js), dan moet DEZE regel rood gaan — anders wordt
    // de matcher-test hieronder stilletjes vacuous op een fixture die niet
    // meer bestaat.
    const tagAt = [...src.matchAll(/runDdl\('agentSchema'/g)].map((m) => m.index);
    assert.ok(tagAt.length > 1, 'premisse: de tag agentSchema komt meer dan één keer voor');
    assert.ok(src.indexOf('persona JSONB') > tagAt[1],
        'premisse: persona staat voorbij het eerste runDdl-blok');

    // En dit is wat de matcher moet kunnen uitdrukken.
    assert.deepStrictEqual(ladderProblems(A1C_LADDERS[0]), []);
});

test('de matcher bakent élk runDdl-blok van een gedeelde tag af', () => {
    const src = readInitSchema();
    const blocks = runDdlCalls(src, 'agentSchema');
    // Genuinely textual: dit rekent runDdlCalls() (de matcher) na tegen een
    // onafhankelijke telling van dezelfde bron, niet tegen wat de matcher zelf
    // beweert — vandaar de rechtstreekse regex op `src` naast de aanroep.
    assert.strictEqual(blocks.length, (src.match(/runDdl\('agentSchema'/g) || []).length,
        'elk voorkomen van de tag hoort één blok op te leveren');

    // Het flatMap-blok is de tweede reden dat afbakenen op ']);' niet volstaat:
    // dat blok sluit met ']));' en liep daardoor door tot ver in het VOLGENDE
    // blok — een kolom uit blok 7 las dan als een kolom uit blok 6.
    assert.ok(blocks.some((b) => b.includes('flatMap') && b.includes('shared_scope')),
        'het flatMap-blok hoort compleet te zijn, niet afgekapt op zijn eerste ]');
});

test('de matcher kan een CREATE TABLE in de ladder uitdrukken', () => {
    // agent_tests en agent_test_runs zijn TABELLEN. De oude recordvorm kende
    // alleen `column` + `src.includes(column)`; daarmee is "deze ladder maakt
    // deze tabel" niet te zeggen.
    for (const entry of A1C_LADDERS.filter((e) => e.kind === 'table')) {
        assert.deepStrictEqual(ladderProblems(entry), [], `${entry.table}: claim klopt niet`);
    }
});

test('de drie A1c-claims botsen met geen enkel migratiebestand', () => {
    // De andere kant van dezelfde claim: als deze drie straks in COLUMN_LADDERS
    // staan, moet ook de "géén eigen migratiebestand"-test groen blijven. Voor
    // een tabelclaim is dat een CREATE TABLE elders, niet een ADD COLUMN.
    for (const entry of A1C_LADDERS) {
        assert.deepStrictEqual(migrationsClaiming(entry), [],
            `${claimLabel(entry)}: hoort in de store-ladder, niet ook in een migratiebestand`);
    }
});

test('elke claim op de agent-ladder staat in de BEWAAKTE lijst, niet alleen in deze fixture', () => {
    // De bevinding zelf: zolang ze alleen hier stonden, bewaakte niets
    // `agents.persona`, `agent_tests` en `agent_test_runs`. Deze assertie is
    // wat "vergeten te plakken" rood maakt — en ze telt óók, zodat een NIEUWE
    // kolom op deze ladder hier zichtbaar moet worden in plaats van stil mee
    // te liften op de drie die er al stonden.
    const want = [
        { column: 'persona', table: 'agents', into: INIT_SCHEMA, tag: 'agentSchema' },
        { table: 'agent_tests', kind: 'table', into: INIT_SCHEMA, tag: 'agentSchema' },
        { table: 'agent_test_runs', kind: 'table', into: INIT_SCHEMA, tag: 'agentSchema' },
        // A4 deel D: de herkomst van een verwachting die een model schreef.
        { column: 'written_by', table: 'agent_tests', into: INIT_SCHEMA, tag: 'agentSchema' },
        { column: 'suggested_by', table: 'agent_tests', into: INIT_SCHEMA, tag: 'agentSchema' },
        // Deterministische testrun-volgorde: de invoegvolgorde-teller die
        // ran_at DESC als tiebreaker vervangt (zie stores/agent/agentTests.js).
        { column: 'seq', table: 'agent_test_runs', into: INIT_SCHEMA, tag: 'agentSchema' },
    ];
    for (const entry of want) {
        assert.ok(
            COLUMN_LADDERS.some((e) => JSON.stringify(e) === JSON.stringify(entry)),
            `${claimLabel(entry)}: hoort in COLUMN_LADDERS te staan — anders bewaakt niets hem`,
        );
    }
    assert.strictEqual(A1C_LADDERS.length, want.length,
        'en de fixture hierboven is een FILTER over die lijst, geen tweede kopie');
});

test('een noeming in COMMENTAAR is geen kolom', () => {
    // De verbreding van "eerste blok" naar "elk blok" maakte dit bereikbaar:
    // `knowledge_base_ids` staat óók in een toelichting binnen hetzelfde
    // runDdl-blok, dus wis je de ALTER, dan bleef de claim groen op het
    // commentaar dat erover ging.
    const src = readInitSchema();
    // Genuinely textual, zelfde reden als de twee tests hierboven: dit is de
    // premisse die stripComments() hieronder zinnig test, niet een claim over
    // productiegedrag — als `knowledge_base_ids` ooit uit het commentaar van
    // initSchema.js verdwijnt, moet DEZE regel het melden in plaats van de
    // stripComments-test stilletjes te laten leeglopen.
    assert.ok(/\/\/[^\n]*knowledge_base_ids/.test(src),
        'premisse: de kolom wordt in dit bestand ook in commentaar genoemd');
    const stripped = stripComments(src);
    assert.ok(!/\/\/[^\n]*knowledge_base_ids/.test(stripped), 'en dat commentaar is weg');
    assert.ok(stripped.includes("ADD COLUMN IF NOT EXISTS knowledge_base_ids"),
        'terwijl de echte ALTER blijft staan');
});

test('een kolomclaim gaat over ÉÉN tabel — een andere tabel in hetzelfde blok telt niet', () => {
    // `pinned` staat in hetzelfde runDdl-blok als `knowledge_base_ids`, maar op
    // twee ANDERE tabellen. Een claim die `pinned` op `agents` legt hoort dus
    // rood te zijn, ook al staat het woord in de ladder.
    const out = ladderProblems({
        column: 'pinned', table: 'agents', into: INIT_SCHEMA, tag: 'agentSchema',
    });
    assert.ok(out.some((m) => m.includes('agents')),
        `een kolom van een andere tabel hoort een bezwaar te geven, kreeg: ${JSON.stringify(out)}`);
    // En de tabel waar hij WEL op staat blijft groen.
    assert.deepStrictEqual(ladderProblems({
        column: 'pinned', table: 'direct_conversations', into: INIT_SCHEMA, tag: 'agentSchema',
    }), []);
});

test('de matcher blijft rood op een kolom buiten elke runDdl-ladder', () => {
    // starter_prompts staat in het CREATE TABLE dat via exec() draait — precies
    // wat deze claim NIET mag dekken. Verbreden van "eerste blok" naar "elk
    // blok" mag niet doorschieten in "staat ergens in het bestand".
    const out = ladderProblems({
        column: 'starter_prompts', table: 'agents', into: INIT_SCHEMA, tag: 'agentSchema',
    });
    assert.ok(out.some((m) => m.includes('buiten het runDdl')),
        `een kolom buiten de ladder hoort een bezwaar te geven, kreeg: ${JSON.stringify(out)}`);
});

test('de matcher blijft rood op een tabel die de ladder alleen NOEMT', () => {
    // agent_favorites wordt met exec() gemaakt; het runDdl-blok eronder legt er
    // alleen een index op. "Wordt genoemd" is geen "wordt gemaakt" — anders
    // dekt de claim een tabel waarvan de creatie nog steeds stil kan falen.
    const out = ladderProblems({ table: 'agent_favorites', kind: 'table', into: INIT_SCHEMA, tag: 'agentSchema' });
    assert.ok(out.length > 0, 'een genoemde-maar-niet-gemaakte tabel hoort een bezwaar te geven');
});

test('onbekend versmalt: een onleesbaar doel of een lege claim is een bezwaar', () => {
    // Geen enkele van deze mag als "klopt" wegvallen. Een claim die niets zegt
    // is geen groene claim.
    const cases = [
        ['bestand weg', { column: 'persona', into: 'stores/agent/bestaat-niet.js', tag: 'agentSchema' }, 'niet te lezen'],
        ['kolom weg', { column: 'nooit_bestaan_hebbende_kolom', into: INIT_SCHEMA, tag: 'agentSchema' }, 'staat niet meer in'],
        ['tag weg', { column: 'persona', into: INIT_SCHEMA, tag: 'geenEnkeleTag' }, 'geen runDdl'],
        // De drie die hun eigen poort NIET dekten: elk van deze kwam alleen
        // rood uit omdat `claimNeedle({})` toevallig op `/\bundefined\b/`
        // landde en dat woord nergens in de ladder staat. Zet iemand `undefined`
        // in een commentaarregel, dan las een claim die NIETS noemt als groen.
        // Daarom nu op de MELDING, niet op "er was er een".
        ['noemt niets', { into: INIT_SCHEMA, tag: 'agentSchema' }, 'noemt geen kolom'],
        ['tabel zonder kind', { table: 'agent_tests', into: INIT_SCHEMA, tag: 'agentSchema' }, 'noemt geen kolom'],
        ['onbekende kind', { column: 'persona', kind: 'index', into: INIT_SCHEMA, tag: 'agentSchema' }, 'onbekende kind'],
        ['into weg', { column: 'persona', table: 'agents', tag: 'agentSchema' }, 'mist into of tag'],
        ['tag ontbreekt', { column: 'persona', table: 'agents', into: INIT_SCHEMA }, 'mist into of tag'],
        ['allebei weg', { column: 'persona', table: 'agents' }, 'mist into of tag'],
    ];
    for (const [label, entry, want] of cases) {
        const out = ladderProblems(entry);
        assert.ok(out.length > 0, `${label}: hoort een bezwaar te geven, gaf er geen`);
        assert.ok(out.some((m) => m.includes(want)),
            `${label}: het bezwaar hoort "${want}" te noemen, kreeg: ${JSON.stringify(out)}`);
    }

    // De woordgrens is dragend: zonder hem matcht een claim op een STUK van een
    // kolomnaam, en dan dekt "persona" ook "geen_persona_hier".
    assert.ok(ladderProblems({ column: 'ersona', table: 'agents', into: INIT_SCHEMA, tag: 'agentSchema' })
        .some((m) => m.includes('staat niet meer in')),
        'een halve kolomnaam hoort geen claim te zijn');
});
