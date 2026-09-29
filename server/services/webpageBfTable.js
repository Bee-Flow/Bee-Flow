/**
 * Het `bf-*`-vocabulaire → STATISCHE HTML, voor de publieke snapshot.
 *
 * ── WAAROM DIT EEN ANDER PAD IS, EN GEEN VARIANT ────────────────────
 *
 * Voor een ingelogde lezer haalt de pagina zijn rijen zelf op via
 * `window.beeflowTables` (routes/webpagesPreviewTables.js), als DIE BEZOEKER,
 * met diens eigen graad. Op `/w/<slug>` bestaat dat mechanisme niet: een
 * publieke share is een script-vrije, door DOMPurify gehaalde snapshot en de
 * anonieme brug kent alleen /ai/chat en /ai/stream. Er is dus niemand om "als"
 * te lezen en geen JS om het mee te doen.
 *
 * Daarom worden de elementen hier, op het moment van publiceren, ÉÉN keer
 * uitgeklapt tot gewone HTML — vóór DOMPurify, zodat wat er overblijft
 * doodgewone opmaak is en het `bf-*`-element zelf verdwijnt.
 *
 * ── TWEE SOORTEN ELEMENT, EN ALLEBEI MOETEN ZE IETS ACHTERLATEN ─────
 *
 * `VANILLA_HANDLING` hieronder spreekt zich over élk element uit, in twee
 * standen:
 *
 *   expand  — het element leest data (`bf-table`, `bf-stat`) en wordt hier tot
 *             gewone opmaak gerenderd uit `publicColumns`;
 *   inert   — het element heeft JS nodig (`bf-button`, `bf-form`, `bf-agent`)
 *             en er draait hier geen JS. Het wordt uitgeklapt tot een blok dat
 *             ZELF vertelt dat het in de gepubliceerde kopie niet werkt.
 *
 * Die tweede stand is de hele reden dat deze module over meer dan tabellen
 * gaat. Zonder uitklappen pakt DOMPurify een onbekend element stilzwijgend uit
 * (`KEEP_CONTENT: true`, en `ADD_TAGS` bevat alleen `iframe`): van
 * `<bf-button run="a1">Send</bf-button>` blijft letterlijk `Send` over — de
 * tag weg, de attributen weg, geen waarschuwing, geen spoor. De lezer ziet dan
 * een pagina waar een knop hoorde te staan, zonder te weten dat er iets weg is.
 * Zetten we het element wél door de sanitizer heen (via `ADD_TAGS`), dan staat
 * er een knop die niets doet en dat ook niet zegt. Allebei fout, en om dezelfde
 * reden: dood mag, stil niet.
 *
 * `assertCoversVocabulary` gooit op REQUIRE-tijd als een element in de
 * handelingstabel ontbreekt, en `assertHandlingIsWorkable` als een tabel-ingang
 * niet waar te maken is (een `expand` zonder uitklapper, een `inert` zonder
 * tekst). Een element toevoegen zonder hier te beslissen laat de server dus
 * niet meer starten.
 *
 * ── DE POORT IS `publicColumns`, EN ALLEEN DIE ──────────────────────
 *
 * Niet `columns`. `columns` zegt wat de PAGINA intern mag lezen;
 * `publicColumns` zegt wat er naar buiten mag, en de normalizer knipt dat al
 * tot een deelverzameling van `columns`. Leeg betekent GEEN kolom — er bestaat
 * met opzet geen waarde die "alles" zegt — dus een auteur die niets heeft
 * aangewezen publiceert niets. Dat is de default, en dat hoort het te blijven:
 * een lege lijst mag nooit "dan maar alle kolommen" gaan betekenen.
 *
 * Dat geldt voor `bf-stat` net zo hard als voor `bf-table`, en op twee manieren
 * tegelijk. Een som over een kolom die niet in `publicColumns` staat publiceert
 * die kolom alsnog — samengevat, maar het is dezelfde data — dus die kolom moet
 * er zelf in staan. En een tabel zónder publieke kolom publiceert ook geen
 * `count`: hoeveel rijen er zijn is een uitspraak over die tabel, en over een
 * tabel waarvan niets publiek is doen we geen uitspraken.
 *
 * De rijen worden gelezen ALS DE EIGENAAR van de pagina. Dat is hier juist wél
 * goed: publiceren is een expliciete daad van de auteur, en wat hij publiceert
 * is een uittreksel van data die hij zelf mag zien. Een anonieme lezer heeft
 * geen graad, dus er valt niets anders te vragen. Precies daarom is de poort
 * eng: alleen de kolommen die de auteur bij "Openbaar zetten" heeft aangewezen.
 *
 * ── ALLES WAT MISGAAT RENDERT NIETS ─────────────────────────────────
 * Niet gebonden, geen publieke kolommen, geen graad (meer), databank plat, of
 * een tabel die niet in één leesbeurt past: in al die gevallen komt er een leeg
 * blok terug, nooit het onbewerkte element en nooit een breder antwoord dan
 * gevraagd. "Onbekend" versmalt — en een getal dat over de helft van de rijen
 * gaat is erger dan geen getal.
 *
 * ── DE DEFINITIE STAAT HIER NIET ────────────────────────────────────
 *
 * De tagnamen, de attributen (`source`, met `datatable` als oudere schrijfwijze,
 * `limit`, `agg`, …), de bovengrens en de teksten van de inerte meldingen komen
 * uit core/webpages/bfElements.js. Deze module houdt daar met opzet geen kopie
 * van: dat is precies de drift die W4 bestaat om te voorkomen. Zie de kop van
 * die module voor de vier sloten.
 *
 * ── DE NAAM VAN DIT BESTAND LOOPT ACHTER ────────────────────────────
 *
 * Het heet `webpageBfTable` omdat `bf-table` er als eerste in landde. Het is
 * inmiddels de uitklapper van het hele vocabulaire; de bestandsnaam is bewust
 * niet meegewijzigd om een hernoeming niet met deze stap te verweven.
 */
'use strict';

const { JSDOM } = require('jsdom');

// Als namespace, niet gedestructureerd: dan is één module één aanspreekpunt en
// blijft de aanroep op de leesplek zichtbaar (en te vervangen in een test).
const bridgeGrants = require('../stores/webpage/bridgeGrants');
const datatableAccess = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const bfElements = require('../core/webpages/bfElements');
const log = require('../telemetry/log');

/** De definities waar deze module over gaat. Eén plek, geen tweede lijst. */
const TABLE = bfElements.getBfElement('bf-table');
const STAT = bfElements.getBfElement('bf-stat');

/**
 * Wat de VANILLA publieke snapshot met elk element van het vocabulaire doet.
 *
 *   expand  — deze module rendert hem hier en nu tot statische HTML uit
 *             `publicColumns`;
 *   inert   — hij heeft JS nodig en dat is er hier niet, dus hij wordt
 *             uitgeklapt tot een blok dat ZELF meldt dat het niet werkt. De
 *             tekst van die melding staat in het vocabulaire
 *             (`surfaces.vanillaSnapshot.notice`), niet hier.
 *
 * Er is geen derde stand. Elk element in de registry SPREEKT ZICH AL UIT over
 * deze plek (`surfaces.vanillaSnapshot.state`), dus "nog niet bediend" zou hier
 * altijd een tegenspraak met die uitspraak zijn — en juist die tegenspraak is
 * onzichtbaar in de uitvoer: het element wordt dan niet uitgeklapt, DOMPurify
 * pakt hem zwijgend uit, en de pagina mist iets zonder dat iemand het merkt.
 * `assertHandlingIsWorkable` legt de tabel daarom naast de registry en gooit op
 * require-tijd bij het minste verschil.
 */
const VANILLA_HANDLING = Object.freeze({
    'bf-table': 'expand',
    'bf-stat': 'expand',
    'bf-button': 'inert',
    'bf-form': 'inert',
    'bf-agent': 'inert',
});
bfElements.assertCoversVocabulary('services/webpageBfTable (vanilla snapshot)', VANILLA_HANDLING);

/** Bovengrens per publieke tabel — een snapshot is een pagina, geen export. */
const PUBLIC_ROWS_MAX = bfElements.attributeSpec('bf-table', 'limit').max;
const PUBLIC_CELL_MAX = 500;

/**
 * Hoeveel rijen een `bf-stat` hoogstens optelt.
 *
 * Er is (nog) geen `readAggregate` op datatableRuntime, dus een som wordt
 * uitgerekend over de rijen die één leesbeurt oplevert. `readRows` klemt zelf op
 * `ROWS_PAGE_MAX`, dus verder vragen heeft geen zin — en past de tabel er niet
 * in, dan komt er GEEN getal (`hasMore` → leeg blok). Een getal dat over de
 * eerste 500 van 5000 rijen gaat, is niet "ongeveer goed": het is fout, en het
 * ziet er precies zo betrouwbaar uit als een goed getal.
 */
const PUBLIC_STAT_ROWS_MAX = STAT.reads.rowsMax;
if (PUBLIC_STAT_ROWS_MAX > datatableRuntime.ROWS_PAGE_MAX) {
    // Startfout, geen stille klem: als de registry meer rijen belooft dan één
    // leesbeurt levert, is `hasMore` altijd waar en publiceert deze pagina nooit
    // meer een getal — zonder dat iemand ziet waarom.
    throw new Error(`[WebpageBfTable] bf-stat vraagt ${PUBLIC_STAT_ROWS_MAX} rijen, maar één leesbeurt levert er `
        + `hoogstens ${datatableRuntime.ROWS_PAGE_MAX}.`);
}

/** De aggregaties die `bf-stat` kent — uit het vocabulaire, niet uit een lijst hier. */
const STAT_AGGREGATIONS = bfElements.attributeSpec('bf-stat', 'agg').values;

/** Wat er in een inert blok wordt uitgeschakeld: alles wat bedienbaar oogt. */
const CONTROLS = 'button,input,select,textarea';

/** Eén cel als tekst. Nooit HTML: alles gaat via textContent. */
function cellText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        try { return JSON.stringify(value).slice(0, PUBLIC_CELL_MAX); }
        catch { return ''; }
    }
    return String(value).slice(0, PUBLIC_CELL_MAX);
}

/** De leesbare kop van een kolom, met de sleutel als terugval. */
function labelFor(meta, key) {
    const f = (Array.isArray(meta?.fields) ? meta.fields : []).find(x => x && x.key === key);
    const label = f && (f.label || f.name);
    return typeof label === 'string' && label.trim() ? label.trim() : key;
}

/**
 * Een leeg blok — wat er staat als er niets te tonen valt.
 *
 * De reden-code gaat NIET het element in. Hij stond hier als
 * `data-bf-table="<reden>"`, en dat overleeft de sanitizer: DOMPurify laat
 * `data-*` staan (`ALLOW_DATA_ATTR` staat aan, en SANITIZE_HTML_CONFIG in
 * services/webpageSnapshot.js zet hem niet uit). De code kwam dus letterlijk in
 * de opgeslagen bytes terecht en was op /w/<slug> in de bron te lezen — een
 * anonieme bezoeker las 'unavailable' (de auteur mag de tabel niet meer lezen)
 * of 'read-failed' (de databank lag plat) precies uit elkaar, en zag 'empty'
 * verspringen zodra de tabel zijn eerste rij kreeg, want de reconciler
 * herschrijft de snapshot bij elke tabelmutatie.
 *
 * "Leeg" en "onleesbaar" moeten uit elkaar te houden blijven — dat is de reden
 * dat er meerdere codes zijn — maar aan de BEHEERDERSKANT, niet in wat naar
 * buiten gaat. Daarom staat de code nu in het log en is het blok zelf voor
 * elke reden hetzelfde.
 *
 * LET OP het verschil met een INERT blok hieronder. Een leeg blok hoort bij een
 * element dat hier wél had kunnen werken maar niets te tonen had; dat is een
 * toestand van de DATA en die gaat een anonieme lezer niet aan. Een inert blok
 * hoort bij een element dat hier per definitie niet werkt; dat is een
 * eigenschap van de GEPUBLICEERDE KOPIE en die moet de lezer juist wél zien.
 */
function emptyBlock(document, def, reason) {
    const div = document.createElement('div');
    div.setAttribute('class', def.tag);
    log.warn('[WebpageBfTable] empty block:', `${def.tag}:${reason}`);
    return div;
}

// ── de uitklappers die data lezen ─────────────────────────────────────

function renderTable(document, { columns, meta, rows }) {
    const table = document.createElement('table');
    table.setAttribute('class', TABLE.tag);
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const c of columns) {
        const th = document.createElement('th');
        th.textContent = labelFor(meta, c);
        htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        for (const c of columns) {
            const td = document.createElement('td');
            td.textContent = cellText(row ? row[c] : '');
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

/** De `limit` van het element, begrensd; ontbrekend of onleesbaar → het maximum. */
function limitOf(attrs) {
    const raw = parseInt(attrs.limit || '', 10);
    if (!Number.isFinite(raw) || raw <= 0) return PUBLIC_ROWS_MAX;
    return Math.min(raw, PUBLIC_ROWS_MAX);
}

/**
 * De poort, voor elk element dat een gebonden tabel leest.
 *
 * @returns {{binding:object, publicColumns:string[]}|{reason:string}} — precies
 *   één van beide. Een reden betekent: er komt een leeg blok, en waarom.
 */
function gateFor(source, ctx) {
    const binding = ctx.bindings.find(b => b && b.datatableId === source) || null;
    // "We konden de bindingen niet lezen" is iets anders dan "deze tabel is niet
    // gebonden", ook al is het blok in beide gevallen leeg: het eerste is een
    // storing die je wilt zien, het tweede een keuze van de auteur.
    if (!binding) return { reason: ctx.grantsUnreadable ? 'bindings-unreadable' : 'not-bound' };
    // DE POORT. Niet `columns`: wat intern leesbaar is, is niet wat publiek mag.
    const publicColumns = Array.isArray(binding.publicColumns) ? binding.publicColumns : [];
    if (!publicColumns.length) return { reason: 'no-public-columns' };
    if (!ctx.principal || !ctx.principal.userId) {
        return { reason: ctx.principalUnreadable ? 'reader-unreadable' : 'no-reader' };
    }
    return { binding, publicColumns };
}

/**
 * Waarom een lezing mislukte, zonder dat het verschil naar buiten lekt.
 * Geweigerd (graad weg) en onbereikbaar (databank plat) krijgen een ANDERE code
 * — in het LOG, want de bytes zijn voor beide gelijk.
 */
function readFailureReason(err) {
    const reason = (err && err.safe === true) ? 'unavailable' : 'read-failed';
    if (reason === 'read-failed') {
        log.error('[WebpageBfTable] could not read a bound table:', err && err.message);
    }
    return reason;
}

/** Eén `<bf-table>`. Antwoordt altijd met een node — nooit met een uitzondering. */
async function renderTableElement(document, el, ctx) {
    // Attribuutnamen (en de oudere schrijfwijze `datatable`) komen uit het
    // vocabulaire, niet uit een tweede lijst hier.
    const attrs = bfElements.readAttributes(TABLE.tag, el);
    const missing = bfElements.missingAttributes(TABLE.tag, attrs);
    if (missing.length) return emptyBlock(document, TABLE, `no-${missing[0]}`);

    const gate = gateFor(attrs.source, ctx);
    if (gate.reason) return emptyBlock(document, TABLE, gate.reason);

    try {
        const resolved = await datatableRuntime.resolveForPrincipal(attrs.source, ctx.principal, { needed: 'viewer' });
        const out = await datatableRuntime.readRows(resolved, {
            allowColumns: gate.publicColumns,
            limit: limitOf(attrs),
        });
        if (!out.rows.length) return emptyBlock(document, TABLE, 'empty');
        // `out.columns` is de doorsnede met wat de tabel nog heeft, dus een
        // inmiddels verwijderde kolom levert geen lege kolomkop op.
        return renderTable(document, { columns: out.columns, meta: resolved.meta, rows: out.rows });
    } catch (err) {
        return emptyBlock(document, TABLE, readFailureReason(err));
    }
}

/**
 * Eén getal uit een gebonden tabel.
 *
 * Alleen `count` raakt geen enkele kolom aan; de vier andere wél, en die kolom
 * moet daarom zélf publiek zijn. Niet-getallen worden overgeslagen (een lege cel
 * is geen nul), en blijft er dan niets over, dan komt er geen getal in plaats
 * van een 0 die als een echt antwoord leest.
 */
const AGGREGATIONS = Object.freeze({
    count: (rows) => rows.length,
    sum: (rows, numbers) => numbers.reduce((a, b) => a + b, 0),
    avg: (rows, numbers) => numbers.reduce((a, b) => a + b, 0) / numbers.length,
    min: (rows, numbers) => Math.min(...numbers),
    max: (rows, numbers) => Math.max(...numbers),
});

/**
 * Elke aggregatie die het vocabulaire kent, moet hier een uitvoering hebben.
 *
 * Zonder deze toets was `AGGREGATIONS` een TWEEDE lijst naast
 * `STAT_AGGREGATIONS`: een zesde aggregatie in de registry kwam dan door de
 * poort (hij staat immers in `values`), viel hier door de bodem en werd een leeg
 * blok met de code 'no-number' — niet te onderscheiden van "er viel niets op te
 * tellen". Twee heel verschillende dingen, één leeg blok, één misleidend log.
 * Nu is het een startfout, net als de andere twee sloten in dit bestand.
 */
function assertAggregationsAreImplemented(declared = STAT_AGGREGATIONS, implemented = AGGREGATIONS) {
    const names = Object.keys(implemented);
    const missing = declared.filter(a => !names.includes(a));
    const stray = names.filter(a => !declared.includes(a));
    if (!missing.length && !stray.length) return true;
    const parts = [];
    if (missing.length) parts.push(`kent geen uitvoering voor ${missing.join(', ')}`);
    if (stray.length) parts.push(`voert ${stray.join(', ')} uit, en dat kent bf-stat niet`);
    throw new Error(`[WebpageBfTable] de aggregatietabel ${parts.join('; ')}.`);
}
assertAggregationsAreImplemented();

function aggregate(agg, rows, column) {
    const fn = AGGREGATIONS[agg];
    // Kan niet: de poort liet alleen verklaarde aggregaties door en
    // assertAggregationsAreImplemented gooide op require-tijd als er een miste.
    // Maar "onbekende aggregatie" mag nooit hetzelfde antwoord worden als "er
    // viel niets op te tellen".
    if (!fn) return null;
    if (agg === 'count') return fn(rows);
    const numbers = [];
    for (const row of rows) {
        const raw = row ? row[column] : undefined;
        if (raw === null || raw === undefined || raw === '') continue;
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (Number.isFinite(n)) numbers.push(n);
    }
    if (!numbers.length) return null;
    return fn(rows, numbers);
}

/**
 * Het getal als tekst. Bewust NIET `toLocaleString`: de taal van de server is
 * niet de taal van de lezer, en een snapshot die per omgeving anders wordt
 * opgeschreven laat de reconciler bij elke herschrijving andere bytes opleveren.
 */
function formatStatValue(n) {
    if (!Number.isFinite(n)) return '';
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 100) / 100);
}

function renderStat(document, { value, label }) {
    const box = document.createElement('div');
    box.setAttribute('class', STAT.tag);
    const number = document.createElement('span');
    number.setAttribute('class', 'bf-stat-value');
    number.textContent = formatStatValue(value);
    box.appendChild(number);
    if (label) {
        const caption = document.createElement('span');
        caption.setAttribute('class', 'bf-stat-label');
        caption.textContent = cellText(label);
        box.appendChild(caption);
    }
    return box;
}

/** Eén `<bf-stat>`. Zelfde poort als `<bf-table>`, plus de kolom van de som. */
async function renderStatElement(document, el, ctx) {
    const attrs = bfElements.readAttributes(STAT.tag, el);
    const missing = bfElements.missingAttributes(STAT.tag, attrs);
    if (missing.length) return emptyBlock(document, STAT, `no-${missing[0]}`);
    // `effectiveAttributes` vult de verklaarde default in (`agg` → count).
    const eff = bfElements.effectiveAttributes(STAT.tag, attrs);
    // Een aggregatie die het vocabulaire niet kent is geen "dan maar count":
    // dat zou een ander getal opleveren dan er gevraagd is.
    if (!STAT_AGGREGATIONS.includes(eff.agg)) return emptyBlock(document, STAT, 'bad-agg');

    const gate = gateFor(eff.source, ctx);
    if (gate.reason) return emptyBlock(document, STAT, gate.reason);
    // DE POORT, tweede beurt. Een som over een kolom die niet publiek is,
    // publiceert die kolom alsnog — samengevat, maar het is dezelfde data.
    if (eff.agg !== 'count' && !gate.publicColumns.includes(eff.column)) {
        return emptyBlock(document, STAT, 'column-not-public');
    }

    try {
        const resolved = await datatableRuntime.resolveForPrincipal(eff.source, ctx.principal, { needed: 'viewer' });
        const out = await datatableRuntime.readRows(resolved, {
            allowColumns: gate.publicColumns,
            limit: PUBLIC_STAT_ROWS_MAX,
        });
        // Past de tabel niet in één leesbeurt, dan gaat dit getal over een deel
        // van de rijen — en dat is niet te zien aan het getal. Liever niets.
        if (out.hasMore) return emptyBlock(document, STAT, 'too-many-rows');
        // De kolom bestond bij het binden nog wel, maar staat niet meer in de
        // tabel: `out.columns` is de doorsnede. Optellen over `undefined` zou
        // hier een 0 opleveren die als een echt antwoord leest.
        if (eff.agg !== 'count' && !out.columns.includes(eff.column)) {
            return emptyBlock(document, STAT, 'column-gone');
        }
        const value = aggregate(eff.agg, out.rows, eff.column);
        if (value === null) return emptyBlock(document, STAT, 'no-number');
        return renderStat(document, { value, label: eff.label });
    } catch (err) {
        return emptyBlock(document, STAT, readFailureReason(err));
    }
}

/** De uitklappers, op tagnaam. Elke `expand` in VANILLA_HANDLING moet er een hebben. */
const EXPANDERS = Object.freeze({
    [TABLE.tag]: renderTableElement,
    [STAT.tag]: renderStatElement,
});

// ── de elementen die hier niets kunnen, en dat tonen ──────────────────

function moveChildren(el, box) {
    while (el.firstChild) box.appendChild(el.firstChild);
}

function disabledButton(document, label) {
    const button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.textContent = cellText(label);
    return button;
}

/**
 * De VORM van een inert element, per soort.
 *
 * Alles wat de auteur zelf in het element schreef blijft staan — dat is van hem
 * — maar niets ervan mag er nog bedienbaar uitzien. Een lege plek en een levend
 * ogende knop zijn allebei fout; een zichtbaar uitgeschakelde knop met een
 * melding eronder is het antwoord.
 *
 * Nooit een `<form>`: DOMPurify heeft `form` in FORBID_TAGS staan en
 * `KEEP_CONTENT` laat de velden dan los staan — een half formulier zonder knop.
 */
const INERT_BODY = Object.freeze({
    'bf-button': (document, box, el, attrs) => {
        // De tekst IN het element is bij deze soort het label, geen opmaak.
        box.appendChild(disabledButton(document, attrs.label || (el.textContent || '').trim()));
    },
    'bf-form': (document, box, el, attrs) => {
        moveChildren(el, box);
        // Alleen een knop als de auteur er een tekst voor gaf; er is geen
        // Engelse standaardtekst om te verzinnen, en de melding zegt het al.
        if (attrs['submit-label']) box.appendChild(disabledButton(document, attrs['submit-label']));
    },
    'bf-agent': (document, box, el, attrs) => {
        moveChildren(el, box);
        if (attrs.placeholder) {
            const input = document.createElement('input');
            input.setAttribute('type', 'text');
            input.setAttribute('placeholder', cellText(attrs.placeholder));
            box.appendChild(input);
        }
    },
});

/**
 * Een element dat in de vanilla snapshot niets kan doen, ZICHTBAAR uitgeschakeld.
 *
 * De melding is de enige tekst in deze module die de LEZER te zien krijgt, en
 * ze staat daarom niet hier maar in het vocabulaire — dezelfde zin die de
 * publieke brug op een react-share toont.
 */
function inertBlock(document, def, el) {
    const box = document.createElement('div');
    // De tagnaam als CSS-klasse, net als bij een uitgeklapte tabel: de auteur
    // schreef hem zelf, dus hij verklapt niets, en het is de enige haak die zijn
    // eigen stijlblad heeft om dit blok mee te herkennen.
    box.setAttribute('class', `bf-inert ${def.tag}`);
    const attrs = bfElements.readAttributes(def.tag, el);
    const body = INERT_BODY[def.tag];
    if (body) body(document, box, el, attrs);
    else moveChildren(el, box);
    for (const control of box.querySelectorAll(CONTROLS)) control.setAttribute('disabled', '');

    const note = document.createElement('p');
    note.setAttribute('class', 'bf-inert-notice');
    note.setAttribute('role', 'note');
    // textContent, nooit innerHTML: dit is onze eigen tekst en dat blijft zo.
    note.textContent = def.surfaces.vanillaSnapshot.notice;
    box.appendChild(note);
    return box;
}

/**
 * Wat de REGISTRY over deze plek zegt → wat deze module dan moet doen.
 *
 * De registry beslist wat er van een element overblijft; deze module voert dat
 * uit. Daarom is dit een vertaaltabel van twee ingangen en geen tweede mening:
 * "hier statisch" betekent uitklappen, "hier inert" betekent een zichtbaar
 * uitgeschakeld blok. De twee andere toestanden (`live`, `refused`) gaan over
 * andere plekken; komt er hier ooit een te staan, dan is dat een startfout en
 * geen stilte.
 */
const REQUIRED_HANDLING = Object.freeze({ static: 'expand', inert: 'inert' });

/**
 * De handelingstabel moet WAAR TE MAKEN zijn, niet alleen volledig.
 *
 * Draait op require-tijd, om dezelfde reden als `assertCoversVocabulary`. Drie
 * fouten, alle drie onzichtbaar in de uitvoer en hier alle drie een startfout:
 * een handeling die de registry tegenspreekt (het element wordt dan niet
 * uitgeklapt en DOMPurify pakt hem zwijgend uit), een `expand` zonder
 * uitklapper, en een `inert` zonder melding.
 */
function assertHandlingIsWorkable(handling = VANILLA_HANDLING, expanders = EXPANDERS, bodies = INERT_BODY) {
    const problems = [];
    for (const [tag, verdict] of Object.entries(handling)) {
        const def = bfElements.getBfElement(tag);
        if (!def) continue; // dekking is al de zorg van assertCoversVocabulary
        const declared = def.surfaces.vanillaSnapshot.state;
        const required = REQUIRED_HANDLING[declared];
        if (!required) {
            problems.push(`de registry zegt "${declared}" over ${tag} op deze plek, en daar heeft deze module `
                + 'geen handeling voor');
        } else if (verdict !== required) {
            problems.push(`${tag} staat op "${verdict}", maar de registry zegt "${declared}" over deze plek — `
                + `dan hoort hier "${required}" te staan`);
        }
        if (verdict === 'expand' && !expanders[tag]) {
            problems.push(`${tag} staat op "expand", maar er is geen uitklapper voor`);
        }
        if (verdict === 'inert' && !def.surfaces.vanillaSnapshot.notice) {
            problems.push(`${tag} staat op "inert", maar draagt geen melding — dan is de inertie net zo stil `
                + 'als wanneer DOMPurify hem had uitgepakt');
        }
        // Spiegelbeeld van de expand-kant hierboven. Zonder deze regel was
        // INERT_BODY een TWEEDE, ongecontroleerde lijst: een nieuw inert element
        // kreeg dan wél zijn melding maar geen VORM — geen uitgeschakelde knop,
        // geen uitgeschakeld veld — en niets dat zei dat die er hoorde te zijn.
        if (verdict === 'inert' && !bodies[tag]) {
            problems.push(`${tag} staat op "inert", maar INERT_BODY zegt niets over zijn vorm; dan blijft er `
                + 'alleen de melding staan en is niet te zien dat hier een knop of een veld hoorde');
        }
    }
    for (const tag of Object.keys(bodies)) {
        if (handling[tag] !== 'inert') {
            problems.push(`INERT_BODY beschrijft de vorm van ${tag}, maar die staat niet op "inert"`);
        }
    }
    if (!problems.length) return true;
    throw new Error(`[WebpageBfTable] VANILLA_HANDLING is niet waar te maken: ${problems.join('; ')}.`);
}
assertHandlingIsWorkable();

/**
 * `<bf-table … />` sluiten, want HTML doet dat niet.
 *
 * Een custom element KAN in HTML niet zelfsluitend zijn: de parser leest
 * `<bf-table source="t"/>` als een gewone openingstag en stopt de HELE rest van
 * het document erin als kinderen. `el.replaceWith(...)` gooit die kinderen
 * daarna weg — dus alles wat na het element stond, verdween uit de gepubliceerde
 * pagina zonder één waarschuwing. Bij `<bf-form/>` gebeurt het omgekeerde en net
 * zo fout: de hele pagina wordt het inerte blok in getrokken en elk formulier-
 * element erin uitgeschakeld.
 *
 * `/>` is precies de gewoonte die een taalmodel meebrengt uit JSX, en de
 * bouwer-prompt vertelt het model sinds W4 actief om deze elementen te
 * schrijven. Daarom herstellen we de schrijfwijze in plaats van erop te
 * vertrouwen.
 *
 * Alleen `bf-*`-openingstags, en de scanner respecteert aanhalingstekens, zodat
 * `label="a/b"` geen valse sluiting oplevert.
 */
function closeSelfClosingBfTags(src) {
    const re = new RegExp(bfElements.BF_TAG_SCAN.source, 'gi');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
        const tag = String(m[1] || '').toLowerCase();
        // Alleen elementen die we kennen: een onbekende tag laten we onaangeraakt
        // (we kunnen hem toch niet eerlijk vervangen) en hij wordt apart gemeld.
        if (!bfElements.isKnownBfTag(tag)) continue;
        let i = m.index + m[0].length;
        let quote = null;
        let selfClosing = false;
        for (; i < src.length; i++) {
            const ch = src[i];
            if (quote) { if (ch === quote) quote = null; continue; }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '>') { selfClosing = src[i - 1] === '/'; break; }
        }
        if (i >= src.length) break;
        if (!selfClosing) { re.lastIndex = i + 1; continue; }
        // `<bf-x … />` → `<bf-x …></bf-x>`; de schuine streep valt weg.
        out += src.slice(last, i - 1) + `></${tag}>`;
        last = i + 1;
        re.lastIndex = i + 1;
    }
    return last ? out + src.slice(last) : src;
}

/**
 * Vervang elk bekend `bf-*`-element in `html` door statische HTML.
 *
 * @param {string} html         de rauwe HTML van de pagina (vóór DOMPurify)
 * @param {object} args
 * @param {string} args.webpageId
 * @param {string} args.ownerId  de EIGENAAR van de pagina; als hem wordt gelezen
 * @returns {Promise<string>} dezelfde HTML met de elementen uitgeklapt
 */
async function expandBfElements(html, { webpageId, ownerId } = {}) {
    const src = typeof html === 'string' ? html : '';

    // Onbekende `bf-*`-elementen HOORBAAR maken. DOMPurify pakt een onbekend
    // element zonder één waarschuwing uit (KEEP_CONTENT: true, ADD_TAGS kent
    // alleen `iframe`), dus `<bf-widget x="1">Klik</bf-widget>` wordt letterlijk
    // `Klik` — tag weg, attributen weg, geen spoor. Wie wil weten dát er iets
    // onbekends stond, moet het hiervóór tellen. Aanraken doen we ze niet: wat
    // we niet kennen, kunnen we ook niet eerlijk vervangen.
    const scan = bfElements.scanBfTags(src);
    for (const tag of scan.unknown) {
        log.warn('[WebpageBfTable] unknown bf-* element in a published page, it will be stripped silently:', tag);
    }

    // Goedkope uitweg: niets van ons, geen JSDOM, geen grant-lezing.
    if (!scan.known.length) return src;

    const dom = new JSDOM(closeSelfClosingBfTags(src));
    const { document } = dom.window;
    const selector = scan.known.join(',');
    // `<template>` telt mee. `querySelectorAll` kijkt NIET in `template.content`
    // (dat is een eigen document-fragment), dus een element daarin werd hier
    // overgeslagen en verdween daarna spoorloos in DOMPurify: het enige geval
    // waarin een BEKEND element net zo stil weg was als een onbekend.
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
        for (const tpl of roots[i].querySelectorAll('template')) roots.push(tpl.content);
    }
    const elements = roots.flatMap(root => [...root.querySelectorAll(selector)]);
    if (!elements.length) return src;

    // De grants en de principal worden pas gelezen als er echt een element is
    // dat data nodig heeft: een pagina met alleen een `bf-button` hoort geen
    // enkele tabelbinding op te vragen.
    const ctx = {
        webpageId, ownerId, loaded: false, bindings: [], principal: null,
        grantsUnreadable: false, principalUnreadable: false,
    };

    for (const el of elements) {
        const def = bfElements.getBfElement(el.tagName);
        // Kan niet: querySelectorAll draaide op precies deze lijst. Maar een
        // ontbrekende definitie mag nooit een stille verdwijning worden.
        if (!def) continue;
        // De handelingstabel IS de dispatch, niet een verklaring ernaast: zo kan
        // er geen element zijn dat op "inert" staat en toch wordt uitgeklapt
        // omdat er toevallig een uitklapper voor bestaat.
        const expander = VANILLA_HANDLING[def.tag] === 'expand' ? EXPANDERS[def.tag] : null;
        if (expander) {
            await loadDataContext(ctx);
            el.replaceWith(await expander(document, el, ctx));
        } else {
            el.replaceWith(inertBlock(document, def, el));
        }
    }
    return dom.serialize();
}

/** De grants en de lezer, één keer per pagina. Faalt stil naar "niets gebonden". */
async function loadDataContext(ctx) {
    if (ctx.loaded) return ctx;
    ctx.loaded = true;
    let grants = null;
    try { grants = await bridgeGrants.getBridgeGrants(ctx.webpageId); }
    catch (err) {
        // NIET stil naar "niets gebonden". De reconciler herschrijft de snapshot
        // bij ELKE tabelmutatie, dus één databankhikje hier zou de pagina
        // opnieuw publiceren met een lege tabel, en het enige spoor zou
        // 'not-bound' zeggen — niet te onderscheiden van een pagina die nooit
        // een binding had. "Leeg" en "onleesbaar" blijven uit elkaar, aan de
        // BEHEERDERSKANT; de bytes die naar buiten gaan zijn voor beide gelijk.
        log.error('[WebpageBfTable] could not read the page bindings:', err && err.message);
        ctx.grantsUnreadable = true;
        grants = null;
    }
    ctx.bindings = (grants && Array.isArray(grants.tables)) ? grants.tables : [];
    // Eén principal voor alle elementen op de pagina; hij verandert niet tussen
    // twee elementen door.
    try { ctx.principal = await datatableAccess.resolveDatatablePrincipalForUser(ctx.ownerId); }
    catch (err) {
        log.error('[WebpageBfTable] could not resolve the reader:', err && err.message);
        ctx.principalUnreadable = true;
        ctx.principal = null;
    }
    return ctx;
}

module.exports = {
    expandBfElements,
    PUBLIC_ROWS_MAX,
    PUBLIC_STAT_ROWS_MAX,
    // De beslissing van DEZE plek over het hele vocabulaire; de drifttest legt
    // hem naast core/webpages/bfElements.js.
    VANILLA_HANDLING,
    // test-only
    _closeSelfClosingBfTags: closeSelfClosingBfTags,
    _assertAggregationsAreImplemented: assertAggregationsAreImplemented,
    _cellText: cellText,
    _aggregate: aggregate,
    _assertHandlingIsWorkable: assertHandlingIsWorkable,
};
