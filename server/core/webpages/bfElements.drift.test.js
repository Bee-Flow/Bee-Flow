/**
 * Drifttest — houdt de DRIE plekken waar het `bf-*`-vocabulaire leeft aan
 * core/webpages/bfElements.js.
 *
 * ── WAAROM DEZE TEST BESTAAT ────────────────────────────────────────
 *
 * services/reactBundleServer.js draagt al jaren de regel "⚠️ KEEP IN SYNC met
 * agent-hub/src/utils/buildWebpagePreview.js … moeten byte-identiek blijven",
 * en niets dwingt dat af. Het resultaat staat er vandaag: `window.beeflowAI`
 * heeft in reactBundleServer.js de namen `complete`/`ground`/`generate`, die in
 * geen van de twee andere brugbestanden bestaan, en mist de vier namen
 * (`chat`/`chatJSON`/`stream`/`ask`) die er wél zijn. Een pagina die
 * `beeflowAI.chat(...)` aanroept in de headless render krijgt daar een
 * TypeError. Een commentaarregel houdt niets tegen; een test die opsomt wel.
 *
 * ── WAT DIT KAN BEWIJZEN ────────────────────────────────────────────
 *
 * Dat alle drie de plekken dezelfde NAMEN dragen, dezelfde attributen kennen,
 * en per plek hetzelfde OORDEEL uitspreken over wat er van een element
 * overblijft — en dat er nergens een tweede, met de hand geschreven lijst is
 * ontstaan waar de eerste vanaf kan drijven.
 *
 * ── WAT DIT NIET KAN BEWIJZEN ───────────────────────────────────────
 *
 * Dat drie implementaties zich hetzelfde GEDRAGEN. Deze test legt lijsten naast
 * elkaar. Of de uitklapper straks werkelijk een zichtbaar uitgeschakelde knop
 * tekent in plaats van een lege plek, moet die uitklapper zelf komen bewijzen,
 * met een test op zijn uitvoer.
 *
 * ── DE VIER SLOTEN, EN WAAR ZE HIER WORDEN GECONTROLEERD ────────────
 *
 *   (a) de twee serverplekken kunnen geen kopie houden  → "geen tweede lijst"
 *   (b) de publieke brug is afgeleid, niet verklaard    → "publieke brug"
 *   (c) de vanilla snapshot moet beslissen              → "vanilla snapshot"
 *       (die bijt bovendien op require-tijd: assertCoversVocabulary gooit)
 *   (d) de client-spiegel is gegenereerd                → "client-spiegel"
 *
 * Draaien: cd server && node --test --test-force-exit core/webpages/bfElements.drift.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bf = require('./bfElements');
const { maskCode } = require('./webpageBindings');
const { buildPublicBridgeScript } = require('../../services/publicBridgeScript');
const { buildStubBridgeScript } = require('../../services/reactBundleServer');
const bfTable = require('../../services/webpageBfTable');

const REPO = path.join(__dirname, '..', '..', '..');
const CLIENT = path.join(REPO, 'agent-hub', 'src', 'utils');
/** De gegenereerde spiegel: de enige plek waar de client het vocabulaire opsomt. */
const MIRROR = path.join(CLIENT, 'bfElements.js');
/**
 * De client-bestanden die uit de spiegel horen te lezen in plaats van zelf te
 * weten: de twee composers plus de RUNTIME die het vocabulaire uitvoert. Die
 * laatste hing eerder alleen aan een frontendtest; hij hoort ook hier, want dit
 * is de plek die de hele boom bewaakt.
 */
const CLIENT_COMPOSERS = [
    path.join(CLIENT, 'composeWebpageDocument.js'),
    path.join(CLIENT, 'buildWebpagePreview.js'),
    path.join(CLIENT, 'bfElementsRuntime.js'),
];
/** De twee serverbruggen die het vocabulaire uitzenden, plus hun gedeelde motor. */
const BRIDGE = path.join(REPO, 'server', 'services', 'publicBridgeScript.js');
const STUB_BRIDGE = path.join(REPO, 'server', 'services', 'reactBundleServer.js');
const NOTICE_ENGINE = path.join(REPO, 'server', 'services', 'bfBridgeNotices.js');

/**
 * Elke bekende tagnaam als heel woord — waarmee een handgeschreven lijst opvalt.
 *
 * De lookarounds sluiten een koppelteken uit, want de frontend gebruikt al
 * CSS-klassen als `bf-table-colhead` en een keyframe `bf-form-spin`. Die hebben
 * niets met het vocabulaire te maken en mogen geen vals alarm geven.
 */
const TAG_WORD = new RegExp(`(?<![-\\w])(?:${bf.BF_TAGS.join('|')})(?![-\\w])`, 'g');

/** Regeleindes gelijktrekken: de checkout kan CRLF dragen, de generator niet. */
function readSource(file) {
    const raw = fs.readFileSync(file, 'utf8');
    // Geen claim over gedrag: een sanity-guard tegen een pad dat stil een lege
    // string oplevert, waarna elke vergelijking hieronder vacuous groen zou
    // zijn. De echte drift-claims in dit bestand lopen via de andere
    // richting — de agent-hub-bestanden zijn hier niet ge-require't (client-
    // runtime), en de serverbruggen worden elders in dit bestand ECHT
    // gedraaid (buildPublicBridgeScript/buildStubBridgeScript, vm.runInContext).
    assert.ok(raw.length > 500, `sanity: ${path.basename(file)} is gelezen en niet leeg`);
    return raw.replace(/\r\n/g, '\n');
}

/** Het gegenereerde blok uit de client-spiegel, inclusief zijn markers. */
function mirrorBlock() {
    const src = readSource(MIRROR);
    const start = src.indexOf(bf.CLIENT_MIRROR_BEGIN);
    const end = src.indexOf(bf.CLIENT_MIRROR_END);
    // Een hernoemde marker moet ROOD worden, niet stil een lege sectie opleveren.
    assert.ok(start !== -1, 'agent-hub/src/utils/bfElements.js draagt de beginmarker van de spiegel');
    assert.ok(end !== -1, 'agent-hub/src/utils/bfElements.js draagt de eindmarker van de spiegel');
    assert.ok(end > start, 'de eindmarker staat na de beginmarker');
    return { src, start, end, block: src.slice(start, end + bf.CLIENT_MIRROR_END.length) };
}

// ── (d) de client-spiegel ─────────────────────────────────────────────

test('client-spiegel — het blok in agent-hub/src/utils/bfElements.js IS de registry', () => {
    const { block } = mirrorBlock();
    const expected = bf.renderClientMirror();
    assert.strictEqual(
        block, expected,
        'de gegenereerde spiegel in agent-hub/src/utils/bfElements.js loopt achter op '
        + 'server/core/webpages/bfElements.js. De preview en een ingelogde lezer krijgen dan een ander '
        + 'vocabulaire dan de publieke snapshot — precies de asymmetrie die W4 dicht. Vervang alles '
        + 'tussen de twee markers (inclusief de markers) door de uitvoer van:\n'
        + '  cd server && node -e "console.log(require(\'./core/webpages/bfElements\').renderClientMirror())"',
    );
});

test('client-spiegel — elk element uit de registry staat er ook echt in', () => {
    // Tweede richting, met een eigen extractie: als de gelijkheidstest hierboven
    // ooit op een lege string tegen een lege string zou uitkomen, valt dat hier
    // door de sanity-assert alsnog op.
    const { block } = mirrorBlock();
    const named = new Set(block.match(TAG_WORD) || []);
    assert.ok(named.size > 3, 'sanity: er zijn tagnamen uit de spiegel gehaald');
    assert.deepStrictEqual([...named].sort(), [...bf.BF_TAGS].sort(),
        'de spiegel noemt precies het vocabulaire — niet meer en niet minder');
});

test('geen tweede lijst — de spiegel bevat niets BUITEN het gegenereerde blok', () => {
    const { src, start, end } = mirrorBlock();
    const outside = src.slice(0, start) + src.slice(end + bf.CLIENT_MIRROR_END.length);
    const strays = outside.match(TAG_WORD) || [];
    assert.deepStrictEqual(strays, [],
        'agent-hub/src/utils/bfElements.js noemt een bf-element buiten het gegenereerde blok om; alles wat '
        + 'daar staat, ontsnapt aan de vergelijking met de registry');
});

test('geen tweede lijst — de client-composers weten zelf geen tagnaam', () => {
    // Beide composers horen uit ./bfElements.js te lezen. Schrijft er één een
    // naam zelf op, dan is er een tweede lijst — en dat is exact hoe het
    // beeflowAI-oppervlak van reactBundleServer.js uit de pas is gaan lopen.
    for (const file of CLIENT_COMPOSERS) {
        const src = readSource(file);
        const strays = (maskCode(src).literals
            .map(l => String(l.value || '').match(TAG_WORD) || [])
            .flat());
        assert.deepStrictEqual(strays, [],
            `${path.basename(file)} schrijft een bf-tagnaam op in plaats van hem uit BF_ELEMENTS te lezen`);
    }
});

// ── (b) de publieke brug + (a) geen tweede lijst ──────────────────────

/**
 * Elke plek waar een BRUG het vocabulaire uitzendt, met de bouwer erbij.
 *
 * Twee, en dat is de kern van de reparatie die deze ronde deed: de brug uit
 * publicBridgeScript.js wordt ALLEEN geïnjecteerd als de auteur publieke AI
 * heeft aangezet (default uit), terwijl de stub uit reactBundleServer.js in ELK
 * react-document zit — de publieke share én het plaatje dat de bouwer-AI ziet.
 * Zonder deze tweede rij was het eerlijk-falen-mechanisme dode code op het
 * standaardpad.
 */
const BRIDGES = [
    ['publieke AI-brug (reactShare)', 'reactShare',
        () => buildPublicBridgeScript({ token: 't0ken', apiBase: 'https://example.test' })],
    ['ingebakken stub (reactShare)', 'reactShare',
        () => buildStubBridgeScript('reactShare')],
    ['ingebakken stub (headlessRender)', 'headlessRender',
        () => buildStubBridgeScript('headlessRender')],
];

test('elke brug noemt elk element, met de weigering van ZIJN eigen plek erbij', () => {
    for (const [label, surface, build] of BRIDGES) {
        const script = build();
        const vocab = bf.bridgeVocabulary(surface);
        const named = new Set(script.match(/(?<![-\w])bf-[a-z][a-z0-9-]*(?![-\w])/g) || []);
        assert.ok(named.size >= bf.BF_TAGS.length, `sanity: ${label} noemt bf-elementen`);
        for (const tag of bf.BF_TAGS) {
            assert.ok(named.has(tag),
                `${label} zwijgt over ${tag}; een pagina die hem gebruikt krijgt daar stilte in plaats van een reden`);
            assert.ok(script.includes(vocab[tag].message),
                `${label}: de weigering van ${tag} ("${vocab[tag].message}") staat er niet in`);
            assert.ok(script.includes(vocab[tag].notice),
                `${label}: de LEZER krijgt bij ${tag} geen zin te zien; dan is een dood element niet te `
                + 'onderscheiden van een leeg element');
        }
        const unknown = [...named].filter(t => !bf.isKnownBfTag(t));
        assert.deepStrictEqual(unknown, [], `${label} noemt elementen die de registry niet kent`);
    }
});

test('de twee plekken lenen elkaars zin NIET', () => {
    // Dezelfde stub bedient de publieke share en het plaatje van de eigen pagina
    // van de auteur. "op een gedeelde link" zou daar liegen over een pagina die
    // ingelogd gewoon werkt, dus elke plek draagt zijn eigen tekst.
    const share = bf.bridgeVocabulary('reactShare');
    const render = bf.bridgeVocabulary('headlessRender');
    for (const tag of bf.BF_TAGS) {
        assert.notStrictEqual(share[tag].notice, render[tag].notice,
            `${tag} draagt op beide plekken dezelfde zin; dan zegt er een van de twee iets onwaars`);
    }
    const doc = buildStubBridgeScript('headlessRender');
    for (const tag of bf.BF_TAGS) {
        assert.ok(!doc.includes(share[tag].notice),
            `de stub voor het plaatje draagt de zin van de gedeelde link bij ${tag}`);
    }
});

test('publieke brug — de uitgezonden brug noemt elk element, met zijn weigering erbij', () => {
    const script = buildPublicBridgeScript({ token: 't0ken', apiBase: 'https://example.test' });
    // Dezelfde lookarounds als TAG_WORD hierboven, en om dezelfde reden: `\b`
    // ziet een koppelteken als woordgrens, dus een ATTRIBUUTnaam als
    // `data-bf-state` (de markering die de brug op een geweigerd element zet,
    // en die de client-runtime ook gebruikt) zou als "onbekend element bf-state"
    // worden aangezien. Een attribuutnaam is geen tagnaam.
    const named = new Set(script.match(/(?<![-\w])bf-[a-z][a-z0-9-]*(?![-\w])/g) || []);
    assert.ok(named.size >= bf.BF_TAGS.length, 'sanity: de brug noemt bf-elementen');

    for (const tag of bf.BF_TAGS) {
        assert.ok(named.has(tag),
            `de publieke brug zwijgt over ${tag}; een pagina die hem gebruikt krijgt daar stilte in plaats `
            + 'van een reden');
        const message = bf.publicShareVocabulary()[tag].message;
        assert.ok(script.includes(message),
            `de weigering van ${tag} ("${message}") staat niet in de uitgezonden brug — een weigering `
            + 'zonder reden is niet te onderscheiden van "het werkte gewoon niet"');
    }

    // Andere richting: alles wat de brug bf-noemt, bestaat ook.
    const unknown = [...named].filter(t => !bf.isKnownBfTag(t));
    assert.deepStrictEqual(unknown, [],
        'de publieke brug noemt elementen die core/webpages/bfElements.js niet kent');
});

/**
 * De uitgezonden brug DRAAIEN, in een sandbox met net genoeg browser eromheen.
 *
 * De brug is gegenereerde tekst, en een regex erover zegt alleen dat er een
 * regel staat die er goed uitziet. Wat de pagina merkt is wat `beeflowBf`
 * ANTWOORDT — dus wordt het script hier uitgevoerd en bevraagd.
 */
function runBridge(script) {
    const code = script.replace(/^[\s\S]*?<script[^>]*>/, '').replace(/<\/script>\s*$/, '');
    const document = {
        nodeType: 9, readyState: 'complete',
        addEventListener() {}, querySelectorAll() { return []; },
    };
    // Geen customElements: de define-lus is niet wat hier wordt gevraagd, en
    // een halve elementregistratie zou alleen ruis toevoegen.
    const sandbox = { document, fetch: async () => ({ ok: true, json: async () => ({}) }) };
    sandbox.window = sandbox;
    vm.runInContext(code, vm.createContext(sandbox));
    return sandbox.window;
}

test('publieke brug — een onbekend element komt er als "unknown" uit, niet als in orde', () => {
    const bridge = runBridge(buildPublicBridgeScript({ token: 't0ken', apiBase: 'https://example.test' }));

    assert.strictEqual(bridge.beeflowBf.state('bf-nope'), 'unknown',
        'een tag die het vocabulaire niet kent is herkenbaar onbekend, nooit stilzwijgend in orde');
    assert.strictEqual(bridge.beeflowBf.reason('bf-nope'), 'Unknown Bee Flow element bf-nope',
        'en de reden spreekt dat uit in plaats van null terug te geven');

    // De tegenproef: een element dat de brug WEL kent draagt het oordeel van
    // deze plek, niet 'unknown'. Zonder deze regel zou een brug die overal
    // 'unknown' zegt hierboven groen zijn.
    for (const [tag, entry] of Object.entries(bf.bridgeVocabulary('reactShare'))) {
        assert.strictEqual(bridge.beeflowBf.state(tag), entry.state, `${tag} draagt het oordeel van reactShare`);
        assert.strictEqual(bridge.beeflowBf.reason(tag), entry.message, `${tag} zegt ook waarom`);
    }
});

test('geen tweede lijst — geen enkel brugbestand schrijft zelf een tagnaam', () => {
    for (const file of [BRIDGE, STUB_BRIDGE, NOTICE_ENGINE]) {
        const src = readSource(file);
        const strays = src.match(TAG_WORD) || [];
        assert.deepStrictEqual(
            strays, [],
            `${path.basename(file)} noemt een bf-element met de hand. Dit bestand hoort zijn lijst volledig `
            + 'uit bridgeVocabulary() te halen; alles wat hier met de hand staat, kan achterlopen.',
        );
    }
});

test('de bruggen delen ÉÉN motor — er is geen tweede kopie van het mechanisme', () => {
    // Het decoratiemechanisme stond eerst alleen in publicBridgeScript.js. Toen
    // bleek dat de stub het ook moest hebben, was overtikken de voor de hand
    // liggende fout — en precies de drift die dit bestand bestrijdt.
    const engine = readSource(NOTICE_ENGINE);
    assert.ok(engine.includes('function bfDecorate'),
        'sanity: de motor draagt het decoratiemechanisme');
    for (const file of [BRIDGE, STUB_BRIDGE]) {
        const src = readSource(file);
        assert.ok(src.includes("require('./bfBridgeNotices')"),
            `${path.basename(file)} haalt het mechanisme niet uit de gedeelde motor`);
        assert.ok(!src.includes('function bfDecorate'),
            `${path.basename(file)} draagt een eigen kopie van het decoratiemechanisme`);
    }
});

test('elke brug-plek uit de registry heeft ook echt een brug', () => {
    // Andere richting: een plek toevoegen aan BRIDGE_SURFACES zonder hem hier te
    // laten uitzenden, zou een plek opleveren waarvan de teksten nergens
    // terechtkomen — zichtbaar in de registry, onzichtbaar op de pagina.
    const covered = new Set(BRIDGES.map(([, surface]) => surface));
    assert.deepStrictEqual([...covered].sort(), [...bf.BRIDGE_SURFACES].sort(),
        'BRIDGE_SURFACES en de bruggen die deze test bouwt lopen uit elkaar');
});

// ── (c) de vanilla snapshot ───────────────────────────────────────────

test('vanilla snapshot — webpageBfTable spreekt zich over ELK element uit', () => {
    const handling = bfTable.VANILLA_HANDLING;
    assert.ok(handling, 'sanity: de handelingstabel wordt geëxporteerd');
    assert.deepStrictEqual([...Object.keys(handling)].sort(), [...bf.BF_TAGS].sort(),
        'de vanilla snapshot noemt precies het vocabulaire — een element dat hier ontbreekt verdwijnt stil, '
        + 'want DOMPurify pakt een onbekend element zonder waarschuwing uit');

    for (const [tag, verdict] of Object.entries(handling)) {
        assert.ok(['expand', 'inert'].includes(verdict),
            `${tag}: "${verdict}" is geen geldige beslissing (expand of inert)`);
    }
    // Wat JS nodig heeft KAN daar niet worden uitgeklapt; wat het niet nodig
    // heeft hoort niet als inert te worden weggeschreven. De handelingstabel mag
    // dus niet in tegenspraak zijn met het vocabulaire.
    for (const tag of bf.tagsNeedingJs()) {
        assert.notStrictEqual(handling[tag], 'expand',
            `${tag} heeft JS nodig; in een script-vrije snapshot valt daar niets aan uit te klappen`);
    }
    // Sanity: de tabel is de oudste uitklapper en de enige die deze test bij
    // naam kent. Staat hier iets anders, dan is de uitklapper stukgegaan.
    assert.strictEqual(handling['bf-table'], 'expand',
        'bf-table hoort server-side te worden uitgeklapt');
});

test('vanilla snapshot — het require-tijd-slot bijt echt', () => {
    // Niet de tabel van webpageBfTable zelf: dat zou hetzelfde nog eens zijn.
    // Dit toetst het MECHANISME waardoor die module niet meer laadt zodra
    // iemand een element toevoegt zonder er daar iets over te zeggen.
    assert.throws(
        () => bf.assertCoversVocabulary('services/webpageBfTable (vanilla snapshot)', ['bf-table']),
        /webpageBfTable/,
        'een onvolledige handelingstabel moet de module laten vastlopen, niet stil doorgaan',
    );
});

test('vanilla snapshot — wat JS nodig heeft staat nergens als "uitklapbaar" opgeschreven', () => {
    // De regel zelf, hier vanaf de kant van de consument bekeken: in de vanilla
    // snapshot draait geen JS, dus geen enkel element met needsJs mag daar een
    // andere toestand dan 'inert' dragen — en 'inert' moet een zichtbare tekst
    // hebben, anders is de inertie precies zo stil als DOMPurify hem maakt.
    for (const tag of bf.tagsNeedingJs()) {
        const vanilla = bf.getBfElement(tag).surfaces.vanillaSnapshot;
        assert.strictEqual(vanilla.state, 'inert', `${tag} kan in een script-vrije snapshot niets doen`);
        assert.ok(vanilla.notice && vanilla.notice.length > 10,
            `${tag} moet in de snapshot ZICHTBAAR melden dat hij niet werkt`);
    }
    assert.ok(bf.tagsNeedingJs().length >= 3, 'sanity: er zijn elementen die JS nodig hebben');
});

// ── het vocabulaire zelf blijft één lijst ─────────────────────────────

test('de registry is de enige plek in de serverbron die een tagnaam opschrijft', () => {
    // Een sweep over de hele serverkant. Alleen STRINGLITERALEN tellen: een
    // tagnaam in commentaar is documentatie, een tagnaam in code is een lijst.
    // Een identifier kan geen koppelteken dragen, dus een tag KAN in JS alleen
    // in een string staan — het onderscheid is daarmee volledig.
    //
    // Het scheiden gebeurt met de maskeerder uit webpageBindings.js, die W3
    // uitdrukkelijk voor dit doel exporteert. Zijn bekende blinde vlek (een
    // regex-literal met een quote erin) kan hier alleen een VALS ALARM geven,
    // nooit een gemist geval: hij ziet dan te veel als string, niet te weinig.
    const allowed = new Map([
        ['core/webpages/bfElements.js', 'de registry zelf — hier hoort het vocabulaire te staan'],
        ['services/webpageBfTable.js', 'de handelingstabel die deze consument MOET uitspreken'],
        // Beide hieronder schrijft .claude/handoff/curriculum/generate.mjs uit de
        // lessen. De tagnamen staan er in PROZA voor de lezer ("de vijf Studio-
        // elementen zijn bf-table, …"), niet in een lijst die code leest: loopt
        // zo'n naam achter, dan is dat een verouderde lestekst, geen tweede
        // vocabulaire. Bijwerken gebeurt in de les, daarna generate.mjs.
        ['i18n/defaults/en/learn.js', 'vertaalkopij — de gegenereerde learn.*-lesteksten noemen de elementen bij naam'],
        ['learning/catalog.generated.js', 'gegenereerd uit de curriculum-lessen — lesinhoud (rubrics), geen lijst die code leest'],
    ]);
    const server = path.join(REPO, 'server');
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            // Testbestanden schrijven met opzet fixtures met echte tags in.
            if (!/\.(js|mjs|cjs)$/.test(entry.name) || /\.test\.(js|mjs|cjs)$/.test(entry.name)) continue;
            const rel = path.relative(server, full).split(path.sep).join('/');
            if (allowed.has(rel)) continue;
            const text = fs.readFileSync(full, 'utf8');
            TAG_WORD.lastIndex = 0;
            if (!TAG_WORD.test(text)) continue;
            TAG_WORD.lastIndex = 0;
            const hits = new Set();
            for (const literal of maskCode(text).literals) {
                for (const hit of String(literal.value || '').match(TAG_WORD) || []) hits.add(hit);
            }
            if (hits.size) offenders.push(`${rel} (${[...hits].join(', ')})`);
        }
    };
    walk(server);
    assert.deepStrictEqual(
        offenders, [],
        'deze serverbestanden schrijven een bf-tagnaam in code op. Elke zo\'n plek is een tweede lijst die kan '
        + 'achterlopen op core/webpages/bfElements.js; lees de naam daaruit, of zet het bestand bewust op de '
        + '`allowed`-lijst hierboven met de reden erbij.',
    );
    // Zonder deze regel zou een kapotte maskeerder of een verkeerd pad een
    // groene test opleveren die niets heeft gelezen.
    assert.ok(
        maskCode(fs.readFileSync(path.join(server, 'services', 'webpageBfTable.js'), 'utf8'))
            .literals.some(l => String(l.value || '').includes('bf-table')),
        'sanity: de sweep vindt een tagnaam in een bestand waarvan we weten dat hij er staat',
    );
});
