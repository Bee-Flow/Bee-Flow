/**
 * bfElements — HET `bf-*`-vocabulaire. Eén lijst, drie consumenten.
 *
 * ── HET PROBLEEM DAT DEZE MODULE BESTAAT OM TE VOORKOMEN ─────────────
 *
 * Het vocabulaire leeft op DRIE plekken:
 *
 *   1. de client        — agent-hub/src/utils/bfElements.js, de gegenereerde
 *      spiegel waaruit composeWebpageDocument.js en buildWebpagePreview.js
 *      lezen: wat de preview en een INGELOGDE lezer te zien krijgen;
 *   2. de servertweeling   — services/publicBridgeScript.js, de brug die in een
 *      publiek gedeelde react-mui-pagina wordt geïnjecteerd;
 *   3. de snapshot-renderer — services/webpageSnapshot.js, die VÓÓR DOMPurify
 *      uitklapt (services/webpageBfTable.js doet dat vandaag voor `bf-table`).
 *
 * Twee handbijgehouden lijsten lopen uit elkaar. Dat is hier geen theorie: op
 * reactBundleServer.js staat al jaren "KEEP IN SYNC met buildWebpagePreview.js"
 * en juist dáár draagt `window.beeflowAI` drie namen (`complete`/`ground`/
 * `generate`) die in de twee andere brugbestanden niet bestaan, terwijl de vier
 * namen die er wél zijn (`chat`/`chatJSON`/`stream`/`ask`) er ontbreken. Een
 * commentaarregel houdt niets tegen.
 *
 * ── WAAROM DEZE VARIANT NIET STIL UIT ELKAAR KAN LOPEN ───────────────
 *
 * Vier sloten, elk op een andere plek:
 *
 *   (a) De twee SERVERPLEKKEN kunnen geen kopie houden. Ze `require`n deze
 *       module. De drifttest verbiedt bovendien elk met de hand geschreven
 *       `bf-<naam>`-literal in die bestanden buiten het afgeleide pad om, zodat
 *       er geen tweede lijst kán ontstaan.
 *   (b) De publieke brug is AFGELEID, niet verklaard: hij zendt uit wat
 *       `publicShareVocabulary()` teruggeeft. Een element toevoegen verandert
 *       zijn uitvoer vanzelf — er valt niets te vergeten.
 *   (c) De vanilla snapshot MOET beslissen. `assertCoversVocabulary()` gooit op
 *       REQUIRE-tijd als de handelingstabel van webpageBfTable.js een tag mist
 *       of er een noemt die hier niet bestaat. De server start dan niet en elke
 *       test die het pad aanraakt wordt rood. Dat is geen test die je kunt
 *       vergeten te draaien.
 *   (d) De CLIENT-spiegel is gegenereerd. `renderClientMirror()` maakt het blok
 *       dat letterlijk tussen de markers in agent-hub/src/utils/bfElements.js
 *       hoort te staan; de drifttest vergelijkt dat teken voor teken. Een nieuw element,
 *       een nieuw attribuut of een gewijzigd oordeel verandert die tekst, dus
 *       de test is rood tot het blok is vervangen — en de foutmelding bevat de
 *       tekst die erin moet.
 *
 * WAT DIT KAN BEWIJZEN: dat alle drie de plekken dezelfde NAMEN dragen,
 * dezelfde attributen kennen, en per plek hetzelfde OORDEEL uitspreken over wat
 * er van een element overblijft.
 *
 * WAT DIT NIET KAN BEWIJZEN: dat drie implementaties zich hetzelfde GEDRAGEN.
 * Deze module is een datastructuur; of de renderer die er straks uit leest ook
 * werkelijk een inerte knop tekent, moet die renderer zelf komen bewijzen.
 *
 * ── DE REGEL DIE DIT ALLEMAAL BESCHERMT ──────────────────────────────
 *
 * In de VANILLA publieke snapshot draait GEEN JS (services/webpageSnapshot.js
 * laat het js-slot met opzet weg). Alles wat JS nodig heeft is daar dus dood.
 * En "dood" moet ZICHTBAAR zijn, niet stil: DOMPurify pakt een onbekend element
 * stilzwijgend uit (`KEEP_CONTENT: true`, en `ADD_TAGS` bevat alleen `iframe`),
 * dus `<bf-button action="a1">Send</bf-button>` wordt letterlijk `Send` — de tag
 * weg, de attributen weg, geen waarschuwing, geen spoor. Precies daarom draagt
 * elk element hieronder een `notice`: de uitklapper in de volgende stap zet er
 * gewone, zichtbaar uitgeschakelde HTML neer VÓÓR de sanitizer, zodat er na de
 * sanitizer doodgewone opmaak staat die zelf vertelt dat hij niet werkt.
 *
 * Deze module RENDERT NIETS. Ze legt vast wat er bestaat; de renderers lezen
 * hieruit.
 */

'use strict';

/** Bovengrens aan het aantal rijen dat een publieke tabel mag tonen. */
const PUBLIC_ROWS_MAX = 100;

/**
 * Hoeveel rijen een `bf-stat` hoogstens optelt — op ELKE plek dezelfde.
 *
 * Dit getal stond eerder alleen op de server (`datatableRuntime.ROWS_PAGE_MAX`),
 * en de client vroeg er niets voor: `/tables/:id/query` viel dan terug op zijn
 * eigen DEFAULT_LIMIT van 50. Een `<bf-stat agg="sum">` telde daardoor in de
 * preview over 50 rijen en op de gepubliceerde pagina over 500 — twee
 * verschillende getallen voor hetzelfde element, uit twee plekken die juist uit
 * één registry horen te lezen. Daarom staat het getal hier.
 *
 * services/webpageBfTable.js toetst op require-tijd dat het binnen
 * `datatableRuntime.ROWS_PAGE_MAX` past; verder vragen levert toch niets op.
 */
const STAT_ROWS_MAX = 500;

/** De vier plekken, met exact deze sleutels. */
const SURFACES = Object.freeze(['clientComposer', 'reactShare', 'vanillaSnapshot', 'headlessRender']);

/**
 * De toestanden die een element op een plek kan hebben.
 *
 *   live     — het element werkt hier: er draait JS en de bruggen zijn er;
 *   static   — het is hier server-side tot gewone HTML uitgeklapt;
 *   inert    — het staat er wel, maar het doet niets, en dat is te zien;
 *   refused  — het wordt hier helemaal niet bediend, mét een reden.
 */
const STATES = Object.freeze(['live', 'static', 'inert', 'refused']);

/** Alleen deze vorm telt als een `bf-*`-tag. */
const BF_TAG_PATTERN = /^bf-[a-z][a-z0-9-]*$/;

/**
 * Hoe een `bf-*`-element in markup begint. Eén groep: de geschreven naam.
 *
 * Alleen de OPENINGSTAG: `</bf-table>` matcht niet, want `\s*` slikt geen
 * schuine streep. Dat is met opzet — wie occurrences telt, wil elk element
 * één keer, niet twee keer.
 *
 * Geëxporteerd omdat `core/webpages/webpageBindings.js` er de regels van de
 * auteur mee opzoekt. Kopieer dit patroon daar niet: hoe een element ERUITZIET
 * hoort net zo goed bij het vocabulaire als hoe het HEET, en twee patronen
 * lopen net zo hard uit elkaar als twee lijsten.
 */
const BF_TAG_SCAN = /<\s*(bf-[a-z0-9-]*)/gi;

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

// ── HET VOCABULAIRE ───────────────────────────────────────────────────
//
// Velden per element:
//   tag         de tagnaam, kleine letters, altijd met `bf-`-voorvoegsel;
//   summary     één regel Engels — dit is ook wat het model te lezen krijgt;
//   needsJs     heeft dit element JS NODIG om iets te doen? Zo ja, dan kan het
//               in de vanilla snapshot per definitie niet meer dan inert zijn;
//   attributes  wat hij kent, wat verplicht is, en wat het betekent;
//   binding     wat hij oplevert voor de usage-index: welke tabel, welke
//               routine, welke agent — plus de poort waar dat doorheen moet;
//   surfaces    per plek: wat blijft ervan over, en waarom.
//
// Velden per plek (`surfaces.<plek>`):
//   state    een van STATES;
//   why      Nederlandse verantwoording voor ONTWIKKELAARS. Blijft op de server;
//   message  ontwikkelaarstekst voor de CONSOLE, met de tagnaam erin — wat
//            `beeflowBf.reason()` op een publieke share antwoordt;
//   notice   de zin die de LEZER op de pagina te zien krijgt. Engels, zonder
//            tagnamen en zonder interne begrippen. Een geweigerd of inert
//            element moet er een dragen: zonder tekst is het verschil tussen
//            "dit kan hier niet" en "dit is leeg" niet te zien, en juist dat
//            verschil is de regel die W4 beschermt.
//
// Attribuutvelden:
//   name          canonieke naam;
//   required      verplicht — zonder dit attribuut heeft het element geen zin;
//   aliases       oudere/alternatieve schrijfwijzen die naar `name` vertalen;
//   means         Engelse uitleg van één regel;
//   values        de toegestane waarden (als het een gesloten lijst is);
//   default       wat er geldt als het attribuut ontbreekt;
//   max           bovengrens voor een getal;
//   requiredWhen  voorwaardelijk verplicht: `{ attr, notOneOf }` betekent
//                 "verplicht zodra `attr` iets anders is dan deze waarden".

const BF_ELEMENTS = deepFreeze([
    {
        tag: 'bf-table',
        summary: 'Rows from a datatable the page is bound to, rendered as a plain table.',
        needsJs: false,
        attributes: [
            {
                name: 'source',
                required: true,
                aliases: ['datatable'],
                means: 'Id of the datatable. It must be bound to this page in bridge_grants.tables.',
            },
            {
                name: 'limit',
                required: false,
                max: PUBLIC_ROWS_MAX,
                means: 'How many rows to show. Clamped to 100; a missing or unreadable value means 100.',
            },
        ],
        binding: {
            kind: 'datatable',
            from: 'source',
            // De poort is `publicColumns`, NOOIT `columns`. Leeg betekent GEEN
            // kolom — er bestaat met opzet geen waarde die "alles" zegt.
            gate: 'bridge_grants.tables[].publicColumns',
        },
        surfaces: {
            clientComposer: {
                state: 'live',
                why: 'De ingelogde lezer haalt de rijen zelf op via window.beeflowTables, als zichzelf, met zijn eigen graad.',
            },
            reactShare: {
                state: 'refused',
                message: 'bf-table is not expanded on a shared React page',
                notice: 'This table cannot be shown on a shared link.',
                why: 'writeReactSnapshot bundelt de app en draait GEEN uitklappass; beeflowTables weigert bovendien op een share.',
            },
            vanillaSnapshot: {
                state: 'static',
                why: 'Eenmalig uitgelezen bij publiceren en tot gewone <table>-HTML gerenderd, VÓÓR DOMPurify (services/webpageBfTable.js).',
            },
            headlessRender: {
                state: 'refused',
                message: 'bf-table is not expanded in the preview image',
                notice: 'This table is not shown in the preview image.',
                why: 'services/webpageRender.js schiet een plaatje in de bf-browser, die van de API is afgesneden; '
                    + 'buildStubBridgeScript weigert daar beeflowTables. Er valt niets te lezen, en de bouwer-AI '
                    + 'die naar dat plaatje kijkt moet dat kunnen ZIEN in plaats van een lege plek voor "geen rijen" '
                    + 'aan te zien.',
            },
        },
    },
    {
        tag: 'bf-stat',
        summary: 'A single number derived from a bound datatable (a count, sum, average, minimum or maximum).',
        needsJs: false,
        attributes: [
            {
                name: 'source',
                required: true,
                aliases: ['datatable'],
                means: 'Id of the datatable. It must be bound to this page in bridge_grants.tables.',
            },
            {
                name: 'agg',
                required: false,
                values: ['count', 'sum', 'avg', 'min', 'max'],
                default: 'count',
                means: 'Which number to show. Defaults to counting the rows.',
            },
            {
                name: 'column',
                required: false,
                requiredWhen: { attr: 'agg', notOneOf: ['count'] },
                means: 'Column to aggregate. Required for every agg except count, and it must be one of the public columns.',
            },
            {
                name: 'label',
                required: false,
                means: 'Caption shown next to the number.',
            },
        ],
        // Over hoeveel rijen dit getal gaat — op ELKE plek hetzelfde. Zonder dit
        // vroeg de client niets en rekende de server-default (50) tegen de 500
        // van de gepubliceerde pagina in: twee getallen voor één element.
        reads: { rowsMax: STAT_ROWS_MAX },
        binding: {
            kind: 'datatable',
            from: 'source',
            // Dezelfde poort als bf-table, om dezelfde reden: een som over een
            // kolom die niet publiek is, publiceert die kolom alsnog.
            gate: 'bridge_grants.tables[].publicColumns',
        },
        surfaces: {
            clientComposer: {
                state: 'live',
                why: 'Wordt net als bf-table door de lezer zelf berekend via window.beeflowTables.',
            },
            reactShare: {
                state: 'refused',
                message: 'bf-stat is not expanded on a shared React page',
                notice: 'This number cannot be calculated on a shared link.',
                why: 'Zelfde reden als bf-table: een react-share kent geen server-side uitklappass.',
            },
            vanillaSnapshot: {
                state: 'static',
                why: 'Eenmalig berekend bij publiceren en als gewone tekst neergezet, VÓÓR DOMPurify.',
            },
            headlessRender: {
                state: 'refused',
                message: 'bf-stat is not calculated in the preview image',
                notice: 'This number is not calculated for the preview image.',
                why: 'Zelfde reden als bf-table: geen tabelbrug in de headless render.',
            },
        },
    },
    {
        tag: 'bf-button',
        summary: 'A button that runs one of the automations this page is allowed to run.',
        needsJs: true,
        attributes: [
            {
                name: 'run',
                required: true,
                means: 'Id of the automation to run. It must be granted to this page in bridge_grants.automations.',
            },
            {
                name: 'label',
                required: false,
                means: 'Button text. Falls back to the text inside the element.',
            },
            {
                name: 'confirm',
                required: false,
                means: 'Ask the reader to confirm before running. Any non-empty value turns it on.',
            },
        ],
        binding: {
            kind: 'automation',
            from: 'run',
            gate: 'bridge_grants.automations',
        },
        surfaces: {
            clientComposer: {
                state: 'live',
                why: 'window.beeflowAutomations.run draait acts-as-author voor een ingelogde lezer.',
            },
            reactShare: {
                state: 'refused',
                message: 'bf-button cannot run an automation on a shared link',
                notice: 'This button cannot run anything on a shared link.',
                why: 'De anonieme brug stubt beeflowAutomations.run als no-op; de server weigert dat oppervlak sowieso. '
                    + 'Een no-op die RESOLVET is hier het gevaarlijkst van allemaal: de knop meldt dan succes zonder '
                    + 'iets te doen. Daarom moet dit element zijn weigering ZELF tonen, niet op de brug wachten.',
            },
            vanillaSnapshot: {
                state: 'inert',
                notice: 'This button is not active in the published copy of this page.',
                why: 'De vanilla snapshot bevat geen JS, dus er valt niets te starten. Uitklappen tot een zichtbaar '
                    + 'uitgeschakelde knop MET deze tekst, vóór DOMPurify — anders pakt de sanitizer het element stil '
                    + 'uit en blijft er alleen de losse tekst over. harden() sloopt daarna elke on*= alsnog.',
            },
            headlessRender: {
                state: 'refused',
                message: 'bf-button cannot run an automation in the preview image',
                notice: 'This button is not active in the preview image.',
                why: 'De stub-brug maakt van beeflowAutomations.run een weigering; een routine starten vanuit een '
                    + 'screenshot mag sowieso niet.',
            },
        },
    },
    {
        tag: 'bf-form',
        summary: 'A form whose submission is handed to one of the automations this page is allowed to run.',
        needsJs: true,
        attributes: [
            {
                name: 'automation',
                required: true,
                means: 'Id of the automation that receives the submitted fields. It must be granted to this page in bridge_grants.automations.',
            },
            {
                name: 'submit-label',
                required: false,
                means: 'Text on the submit button.',
            },
            {
                name: 'confirm',
                required: false,
                means: 'Ask the reader to confirm before submitting. Any non-empty value turns it on.',
            },
        ],
        binding: {
            kind: 'automation',
            from: 'automation',
            gate: 'bridge_grants.automations',
        },
        surfaces: {
            clientComposer: {
                state: 'live',
                why: 'De ingelogde lezer verstuurt via window.beeflowAutomations.run.',
            },
            reactShare: {
                state: 'refused',
                message: 'bf-form cannot submit to an automation on a shared link',
                notice: 'This form cannot be submitted on a shared link.',
                why: 'Zelfde no-op-stub als bf-button, met hetzelfde gevaar: stil "verzonden" zonder ontvanger.',
            },
            vanillaSnapshot: {
                state: 'inert',
                notice: 'This form is not active in the published copy of this page.',
                why: 'LET OP: NIET uitklappen tot een echte <form>. DOMPurify heeft `form` in FORBID_TAGS staan, dus het '
                    + 'formulier zelf verdwijnt en KEEP_CONTENT laat de losse velden staan — een half formulier zonder '
                    + 'knop. Uitklappen tot een gewoon blok met deze tekst en uitgeschakelde velden.',
            },
            headlessRender: {
                state: 'refused',
                message: 'bf-form cannot submit to an automation in the preview image',
                notice: 'This form is not active in the preview image.',
                why: 'Zelfde weigering als bf-button, en om dezelfde reden.',
            },
        },
    },
    {
        tag: 'bf-agent',
        summary: 'An inline chat block backed by one of your agents.',
        needsJs: true,
        attributes: [
            {
                name: 'agent',
                required: false,
                means: "Id of the agent. Leave it out to use the agent bound to this page (bridge_grants.agent).",
            },
            {
                name: 'placeholder',
                required: false,
                means: 'Placeholder text in the input.',
            },
        ],
        binding: {
            kind: 'agent',
            from: 'agent',
            // Zonder attribuut valt hij terug op de agent van de PAGINA. Dat is
            // geen "geen binding": de usage-index moet die pagina-agent tellen.
            fallback: 'bridge_grants.agent',
            gate: 'bridge_grants.agent',
        },
        surfaces: {
            clientComposer: {
                state: 'live',
                why: 'window.beeflowAI.ask draait de agentische gereedschapslus voor een ingelogde lezer.',
            },
            reactShare: {
                state: 'refused',
                message: 'bf-agent is not available on a shared link',
                notice: 'The assistant is not available on a shared link.',
                why: 'ai.ask is bewust uit de anonieme brug gehouden (alleen /ai/chat en /ai/stream); een publieke '
                    + 'agent vereist eerst het bevestigingsbeleid en krijgt dán zijn eigen expliciete veld.',
            },
            vanillaSnapshot: {
                state: 'inert',
                notice: 'The assistant is not available in the published copy of this page.',
                why: 'Geen JS én geen agent-brug: dubbel dood. Uitklappen tot een blok met deze tekst.',
            },
            headlessRender: {
                state: 'refused',
                message: 'bf-agent is not available in the preview image',
                notice: 'The assistant is not available in the preview image.',
                why: 'De stub-brug kent geen ask; en een screenshot laten wachten op een agentische lus zou de '
                    + 'render laten aflopen.',
            },
        },
    },
]);

// ── DE PROJECTIE NAAR EEN PUBLIEKE SHARE ──────────────────────────────
//
// `publicShareVocabulary()` zendt het vocabulaire de browser in. Wat daar wel
// en niet in hoort is niet aan de brug maar aan deze tabel, en de tabel moet
// VOLLEDIG zijn: `assertProjectionComplete()` gooit op REQUIRE-tijd zodra een
// veld in geen van beide kolommen staat.
//
// Waarom beide kolommen expliciet, en niet "alles behalve"? Twee gevaren, en
// ze wijzen tegengesteld:
//
//   - "alles verzenden tenzij tegengehouden" laat een nieuw veld ongemerkt in
//     de bron van een publieke pagina belanden. `binding.gate` noemt interne
//     poortpaden; zoiets hoort daar niet;
//   - "niets verzenden tenzij opgesomd" laat een nieuw veld ongemerkt op de
//     server achter, en dan draagt de tweeling niet meer dezelfde definitie —
//     precies de drift die deze module bestaat om te voorkomen.
//
// Met beide kolommen expliciet is er geen stille derde weg: je moet kiezen.
/**
 * De plekken waar een BRUG het oordeel uitzendt, en die dus door
 * PUBLIC_SHARE_PROJECTION moeten worden gedekt.
 *
 *   reactShare      — de publiek gedeelde react-mui-pagina;
 *   headlessRender  — het plaatje dat de bouwer-AI van de pagina te zien krijgt
 *                     (services/webpageRender.js, via de ingebakken stub-brug).
 *
 * `clientComposer` staat er niet bij: die leest de gegenereerde spiegel, dus
 * daar gaat het HELE vocabulaire heen en valt er niets te projecteren.
 * `vanillaSnapshot` ook niet: daar draait geen brug — de uitklapper zet er
 * gewone HTML neer.
 */
const BRIDGE_SURFACES = Object.freeze(['reactShare', 'headlessRender']);

const PUBLIC_SHARE_PROJECTION = deepFreeze({
    element: {
        ship: ['summary', 'needsJs', 'attributes', 'reads'],
        hold: {
            tag: 'staat al als SLEUTEL van de uitzending; nog eens als veld is een tweede waarheid',
            binding: 'noemt interne poortpaden (bridge_grants.*) — die horen niet in de bron van een publieke pagina',
            surfaces: 'de andere plekken gaan deze lezer niet aan; de plek waar de brug draait wordt platgeslagen',
        },
    },
    surface: {
        // Precies één plek per uitzending — de plek waar de brug op draait.
        ship: ['state', 'message', 'notice'],
        hold: {
            why: 'Nederlandse verantwoording voor ontwikkelaars, geen paginatekst',
        },
    },
    attribute: {
        ship: ['name', 'required', 'aliases', 'values', 'default', 'max', 'requiredWhen'],
        hold: {
            means: 'ontwikkelaarsuitleg die interne poortpaden noemt (bridge_grants.*)',
        },
    },
});

/**
 * Gooit als een veld uit het vocabulaire in geen van beide kolommen van de
 * projectie staat. Module-niveau, dus een nieuw veld toevoegen zonder erover te
 * beslissen laat deze module — en daarmee de publieke brug — niet meer laden.
 *
 * @param {Array} [elements]  te toetsen definities. Standaard het echte
 *   vocabulaire; een test geeft er een verzonnen element aan mee, want het
 *   echte is bevroren en dus niet te muteren.
 */
function assertProjectionComplete(elements = BF_ELEMENTS) {
    const undecided = [];
    const check = (level, keys, where) => {
        const { ship, hold } = PUBLIC_SHARE_PROJECTION[level];
        for (const key of keys) {
            if (ship.includes(key) || Object.prototype.hasOwnProperty.call(hold, key)) continue;
            undecided.push(`${where}.${key}`);
        }
    };
    for (const def of elements) {
        check('element', Object.keys(def), def.tag);
        // Elke plek waarvan een BRUG het oordeel uitzendt. `clientComposer` gaat
        // via de gegenereerde spiegel en niet via deze projectie.
        for (const surface of BRIDGE_SURFACES) {
            // Een plek waarover dit element helemaal niets zegt is geen crash en
            // ook geen stilte: hij komt hieronder als onbeslist terug, met dezelfde
            // melding als een onbeslist veld.
            if (!def.surfaces || !def.surfaces[surface]) {
                undecided.push(`${def.tag}.surfaces.${surface} (ontbreekt helemaal)`);
                continue;
            }
            check('surface', Object.keys(def.surfaces[surface]), `${def.tag}.surfaces.${surface}`);
        }
        for (const attr of def.attributes) check('attribute', Object.keys(attr), `${def.tag}[${attr.name}]`);
    }
    if (!undecided.length) return true;
    throw new Error(
        `[bfElements] PUBLIC_SHARE_PROJECTION zegt niets over ${undecided.join(', ')}. `
        + 'Zet elk veld in `ship` (de publieke brug zendt het uit) of in `hold` (mét de reden waarom het op de '
        + 'server blijft). Zolang dat niet is gebeurd, zou de tweeling een ander vocabulaire dragen dan de '
        + 'registry, en dat is precies de drift die deze module moet voorkomen.',
    );
}
assertProjectionComplete();

/** Alle bekende tagnamen, in de volgorde van het vocabulaire. */
const BF_TAGS = Object.freeze(BF_ELEMENTS.map(e => e.tag));

const BY_TAG = new Map(BF_ELEMENTS.map(e => [e.tag, e]));

// ── kleine helpers ────────────────────────────────────────────────────

/** Ziet dit eruit als een van ONZE elementen? Zegt niets over of we hem kennen. */
function isBfTag(tag) {
    return typeof tag === 'string' && BF_TAG_PATTERN.test(tag.trim().toLowerCase());
}

/** De definitie, of `null`. Onbekend geeft NOOIT een lege definitie terug. */
function getBfElement(tag) {
    if (typeof tag !== 'string') return null;
    return BY_TAG.get(tag.trim().toLowerCase()) || null;
}

function isKnownBfTag(tag) {
    return getBfElement(tag) !== null;
}

/** Elementen die JS nodig hebben — in de vanilla snapshot per definitie inert. */
function tagsNeedingJs() {
    return BF_ELEMENTS.filter(e => e.needsJs).map(e => e.tag);
}

/** Elementen die server-side tot statische HTML kunnen worden uitgevouwen. */
function tagsExpandedServerSide() {
    return BF_ELEMENTS.filter(e => !e.needsJs).map(e => e.tag);
}

/** De attribuutdefinitie bij een geschreven naam (canoniek of alias). */
function attributeSpec(tag, written) {
    const def = getBfElement(tag);
    if (!def || typeof written !== 'string') return null;
    const name = written.trim().toLowerCase();
    return def.attributes.find(a => a.name === name || (a.aliases || []).includes(name)) || null;
}

/** De canonieke naam bij een geschreven naam, of `null` als we hem niet kennen. */
function canonicalAttribute(tag, written) {
    const spec = attributeSpec(tag, written);
    return spec ? spec.name : null;
}

function attrGetter(source) {
    if (!source) return () => null;
    if (typeof source.getAttribute === 'function') return (n) => source.getAttribute(n);
    if (typeof source === 'object') {
        return (n) => (Object.prototype.hasOwnProperty.call(source, n) ? source[n] : null);
    }
    return () => null;
}

/**
 * De attributen van één element, op canonieke naam.
 *
 * @param {string} tag
 * @param {object|Function} source  een DOM-element (`getAttribute`) of een
 *                                  gewoon object met de geschreven namen
 * @returns {Object<string,string>} alleen niet-lege waarden, getrimd. Een alias
 *                                  landt onder zijn canonieke naam; een lege of
 *                                  ontbrekende waarde ontbreekt gewoon.
 */
function readAttributes(tag, source) {
    const def = getBfElement(tag);
    if (!def) return {};
    const get = attrGetter(source);
    const out = {};
    for (const spec of def.attributes) {
        for (const name of [spec.name, ...(spec.aliases || [])]) {
            const raw = get(name);
            if (raw === null || raw === undefined) continue;
            const value = String(raw).trim();
            if (!value) continue;
            out[spec.name] = value;
            break;
        }
    }
    return out;
}

/** Dezelfde attributen, met de verklaarde defaults ingevuld. */
function effectiveAttributes(tag, attrs) {
    const def = getBfElement(tag);
    if (!def) return {};
    const out = { ...(attrs || {}) };
    for (const spec of def.attributes) {
        if (out[spec.name] === undefined && spec.default !== undefined) out[spec.name] = spec.default;
    }
    return out;
}

/** Is dit attribuut hier verplicht, gegeven wat er verder geschreven staat? */
function isRequired(spec, effective) {
    if (spec.required === true) return true;
    const when = spec.requiredWhen;
    if (!when) return false;
    const value = effective[when.attr];
    if (value === undefined) return false;
    return !(when.notOneOf || []).includes(value);
}

/**
 * Welke verplichte attributen ontbreken? Canonieke namen, in vocabulairevolgorde.
 * Een ONBEKEND element levert `null` — "we weten het niet" is iets anders dan
 * "er ontbreekt niets".
 */
function missingAttributes(tag, attrs) {
    const def = getBfElement(tag);
    if (!def) return null;
    const effective = effectiveAttributes(tag, attrs);
    return def.attributes
        .filter(spec => isRequired(spec, effective) && !effective[spec.name])
        .map(spec => spec.name);
}

/**
 * Wat dit element oplevert voor de usage-index.
 *
 * @returns {{kind:string, id:(string|null), from:string, gate:string, fallback:(string|null)}|null}
 *   `null` als het element niets bindt of we hem niet kennen. `id: null` met een
 *   `fallback` betekent: neem wat er in dat veld van de PAGINA staat.
 */
function bindingFor(tag, attrs) {
    const def = getBfElement(tag);
    if (!def || !def.binding) return null;
    const effective = effectiveAttributes(tag, attrs);
    const id = effective[def.binding.from] || null;
    const fallback = def.binding.fallback || null;
    if (!id && !fallback) return null;
    return {
        kind: def.binding.kind,
        id,
        from: def.binding.from,
        gate: def.binding.gate,
        fallback,
    };
}

/**
 * Alles wat je van één element wilt weten, in één antwoord.
 *
 * Een onbekend `bf-*`-element komt hier terug als `{ known: false }` met een
 * `reason` — HERKENBAAR onbekend, nooit een lege definitie die zich als een
 * bekend element voordoet.
 */
function inspectBfElement(tag, source) {
    const name = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
    const def = getBfElement(name);
    if (!def) {
        return {
            tag: name,
            known: false,
            // Twee soorten "niet van ons": `<div>` is geen bf-element, en
            // `<bf-widget>` ziet er wél zo uit maar bestaat niet.
            isBf: isBfTag(name),
            reason: isBfTag(name) ? 'unknown-bf-element' : 'not-a-bf-element',
            attrs: {},
            missing: null,
            binding: null,
            needsJs: null,
            surfaces: null,
        };
    }
    const attrs = readAttributes(name, source);
    return {
        tag: def.tag,
        known: true,
        isBf: true,
        reason: null,
        attrs,
        missing: missingAttributes(name, attrs),
        binding: bindingFor(name, attrs),
        needsJs: def.needsJs,
        surfaces: def.surfaces,
    };
}

/** Staat er überhaupt iets van ons in deze HTML? Goedkoop, vóór elke JSDOM. */
function hasBfTags(html) {
    return /<\s*bf-/i.test(typeof html === 'string' ? html : '');
}

/**
 * Welke `bf-*`-tags staan er in deze HTML — en welke daarvan kennen we niet?
 *
 * Dit is de plek die "stil doorgelaten" onmogelijk maakt: DOMPurify pakt een
 * onbekend element zonder één waarschuwing uit, dus wie wil weten dát er iets
 * onbekends stond, moet het hiervóór tellen.
 *
 * @returns {{found:string[], known:string[], unknown:string[]}} ontdubbeld,
 *   kleine letters, in volgorde van eerste voorkomen.
 */
function scanBfTags(html) {
    const src = typeof html === 'string' ? html : '';
    const found = [];
    const re = new RegExp(BF_TAG_SCAN.source, 'gi');
    let m;
    while ((m = re.exec(src)) !== null) {
        const tag = String(m[1] || '').toLowerCase();
        if (!found.includes(tag)) found.push(tag);
    }
    return {
        found,
        known: found.filter(isKnownBfTag),
        unknown: found.filter(t => !isKnownBfTag(t)),
    };
}

/**
 * DE BIJT-TOETS. Gooit als een consument het vocabulaire niet volledig dekt.
 *
 * Wordt op MODULE-NIVEAU aangeroepen door elke serverconsument, dus een element
 * toevoegen zonder daar een beslissing te noteren laat de module niet meer
 * laden. Beide richtingen: een ontbrekende tag én een tag die hier niet bestaat.
 *
 * @param {string} surface  wie er dekt — komt letterlijk in de foutmelding
 * @param {string[]|Object} handled  de tags die de consument afhandelt
 */
function assertCoversVocabulary(surface, handled) {
    const listed = Array.isArray(handled) ? handled : Object.keys(handled || {});
    const seen = listed.map(t => String(t || '').trim().toLowerCase());
    const missing = BF_TAGS.filter(t => !seen.includes(t));
    const stray = seen.filter(t => !isKnownBfTag(t));
    if (!missing.length && !stray.length) return true;
    const parts = [];
    if (missing.length) {
        parts.push(`zegt niets over ${missing.join(', ')} — een element dat hier niet wordt genoemd, `
            + 'verdwijnt stil (DOMPurify pakt een onbekend element zonder waarschuwing uit)');
    }
    if (stray.length) {
        parts.push(`noemt ${stray.join(', ')}, en dat bestaat niet in core/webpages/bfElements.js`);
    }
    throw new Error(`[bfElements] ${surface} ${parts.join('; ')}.`);
}

/**
 * Het vocabulaire zoals het op een PUBLIEKE react-share geldt.
 *
 * Afgeleid, niet verklaard: de publieke brug zendt dit letterlijk uit, dus een
 * nieuw element — of een nieuw ATTRIBUUT van een bestaand element — staat er
 * vanzelf in. Wat er wel en niet meegaat staat in PUBLIC_SHARE_PROJECTION, en
 * die tabel moet volledig zijn (zie `assertProjectionComplete`).
 *
 * Elke ingang draagt twee teksten, en dat verschil is de hele bedoeling:
 *
 *   message  ontwikkelaarstekst, met de tagnaam erin, voor de console
 *            (`beeflowBf.reason()`);
 *   notice   de zin die de LEZER in het element zelf te zien krijgt.
 *
 * Beide zijn een weigering MET reden — dezelfde regel als `beeflowTables`, dat
 * op een share met opzet WEIGERT in plaats van een lege lijst terug te geven
 * ("geen rijen" ≠ "hier kun je geen tabel lezen"). Een geweigerd element dat
 * niets zegt, is niet te onderscheiden van een leeg element, en dat is precies
 * het verschil dat W4 beschermt.
 *
 * @returns {Object<string, object>} tag → de projectie. Niets in deze uitvoer
 *   is een verwijzing naar het bevroren vocabulaire: de brug serialiseert het
 *   naar JSON en de browser mag ermee doen wat hij wil.
 */
function bridgeVocabulary(surface = 'reactShare') {
    if (!BRIDGE_SURFACES.includes(surface)) {
        // Geen stille terugval op reactShare: dan zou een verschreven plek de
        // teksten van een ANDERE plek uitzenden, en dat is precies de leugen die
        // deze module moet voorkomen ("op een gedeelde link" op een plek die
        // geen gedeelde link is).
        throw new Error(`[bfElements] ${surface} is geen brug-plek; ken er een in BRIDGE_SURFACES.`);
    }
    const project = (level, source) => {
        const out = {};
        for (const key of PUBLIC_SHARE_PROJECTION[level].ship) {
            // Een veld dat dit element niet heeft, ontbreekt gewoon — behalve de
            // twee teksten hieronder, die altijd een uitspraak moeten dragen.
            if (source[key] !== undefined) out[key] = source[key];
        }
        return out;
    };
    const out = {};
    for (const def of BF_ELEMENTS) {
        const entry = project('element', def);
        entry.attributes = def.attributes.map(a => project('attribute', a));
        Object.assign(entry, project('surface', def.surfaces[surface]));
        // Expliciet `null` in plaats van "ontbreekt": de brug moet kunnen zien
        // dát er geen tekst is, en dan zelf terugvallen.
        if (entry.message === undefined) entry.message = null;
        if (entry.notice === undefined) entry.notice = null;
        out[def.tag] = entry;
    }
    return out;
}

/** Het vocabulaire van de PUBLIEKE react-share. Eén plek, met een eigen naam. */
function publicShareVocabulary() {
    return bridgeVocabulary('reactShare');
}

/**
 * Het vocabulaire als proza, voor de bouwer-prompt.
 *
 * Ook dit is afgeleid: zo ontstaat er straks geen VIERDE handbijgehouden lijst
 * in routes/ai/webpageChat.js, dat vandaag geen enkel `bf-*`-element noemt en
 * ze dus ook niet kán voorstellen.
 */
function vocabularyPromptLines() {
    return BF_ELEMENTS.map((def) => {
        const attrs = def.attributes
            .map(a => `${a.name}${a.required ? ' (required)' : ''}: ${a.means}`)
            .join(' | ');
        const published = def.surfaces.vanillaSnapshot.state === 'static'
            ? 'rendered server-side into plain HTML when the page is published'
            : `INERT once published: "${def.surfaces.vanillaSnapshot.notice}"`;
        return `<${def.tag}> — ${def.summary} Attributes: ${attrs}. Published pages: ${published}.`;
    });
}

// ── de gegenereerde client-spiegel ────────────────────────────────────

const CLIENT_MIRROR_BEGIN = '// >>> BF-ELEMENTS: BEGIN GEGENEREERDE SPIEGEL <<<';
const CLIENT_MIRROR_END = '// >>> BF-ELEMENTS: EINDE GEGENEREERDE SPIEGEL <<<';

/**
 * Het blok dat letterlijk tussen de markers in
 * agent-hub/src/utils/bfElements.js hoort te staan.
 *
 * De client is ESM-frontendcode buiten de build van de server-
 * modules; hij kan deze CommonJS-module niet importeren (dezelfde reden waarom
 * publicBridgeScript.js en reactBundleServer.js hun eigen kopie van de
 * client-brug houden). Een spiegel is dus onvermijdelijk — maar hij is
 * GEGENEREERD en wordt teken voor teken vergeleken, niet met de hand
 * bijgehouden en met het oog vergeleken.
 */
function renderClientMirror() {
    return [
        CLIENT_MIRROR_BEGIN,
        '// Gegenereerd uit server/core/webpages/bfElements.js — NIET met de hand',
        '// bijwerken. bfElements.drift.test.js vergelijkt dit blok teken voor teken',
        '// met renderClientMirror() en zet de vervangende tekst in zijn foutmelding.',
        `export const BF_ELEMENTS = ${JSON.stringify(BF_ELEMENTS, null, 4)};`,
        CLIENT_MIRROR_END,
    ].join('\n');
}

module.exports = {
    BF_ELEMENTS,
    BF_TAGS,
    BF_TAG_PATTERN,
    BF_TAG_SCAN,
    SURFACES,
    STATES,
    PUBLIC_ROWS_MAX,
    STAT_ROWS_MAX,

    isBfTag,
    isKnownBfTag,
    getBfElement,
    tagsNeedingJs,
    tagsExpandedServerSide,

    attributeSpec,
    canonicalAttribute,
    readAttributes,
    effectiveAttributes,
    missingAttributes,
    bindingFor,
    inspectBfElement,

    hasBfTags,
    scanBfTags,

    assertCoversVocabulary,
    assertProjectionComplete,
    PUBLIC_SHARE_PROJECTION,
    BRIDGE_SURFACES,
    bridgeVocabulary,
    publicShareVocabulary,
    vocabularyPromptLines,

    renderClientMirror,
    CLIENT_MIRROR_BEGIN,
    CLIENT_MIRROR_END,
};
