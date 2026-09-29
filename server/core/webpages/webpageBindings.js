/**
 * webpageBindings — wat de pagina ZELF doet.
 *
 * De kolom "Laat gebeuren" van "Data & koppelingen" beantwoordt een andere
 * vraag dan de kaarten ernaast. Die gaan over wat de pagina LEEST; dit gaat
 * over wat ze LAAT GEBEUREN. Tot het `bf-*`-vocabulaire bestaat (W4) is dat
 * oppervlak nog leeg — knoppen, formulieren en het Agent-blok krijgen daar hun
 * elementen — en toont de kolom de bestaande brug-grants plus dit ene stuk:
 *
 *   "DOET IETS IN EIGEN CODE" — een statische scan van ALLE eigen tekstbestanden
 *   van de pagina op `fetch(` en `XMLHttpRequest` naar een host die niet van
 *   deze installatie is. Zo'n oproep gaat om de routines heen: hij staat niet in
 *   Runs, kent geen goedkeuring en niemand ziet hem terug. De kaart biedt
 *   daarom "Maak er een automation van" aan, die een `http_request`-routine met
 *   diezelfde URL scaffoldt.
 *
 * ── DE TWEEDE LEZER: DE MARKERINGEN IN DE CODE-TAB ──────────────────
 *
 * Sinds W4 leest deze module dezelfde bestanden nóg een keer, met een andere
 * vraag: op WELKE REGEL staat een `bf-*`-element? Dat is `scanBfElements`, en
 * de Code-tab tekent er zijn Monaco-markeringen mee.
 *
 * Waarom hier en niet in de frontend: een tweede regex in de client zou een
 * tweede lezing van hetzelfde vocabulaire zijn — precies de drift die
 * core/webpages/bfElements.js bestaat om te voorkomen. De namen én het patroon
 * waarmee ze in markup worden herkend komen daarom uit de registry; dit bestand
 * schrijft geen enkele tagnaam op.
 *
 * Dezelfde drie standen gelden: onleesbare bestanden geven `scanned:false`, en
 * de Code-tab MOET dat verschil tonen. Een pagina zonder markeringen mag er
 * niet uitzien als een pagina zonder koppelingen.
 *
 * ── DE DERDE LEZER: DE USAGE-INDEX ──────────────────────────────────
 *
 * Uit diezelfde markeringen komt `collectUses`: WELKE tabel, WELKE routine,
 * WELKE agent hangt er via een element aan deze pagina? Dat is wat de
 * middenkolom toont en wat "Wordt gebruikt door" straks omdraait.
 *
 * De families komen uit de registry (`binding.kind`), niet uit een lijst hier —
 * dit bestand schrijft geen tagnaam en geen familienaam op. En de index telt
 * alleen wat hij ECHT kan aanwijzen; alles daaromheen komt terug als
 * `unresolved`, met de reden erbij:
 *
 *   built-at-runtime      het adres stond er als uitdrukking (`source={id}` in
 *                         JSX, `${…}` in een template). De pagina bouwt het
 *                         terwijl ze draait, dus hier valt het niet te lezen;
 *   no-target             een verplicht attribuut ontbreekt;
 *   page-binding-unknown  het element valt terug op de binding van de PAGINA,
 *                         en die is er niet;
 *   page-binding-unreadable  idem, maar de grants waren niet te LEZEN. Dat is
 *                         een storing en geen keuze van de auteur, dus die twee
 *                         mogen niet op dezelfde reden uitkomen;
 *   unknown-fallback      het vocabulaire kent een terugval waarvoor deze
 *                         module geen antwoord heeft. Dan is er iets aan de
 *                         registry toegevoegd zonder het hier te beantwoorden —
 *                         en dat mag geen element stil uit de index laten
 *                         vallen.
 *
 * Een verzonnen id is het ENIGE antwoord dat we niet mogen geven: `{id}` als
 * datatable-id ziet er in een usage-index precies zo echt uit als `tbl_1`, en
 * hoort daarna nergens meer bij.
 *
 * ── "ALLE BESTANDEN" IS NIET "DE DRIE SLOTS" ────────────────────────
 *
 * De drie slots (`index.html` / `style.css` / `script.js`) zijn NIET het hele
 * project, en voor de meeste pagina's zijn ze niet eens de hoofdmoot. Een
 * react-mui-project — en dat is sinds `integrations/webpageFramework.js`
 * (`DEFAULT_NEW_FRAMEWORK`) wat élke NIEUWE pagina wordt — schrijft zijn hele
 * app als EXTRA bestanden onder `src/` (`src/main.jsx`, `src/App.jsx`, …); de
 * html wordt bij het renderen gegenereerd en het js-slot blijft leeg. Ook een
 * vanilla-project mag `modules/state.js` of `about.html` naast de slots zetten.
 *
 * Wie hier alleen `readAllSlots` leest, leest dus drie lege strings en meldt
 * doodleuk "niets gevonden" over code die hij nooit heeft gezien. Daarom haalt
 * `readPageCode` de tekst-extra's erbij, en dragen ze in de uitslag hun eigen
 * pad als `source`, zodat de auteur weet WELK bestand hij moet openen.
 *
 * ── DIT IS EEN LEESHULP, GEEN BEVEILIGING ───────────────────────────
 *
 * Lees dat letterlijk. De scan leest tekst; hij voert niets uit en begrijpt
 * geen JavaScript. Alles hieronder ontsnapt eraan:
 *
 *   - `window[atob('ZmV0Y2g=')](url)`, `const f = fetch; f(url)`, een oproep uit
 *     een `<script src>` van elders, `import()`, `<img src>`, `<form action>`,
 *     `navigator.sendBeacon`, een WebSocket;
 *   - een URL die uit een variabele komt (`fetch(endpoint)`);
 *   - een regex-literal die de mini-parser hieronder als string leest;
 *   - een extra bestand dat de opslag als BINAIR kent (`isText` false): daar
 *     valt geen tekst uit te lezen, dus wat erin staat blijft buiten beeld.
 *
 * Daarom mag geen enkele consument van deze module "deze pagina doet niets"
 * zeggen. De uitkomst kent drie standen en die MOETEN verschillend blijven:
 *
 *   scanned:false          de bestanden waren niet te lezen — onbekend;
 *   unresolved > 0         er is iets gevonden dat niet te herleiden was;
 *   calls: [] + scanned    er is gekeken en niets gevonden — wat nog steeds
 *                          niet hetzelfde is als "er gebeurt niets".
 *
 * Wat de parser kwijtraakt komt terug als `unresolved`, niet als stilte: het
 * aantal `fetch(` / `new XMLHttpRequest` in de RUWE tekst wordt vergeleken met
 * wat er in de gemaskeerde tekst is overgebleven, en het verschil wordt
 * gerapporteerd als "niet te controleren". Dat telt een uitgecommentarieerde
 * `fetch(` mee als onbekend — een hinderlijke maar veilige kant op: de andere
 * kant is een echte oproep die de scan stil laat verdwijnen.
 *
 * ── WAT "VAN ONS" IS ────────────────────────────────────────────────
 *
 * Alleen een relatieve URL en de expliciet geconfigureerde eigen host tellen
 * als intern. Elke andere host is extern, óók als hij van Bee Flow zou kunnen
 * zijn: een valse waarschuwing is hinderlijk, een verzwegen uitgaande oproep is
 * een gat. Er staat met opzet geen `beeflow.nl` hardgecodeerd in de lijst — op
 * een self-hosted installatie is dat wél een derde partij.
 */

'use strict';

const bfElements = require('./bfElements');
const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const storageStore = require('../../stores/storageStore');
const webpageStore = require('../../stores/webpageStore');

/** Hoeveel externe oproepen we hoogstens uitschrijven; de rest wordt geteld. */
const MAX_REPORTED_CALLS = 20;

/**
 * Hoeveel gemarkeerde regels we hoogstens uitschrijven.
 *
 * Ruimer dan MAX_REPORTED_CALLS omdat dit een ANDERE consument heeft: de
 * Code-tab tekent er markeringen mee in de editor, en een pagina die er meer
 * heeft dan dit krijgt een deel van zijn regels niet gemarkeerd. Wat er afvalt
 * wordt geteld (`truncated`), zodat de legenda het kan zeggen in plaats van
 * stil minder te tonen.
 */
const MAX_REPORTED_MARKS = 300;

/** Hoever we voorbij een `<bf-…` naar attributen zoeken. */
const MAX_OPEN_TAG_LENGTH = 4096;

/** Attributen uit de ruwe tekst van één openingstag. */
const RE_ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

/**
 * Een waarde die de pagina TER PLEKKE bouwt: `source={id}` (JSX) of een
 * `${…}` in een template-literal. Er staat wél iets, maar niet iets dat hier te
 * lezen valt.
 *
 * Dit onderscheid moet bestaan omdat het alternatief erger is dan stilte: zonder
 * deze toets belandt de tekst `{id}` als DATATABLE-ID in de usage-index, waar ze
 * er precies zo echt uitziet als `tbl_1` en nooit meer bij een tabel hoort.
 * "Niet te lezen" is een antwoord; een verzonnen id is dat niet.
 *
 * De toets is BEGINT-MET-`{`, niet begint-en-eindigt: `run={`auto_${n}`}` levert
 * bij het uitlezen van de tag maar één teken op (de attribuutlezer stopt bij het
 * backtick), en juist zo'n half gelezen waarde is degene die anders als id
 * doorglipt. Een echt id begint nooit met een accolade.
 */
const RE_EXPRESSION_VALUE = /^\{|\$\{/;

function isExpressionValue(value) {
    return typeof value === 'string' && RE_EXPRESSION_VALUE.test(value.trim());
}

/** Schema's die geen netwerkoproep naar een vreemde host zijn. */
const NON_NETWORK_SCHEMES = /^(data|blob|javascript|mailto|tel|about):/i;

/** Extra bestanden die als markup worden gelezen: alleen hun inline scripts. */
const MARKUP_FILE = /\.(html?|svg|xml)$/i;

/** Methodenamen die een `.open(` tot een XHR-oproep maken. */
const XHR_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Plaatshouder rond het indexnummer van een stringliteral in de gemaskeerde tekst. */
const MARK = '\u0001';

const RE_FETCH = /\bfetch\s*\(/g;
const RE_NEW_XHR = /\bnew\s+XMLHttpRequest\b/g;
const RE_LITERAL_AFTER_PAREN = new RegExp(`^\\s*${MARK}(\\d+)${MARK}`);
const RE_XHR_OPEN = new RegExp(`\\.open\\s*\\(\\s*${MARK}(\\d+)${MARK}\\s*,\\s*${MARK}(\\d+)${MARK}`, 'g');

/**
 * De host van deze installatie, uit dezelfde env-variabelen als de
 * share-URL-bouwer (`services/webpageSnapshot.js`). Geen default: zonder
 * configuratie is er geen host waarvan we ZEKER weten dat hij van ons is, en
 * onbekend hoort hier te versmallen naar "extern".
 */
function ownHosts() {
    const hosts = new Set();
    for (const raw of [process.env.PUBLIC_SHARE_BASE_URL, process.env.PUBLIC_APP_URL]) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        try { hosts.add(new URL(raw.trim()).host.toLowerCase()); } catch { /* onbruikbare env → geen host */ }
    }
    return hosts;
}

/**
 * De code van de pagina, met een EXPLICIETE leesbaarheidsvlag.
 *
 * `webpageStore.readAllSlots` geeft lege strings terug als de objectopslag niet
 * beschikbaar is — niet te onderscheiden van een pagina zonder script. Daarom
 * wordt `storageStore.isAvailable()` hier apart gevraagd: zonder opslag is het
 * antwoord "onbekend", nooit "leeg".
 *
 * Dezelfde regel geldt voor de extra bestanden (zie de kop): lukt het opsommen
 * of het lezen daarvan niet, dan is de HELE uitslag onleesbaar. Een pagina
 * waarvan we de helft van de bestanden niet konden ophalen mag geen "niets
 * gevonden" opleveren — onbekend versmalt.
 *
 * `css` gaat mee sinds W4. De oproepscan doet er niets mee, maar de
 * elementscan moet ELK tekstbestand dat de editor toont hebben gezien: een slot
 * dat niet wordt gelezen kan geen markering opleveren, en dat is niet te
 * onderscheiden van "hier staat niets".
 *
 * @returns {{readable:boolean, html:string, css:string, js:string, extras:Array<{path:string,text:string}>}}
 */
async function readPageCode(userId, webpageId) {
    const unreadable = { readable: false, html: '', css: '', js: '', extras: [] };
    try {
        if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) return unreadable;
    } catch { return unreadable; }
    let slots = null;
    try { slots = await webpageStore.readAllSlots(userId, webpageId); }
    catch { return unreadable; }
    if (!slots || typeof slots !== 'object') return unreadable;

    const extras = [];
    try {
        const metas = await webpageStore.listExtraFiles(webpageId);
        for (const meta of (Array.isArray(metas) ? metas : [])) {
            if (!meta || !meta.path) continue;
            // Binaire extra's (plaatjes, fonts) zijn geen scriptbron; ze staan
            // als blinde vlek in de kop.
            if (!meta.isText) continue;
            const res = await webpageStore.readExtraFile({ webpageId, userId, path: meta.path });
            if (!res || typeof res.text !== 'string') return unreadable;
            extras.push({ path: String(meta.path), text: res.text });
        }
    } catch { return unreadable; }

    return {
        readable: true,
        html: String(slots.html || ''),
        css: String(slots.css || ''),
        js: String(slots.js || ''),
        extras,
    };
}

// ── mini-parser ───────────────────────────────────────────────────────

/**
 * Vervang commentaar en stringliteralen door plaatshouders, zodat een `//` of
 * een quote IN een URL de scan niet in de war stuurt.
 *
 * Regelnummers blijven kloppen: commentaar wordt spatie-voor-spatie vervangen
 * met behoud van newlines, en een meerregelige template krijgt zijn newlines
 * achter de plaatshouder aan. Kolommen schuiven wél op — die gebruiken we niet.
 *
 * Regex-literalen worden NIET herkend (`/['"]/` wordt als stringstart gelezen).
 * Dat is de bekende blinde vlek; het vangnet in `scanSource` maakt er
 * `unresolved` van in plaats van stilte.
 */
function maskCode(text) {
    const literals = [];
    let masked = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (c === '/' && c2 === '/') {
            let j = i + 2;
            while (j < n && text[j] !== '\n') j++;
            masked += ' '.repeat(j - i);
            i = j;
            continue;
        }
        if (c === '/' && c2 === '*') {
            let j = i + 2;
            while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
            j = Math.min(n, j + 2);
            masked += text.slice(i, j).replace(/[^\n]/g, ' ');
            i = j;
            continue;
        }
        if (c === '"' || c === '\'' || c === '`') {
            const quote = c;
            let j = i + 1;
            let value = '';
            let hasSubstitution = false;
            while (j < n) {
                const d = text[j];
                if (d === '\\') { value += text[j + 1] === undefined ? '' : text[j + 1]; j += 2; continue; }
                if (d === quote) { j++; break; }
                // Een niet-afgesloten gewone string loopt niet door over een
                // regeleinde heen — anders slokt één losse quote de rest op.
                if (quote !== '`' && d === '\n') break;
                if (quote === '`' && d === '$' && text[j + 1] === '{') { hasSubstitution = true; value += '${'; j += 2; continue; }
                value += d;
                j++;
            }
            const raw = text.slice(i, j);
            literals.push({ value, template: quote === '`', hasSubstitution });
            masked += `${MARK}${literals.length - 1}${MARK}` + '\n'.repeat((raw.match(/\n/g) || []).length);
            i = j;
            continue;
        }
        masked += c;
        i++;
    }
    return { masked, literals };
}

/**
 * Alleen COMMENTAAR wegpoetsen, teken voor teken, met behoud van lengte.
 *
 * `maskCode` hierboven kan dit niet doen: die maskeert óók stringliteralen, en
 * juist een string moet blijven staan — `el.innerHTML = '<bf-button run="a1">'`
 * is een echt element dat de pagina neerzet. Andersom is uitgecommentarieerde
 * code géén koppeling: de auteur zag een gemarkeerde regel met een adres erbij
 * op code die uit staat, en de usage-index beweerde dat de pagina die tabel
 * gebruikt.
 *
 * Lengte én regeleindes blijven gelijk, zodat elke index in de uitvoer nog
 * precies naar dezelfde plek in de invoer wijst — de markeringen dragen
 * regelnummers, dus dat is niet onderhandelbaar.
 *
 * @param {string} text
 * @param {'html'|'css'|'js'|null} kind  taal; iets anders maskeert niets, want
 *   raden wat commentaar is in een onbekend formaat kan alleen maar te veel
 *   wegpoetsen — en een element te weinig tellen is erger dan er een te veel.
 */
function maskComments(text, kind) {
    const src = String(text || '');
    if (!src || !kind) return src;
    const blank = (from, to) => src.slice(from, to).replace(/[^\n]/g, ' ');
    let out = '';
    let i = 0;
    const n = src.length;

    if (kind === 'html') {
        while (i < n) {
            const start = src.indexOf('<!--', i);
            if (start === -1) { out += src.slice(i); break; }
            out += src.slice(i, start);
            let end = src.indexOf('-->', start + 4);
            end = end === -1 ? n : end + 3;
            out += blank(start, end);
            i = end;
        }
        return out;
    }

    // css en js delen `/* … */`; js heeft `//` erbij en moet strings ontzien,
    // anders knipt een `//` in "https://…" de rest van de regel weg.
    const stringAware = kind === 'js';
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        if (c === '/' && c2 === '*') {
            let j = src.indexOf('*/', i + 2);
            j = j === -1 ? n : j + 2;
            out += blank(i, j);
            i = j;
            continue;
        }
        if (stringAware && c === '/' && c2 === '/') {
            let j = i + 2;
            while (j < n && src[j] !== '\n') j++;
            out += blank(i, j);
            i = j;
            continue;
        }
        if (stringAware && (c === '"' || c === "'" || c === '`')) {
            const quote = c;
            let j = i + 1;
            while (j < n) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (d === quote) { j++; break; }
                if (quote !== '`' && d === '\n') break;
                j++;
            }
            out += src.slice(i, j);
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** De taal van een bestand, voor `maskComments`. Onbekend → niet maskeren. */
function commentKindOf(source, slot) {
    if (slot === 'html' || slot === 'css' || slot === 'js') return slot;
    const name = String(source || '').toLowerCase();
    if (/\.(html?|xhtml)$/.test(name)) return 'html';
    if (/\.css$/.test(name)) return 'css';
    if (/\.(m?jsx?|tsx?)$/.test(name)) return 'js';
    return null;
}

/** 1-gebaseerd regelnummer van een index in de gemaskeerde tekst. */
function lineAt(masked, index) {
    let line = 1;
    const upto = Math.min(index, masked.length);
    for (let i = 0; i < upto; i++) if (masked[i] === '\n') line++;
    return line;
}

/** Het deel van een literal dat vaststaat: alles vóór de eerste `${`. */
function fixedPrefixOf(literal) {
    const raw = String(literal.value || '');
    if (!literal.hasSubstitution) return { text: raw.trim(), dynamic: false };
    const cut = raw.indexOf('${');
    return { text: (cut === -1 ? raw : raw.slice(0, cut)).trim(), dynamic: true };
}

/**
 * Waar gaat deze URL heen?
 *
 * @returns {{verdict:'internal'|'external'|'unknown', host?:string}}
 *   'unknown' betekent "niet vast te stellen" en telt als `unresolved` — nooit
 *   als intern, want dan zou de oproep uit beeld verdwijnen.
 */
function classifyUrl(prefix, dynamic, hosts) {
    const raw = String(prefix || '');
    if (!raw) return { verdict: 'unknown' };
    if (NON_NETWORK_SCHEMES.test(raw)) return { verdict: 'internal' };
    let host = null;
    if (/^https?:\/\//i.test(raw)) {
        try { host = new URL(raw).host.toLowerCase(); } catch { return { verdict: 'unknown' }; }
    } else if (raw.startsWith('//')) {
        try { host = new URL(`https:${raw}`).host.toLowerCase(); } catch { return { verdict: 'unknown' }; }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        // Een schema dat we niet kennen (ws:, chrome-extension:, …).
        return { verdict: 'unknown' };
    } else {
        // Relatief. Alleen een prefix die de oorsprong al vastlegt is zeker
        // intern; `${base}/x` (lege prefix) of `api${x}` niet.
        if (raw.startsWith('/') && !raw.startsWith('//')) return { verdict: 'internal' };
        if (raw.startsWith('./') || raw.startsWith('../')) return { verdict: 'internal' };
        return dynamic ? { verdict: 'unknown' } : { verdict: 'internal' };
    }
    if (!host) return { verdict: 'unknown' };
    return hosts.has(host) ? { verdict: 'internal' } : { verdict: 'external', host };
}

/** Aantal treffers van `re` in `text` (re moet /g hebben). */
function countRaw(text, re) {
    return (String(text).match(re) || []).length;
}

/**
 * Scan één fragment.
 *
 * @param {string} text
 * @param {string} source        'script.js' | 'index.html'
 * @param {number} lineOffset    regels die vóór dit fragment stonden
 * @param {Set<string>} hosts    eigen hosts
 */
function scanSource(text, source, lineOffset, hosts) {
    const found = [];
    let unresolved = 0;
    let internal = 0;
    if (!text) return { found, unresolved, internal };

    const { masked, literals } = maskCode(text);

    const push = (kind, method, literalIndex, at) => {
        const literal = literals[literalIndex];
        if (!literal) { unresolved++; return; }
        const { text: prefix, dynamic } = fixedPrefixOf(literal);
        const verdict = classifyUrl(prefix, dynamic, hosts);
        if (verdict.verdict === 'internal') { internal++; return; }
        if (verdict.verdict === 'unknown') { unresolved++; return; }
        found.push({
            kind,
            method,
            // Wat er staat, niet wat wij ervan maken: de auteur moet zijn eigen
            // regel herkennen. Een template houdt een beletselteken als staart.
            url: dynamic ? `${prefix}…` : prefix,
            // Het deel dat ECHT vaststaat, zonder beletselteken: dat is wat er
            // in een gescaffolde routine mag belanden. `dynamic` zegt erbij dat
            // de pagina de rest van het adres ter plekke bouwde, zodat niemand
            // die routine voor compleet aanziet.
            urlPrefix: prefix,
            dynamic,
            host: verdict.host,
            source,
            line: lineOffset + lineAt(masked, at),
        });
    };

    // fetch(<literal>) — alles wat niet direct met een literal begint is een
    // uitdrukking en dus niet te herleiden. De methode blijft null: `{method:
    // 'POST'}` staat in het tweede argument en wordt hier NIET geraden.
    const fetchRe = new RegExp(RE_FETCH.source, 'g');
    let m;
    let fetchSeen = 0;
    while ((m = fetchRe.exec(masked)) !== null) {
        fetchSeen++;
        const lit = RE_LITERAL_AFTER_PAREN.exec(masked.slice(m.index + m[0].length));
        if (lit) push('fetch', null, Number(lit[1]), m.index);
        else unresolved++;
    }

    // XMLHttpRequest: alleen `.open('METHOD', '<url>')` levert een adres op.
    // Elke `new XMLHttpRequest` waar geen zo'n paar bij hoort telt als niet te
    // herleiden — anders zou een XHR met een variabele URL verdwijnen.
    const xhrInstances = countRaw(masked, RE_NEW_XHR);
    let xhrResolved = 0;
    if (/\bXMLHttpRequest\b/.test(masked)) {
        const openRe = new RegExp(RE_XHR_OPEN.source, 'g');
        let o;
        while ((o = openRe.exec(masked)) !== null) {
            const method = String(literals[Number(o[1])]?.value || '').trim().toUpperCase();
            if (!XHR_METHODS.has(method)) continue;
            xhrResolved++;
            push('xhr', method, Number(o[2]), o.index);
        }
    }
    if (xhrInstances > xhrResolved) unresolved += xhrInstances - xhrResolved;

    // Vangnet: staat er in de RUWE tekst meer dan de parser als code heeft
    // gezien, dan zat het in commentaar, in een string, of in iets dat de
    // parser verkeerd las. Dat verschil is niet te onderscheiden, dus het gaat
    // naar `unresolved` — "niet gecontroleerd", nooit "niets gevonden".
    unresolved += Math.max(0, countRaw(text, RE_FETCH) - fetchSeen);
    unresolved += Math.max(0, countRaw(text, RE_NEW_XHR) - xhrInstances);

    return { found, unresolved, internal };
}

/** De inline `<script>`-blokken uit index.html, met hun regeloffset. */
function inlineScripts(html) {
    const out = [];
    if (!html) return out;
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        // Een `<script src=…>` heeft geen inhoud die wij kunnen lezen; zijn
        // gedrag valt buiten de scan (en dat zegt de kaart erbij).
        if (/\bsrc\s*=/i.test(m[1] || '')) continue;
        const before = html.slice(0, m.index + m[0].indexOf('>') + 1);
        out.push({ text: m[2] || '', lineOffset: (before.match(/\n/g) || []).length });
    }
    return out;
}

/**
 * De scan zelf. Puur: geen opslag, geen databank — geef `{html, js}` mee.
 *
 * @returns {{calls:Array, externalCount:number, unresolved:number, internal:number}}
 */
function scanOutboundCalls({ html = '', js = '', extras = [] } = {}) {
    const hosts = ownHosts();
    const results = [scanSource(js, 'script.js', 0, hosts)];
    for (const frag of inlineScripts(html)) {
        results.push(scanSource(frag.text, 'index.html', frag.lineOffset, hosts));
    }
    // Extra bestanden dragen hun eigen pad als bron. Een markup-bestand levert
    // alleen zijn inline `<script>`-blokken op — net als `index.html` hierboven
    // en met dezelfde grens; al het andere tekstbestand wordt als scriptbron
    // gelezen, ook `.json` of `.css`: staat er een `fetch(` in die de parser
    // niet kan thuisbrengen, dan is `unresolved` het juiste antwoord en stilte
    // het verkeerde.
    for (const file of (Array.isArray(extras) ? extras : [])) {
        if (!file || typeof file.text !== 'string') continue;
        const source = String(file.path || 'extra file');
        if (MARKUP_FILE.test(source)) {
            for (const frag of inlineScripts(file.text)) {
                results.push(scanSource(frag.text, source, frag.lineOffset, hosts));
            }
        } else {
            results.push(scanSource(file.text, source, 0, hosts));
        }
    }

    let unresolved = 0;
    let internal = 0;
    const byKey = new Map();
    for (const r of results) {
        unresolved += r.unresolved;
        internal += r.internal;
        for (const call of r.found) {
            const key = `${call.kind}|${call.method || ''}|${call.url}`;
            const prev = byKey.get(key);
            if (prev) { prev.occurrences++; continue; }
            byKey.set(key, { ...call, occurrences: 1 });
        }
    }

    const all = [...byKey.values()];
    return {
        calls: all.slice(0, MAX_REPORTED_CALLS),
        externalCount: all.length,
        unresolved,
        internal,
    };
}

/** De drie standen van de scan in één vorm, zodat de client niet hoeft te raden. */
function codeSection(scan) {
    if (!scan) return { scanned: false, calls: [], externalCount: 0, unresolved: 0, internal: 0 };
    return { scanned: true, ...scan };
}

// ── de elementscan: WAAR staat een bf-element? ────────────────────────

/**
 * De ruwe attribuuttekst van één openingstag, vanaf `from` tot de `>`.
 *
 * Quotes tellen mee, zodat een `>` IN een attribuutwaarde de tag niet vroeg
 * afkapt. Een niet-afgesloten tag stopt bij de volgende `<` of bij de
 * bovengrens — er wordt hier niets gerepareerd, alleen gelezen.
 */
function openTagText(src, from) {
    const stop = Math.min(src.length, from + MAX_OPEN_TAG_LENGTH);
    let quote = null;
    for (let i = from; i < stop; i++) {
        const c = src[i];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === '\'') { quote = c; continue; }
        if (c === '>' || c === '<') return src.slice(from, i);
    }
    return src.slice(from, stop);
}

/** De geschreven attributen van een openingstag, op kleine letter. */
function parseAttributes(text) {
    const out = {};
    const re = new RegExp(RE_ATTRIBUTE.source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = String(m[1]).toLowerCase();
        // Eerste schrijfwijze wint; een tweede keer hetzelfde attribuut is wat
        // de browser ook negeert.
        if (out[name] === undefined) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return out;
}

/**
 * De waarde zoals de auteur hem SCHREEF voor het attribuut dat de binding
 * draagt. Via de registry, want dat attribuut mag ook onder een oudere
 * schrijfwijze staan (`datatable` naast `source`).
 */
function writtenBindingValue(tag, attrs, from) {
    for (const [name, value] of Object.entries(attrs)) {
        if (bfElements.canonicalAttribute(tag, name) === from) return value;
    }
    return null;
}

/**
 * Eén bestand: waar staat een `bf-*`-element, en wat bindt het?
 *
 * Het patroon komt uit de registry (`BF_TAG_SCAN`) — dit bestand kent geen
 * enkele tagnaam en geen eigen idee van hoe een element eruitziet.
 *
 * @param {string} text
 * @param {string} source  de naam die de auteur ziet ('index.html', 'src/App.jsx')
 * @param {string|null} slot  'html'|'css'|'js' voor een van de drie slots, anders null
 */
function scanBfElementsIn(text, source, slot) {
    const marks = [];
    const unknown = [];
    if (!text) return { marks, total: 0, unknown };

    // Uitgecommentarieerde code is geen koppeling. `maskComments` houdt lengte
    // en regeleindes gelijk, dus elke index hieronder wijst nog naar dezelfde
    // plek in het ORIGINEEL — en de attributen worden ook uit de gemaskeerde
    // tekst gelezen, zodat een half in commentaar staand element niet alsnog
    // een adres oplevert.
    text = maskComments(text, commentKindOf(source, slot));

    const re = new RegExp(bfElements.BF_TAG_SCAN.source, 'gi');
    let m;
    let total = 0;
    // Regelnummer meelopend bijhouden: de treffers komen in oplopende volgorde,
    // dus dit is één keer door de tekst in plaats van één keer per treffer.
    let cursor = 0;
    let line = 1;
    while ((m = re.exec(text)) !== null) {
        total++;
        for (let i = cursor; i < m.index; i++) if (text[i] === '\n') line++;
        cursor = m.index;

        const tag = String(m[1] || '').toLowerCase();
        const attrs = parseAttributes(openTagText(text, m.index + m[0].length));
        const info = bfElements.inspectBfElement(tag, attrs);
        const def = bfElements.getBfElement(tag);
        if (!info.known && !unknown.includes(tag)) unknown.push(tag);
        // Stond er op de plek van het adres een UITDRUKKING? Dan is het adres
        // niet te lezen — en dat is iets anders dan een ontbrekend attribuut,
        // want de auteur heeft het wél opgeschreven. `missing` blijft dus leeg
        // en `targetId` wordt `null`, met `dynamic` als het verschil.
        const dynamic = info.binding
            ? isExpressionValue(writtenBindingValue(tag, attrs, info.binding.from))
            : false;
        marks.push({
            source,
            slot,
            line,
            tag,
            known: info.known,
            // De FAMILIE is waar het element aan hangt, niet wat het heet: de
            // Code-tab tint erop. Hij komt uit de DEFINITIE, niet uit de
            // ingevulde binding: een `<bf-table>` zonder `source` is nog steeds
            // een tabelelement, en de familie op `null` zetten omdat de auteur
            // het adres vergat, zou "ik weet niet WELKE tabel" niet te
            // onderscheiden maken van "dit hangt aan geen enkele tabel".
            // `null` betekent dus: dit SOORT element bindt niets.
            family: (def && def.binding) ? def.binding.kind : null,
            targetId: (info.binding && !dynamic) ? info.binding.id : null,
            dynamic,
            fallback: (def && def.binding) ? (def.binding.fallback || null) : null,
            // `null` bij een onbekend element — "er ontbreekt niets" is een
            // uitspraak die je daarover niet kunt doen (zie missingAttributes).
            missing: info.missing,
            reason: info.reason,
        });
    }
    return { marks, total, unknown };
}

/**
 * Waar staan de `bf-*`-elementen van deze pagina? Puur: geef de tekst mee.
 *
 * Elk tekstbestand dat de editor kan openen wordt gelezen — de drie slots én
 * de extra's. Een react-mui-pagina heeft haar elementen in `src/*.jsx` staan,
 * en een element dat niet wordt gelezen levert geen markering op; dat zou niet
 * te onderscheiden zijn van een pagina zonder koppelingen.
 *
 * @returns {{marks:Array, counts:{total:number,known:number,unknown:number},
 *            unknownTags:string[], truncated:number}}
 */
function scanBfElements({ html = '', css = '', js = '', extras = [] } = {}) {
    const parts = [
        scanBfElementsIn(html, 'index.html', 'html'),
        scanBfElementsIn(css, 'style.css', 'css'),
        scanBfElementsIn(js, 'script.js', 'js'),
    ];
    for (const file of (Array.isArray(extras) ? extras : [])) {
        if (!file || typeof file.text !== 'string') continue;
        parts.push(scanBfElementsIn(file.text, String(file.path || 'extra file'), null));
    }

    const all = [];
    const unknownTags = [];
    let total = 0;
    for (const part of parts) {
        total += part.total;
        for (const mark of part.marks) all.push(mark);
        for (const tag of part.unknown) if (!unknownTags.includes(tag)) unknownTags.push(tag);
    }

    const marks = all.slice(0, MAX_REPORTED_MARKS);
    return {
        marks,
        counts: {
            total,
            known: all.filter(mk => mk.known).length,
            unknown: all.filter(mk => !mk.known).length,
        },
        unknownTags,
        // Wat er niet meer bij kon, wordt geteld en niet verzwegen.
        truncated: Math.max(0, all.length - marks.length),
    };
}

/** Dezelfde drie standen als `codeSection`, om dezelfde reden. */
function elementsSection(scan) {
    if (!scan) {
        return {
            scanned: false,
            marks: [],
            counts: { total: 0, known: 0, unknown: 0 },
            unknownTags: [],
            truncated: 0,
        };
    }
    return { scanned: true, ...scan };
}


// ── de usage-index: welke tabel, welke routine, welke agent ───────────

/**
 * De families die het vocabulaire kent, uit de registry.
 *
 * Er staat hier met opzet geen `['datatable','automation','agent']`: dat zou een
 * tweede lijst zijn, en een familie die daaraan wordt toegevoegd zou dan stil
 * uit de index vallen in plaats van er als lege lijst in te staan.
 */
function bindingKinds() {
    const kinds = [];
    for (const def of bfElements.BF_ELEMENTS) {
        if (def.binding && !kinds.includes(def.binding.kind)) kinds.push(def.binding.kind);
    }
    return kinds;
}

/** Elke terugval die het vocabulaire kent — waar de aanroeper een antwoord voor moet hebben. */
function declaredFallbacks() {
    const out = [];
    for (const def of bfElements.BF_ELEMENTS) {
        const fb = def.binding && def.binding.fallback;
        if (fb && !out.includes(fb)) out.push(fb);
    }
    return out;
}

/**
 * Het antwoord op één terugval, door het PAD uit de registry te volgen.
 *
 * Een terugval is een pad in de brug-grants (`bridge_grants.agent`), dus het
 * antwoord staat daar ook echt. Dit pad volgen in plaats van er een tabelletje
 * "welke terugval betekent wat" naast te leggen: zo'n tabelletje zou bij een
 * TWEEDE terugval het antwoord van de eerste geven, en dat is een verkeerd id —
 * het enige antwoord dat we niet mogen geven.
 *
 * De grants dragen hun id als `<iets>Id` (`agentId`, `datatableId`). Vindt deze
 * functie er geen, dan is het antwoord `null` en blijft het element
 * `unresolved`: niet te bepalen, nooit geraden.
 */
function fallbackIdFromGrants(path, grants) {
    const parts = String(path || '').split('.');
    if (parts.shift() !== 'bridge_grants' || !parts.length) return null;
    let node = grants;
    for (const part of parts) {
        if (!node || typeof node !== 'object') return null;
        node = node[part];
    }
    if (typeof node === 'string') return node || null;
    if (!node || typeof node !== 'object') return null;
    const key = Object.keys(node).find(k => /Id$/.test(k) && typeof node[k] === 'string' && node[k]);
    return key ? node[key] : null;
}

function emptyTargets() {
    const out = {};
    for (const kind of bindingKinds()) out[kind] = [];
    return out;
}

/**
 * Wat hangt er via een `bf-*`-ELEMENT aan deze pagina?
 *
 * Twee dingen die uit elkaar moeten blijven, en dat is de hele reden dat deze
 * functie bestaat naast de markeringen:
 *
 *   targets     wat we KUNNEN aanwijzen — per familie een lijst met, per id,
 *               de plekken waar hij wordt gebruikt;
 *   unresolved  een element dat wél iets bindt, maar waarvan niet te zeggen is
 *               wát. Dat is geen "niets": een pagina met drie knoppen waarvan de
 *               routine-id ter plekke wordt gebouwd, is geen pagina zonder
 *               routines.
 *
 * @param {object|null} scan          de uitslag van `scanBfElements`
 * @param {object} args
 * @param {Object<string,string|null>} args.fallbackIds  antwoord per terugval uit
 *   de registry (`bridge_grants.agent` → de agent van de pagina). Een terugval
 *   die hier ontbreekt is `unknown-fallback` — nooit een stille weglating.
 */
/**
 * "Dit veld was niet te lezen" — als waarde, niet als afwezigheid.
 *
 * `null` betekent hier "de pagina heeft er geen"; dit betekent "we weten het
 * niet". Een Symbol, zodat geen enkel echt id ermee kan botsen.
 */
const FALLBACK_UNREADABLE = Symbol('fallback-unreadable');

function collectUses(scan, { fallbackIds = {} } = {}) {
    const targets = emptyTargets();
    const perKind = new Map();
    const unresolved = [];

    for (const mark of (scan && Array.isArray(scan.marks) ? scan.marks : [])) {
        // Een onbekend element staat al in `unknownTags`; er valt niets van te
        // binden omdat we niet weten wat het zou binden.
        if (!mark.known || !mark.family) continue;
        const where = { tag: mark.tag, source: mark.source, line: mark.line };
        const miss = (reason) => unresolved.push({
            ...where,
            kind: mark.family,
            reason,
            missing: mark.missing,
            dynamic: !!mark.dynamic,
        });

        let id = mark.targetId;
        let fromPage = false;
        if (!id && mark.fallback) {
            if (!Object.prototype.hasOwnProperty.call(fallbackIds, mark.fallback)) {
                miss('unknown-fallback');
                continue;
            }
            id = fallbackIds[mark.fallback];
            if (id === FALLBACK_UNREADABLE) { miss('page-binding-unreadable'); continue; }
            fromPage = true;
        }
        if (!id) {
            miss(mark.dynamic ? 'built-at-runtime' : (mark.fallback ? 'page-binding-unknown' : 'no-target'));
            continue;
        }

        if (!perKind.has(mark.family)) perKind.set(mark.family, new Map());
        const byId = perKind.get(mark.family);
        const entry = byId.get(id) || { id, fromPage: false, elements: [] };
        // "Kwam dit id (ook) van de pagina zelf?" — dat verschil hoort de kolom
        // te tonen: een agent die nergens genoemd staat, hangt aan de PAGINA en
        // verdwijnt zodra die binding wordt losgemaakt.
        entry.fromPage = entry.fromPage || fromPage;
        entry.elements.push(where);
        byId.set(id, entry);
    }

    for (const [kind, byId] of perKind) {
        if (!targets[kind]) targets[kind] = [];
        for (const entry of byId.values()) targets[kind].push({ ...entry, count: entry.elements.length });
    }
    return { targets, unresolved };
}

/** Dezelfde drie standen als `codeSection`, om dezelfde reden. */
function usesSection(scan, opts) {
    if (!scan) return { scanned: false, targets: emptyTargets(), unresolved: [] };
    return { scanned: true, ...collectUses(scan, opts) };
}

/**
 * Het model achter de kolom "Laat gebeuren".
 *
 * @param {object} args
 * @param {string} args.webpageId
 * @param {string} args.userId  de EIGENAAR (de route is eigenaar-only, net als
 *                              de grants ernaast: dit toont code-inhoud)
 */
async function describePageActions({ webpageId, userId }) {
    const code = await readPageCode(userId, webpageId);
    const scan = code.readable ? scanOutboundCalls(code) : null;
    const elements = code.readable ? scanBfElements(code) : null;

    let grants = null;
    let agentId = null;
    let agentKnown = true;
    try {
        grants = await bridgeGrants.getBridgeGrants(webpageId);
        agentId = grants && grants.agent && grants.agent.agentId ? grants.agent.agentId : null;
    } catch {
        // Onleesbare grants zijn geen "geen agent": dat verschil draagt `known`,
        // zodat de kaart kan zwijgen in plaats van te beweren.
        agentKnown = false;
    }

    // Het antwoord op ELKE terugval die het vocabulaire kent — vandaag één: een
    // `<bf-agent>` zonder eigen id draait de agent van de PAGINA. De lijst komt
    // uit de registry en het antwoord uit de grants zelf, dus een tweede
    // terugval krijgt vanzelf zijn eigen antwoord in plaats van dat van de
    // eerste. Onleesbare grants geven `null`, en dat is iets anders dan "er is
    // er geen": het element blijft dan `unresolved` in plaats van te verdwijnen.
    const fallbackIds = {};
    for (const path of declaredFallbacks()) {
        // FALLBACK_UNREADABLE, niet `null`: allebei leverden ze `null` op, en dan
        // kreeg "deze pagina heeft geen agent gebonden" dezelfde reden als "de
        // grants waren niet te lezen". Het commentaar hierboven beloofde dat
        // verschil; binnen `uses` bestond het niet.
        fallbackIds[path] = agentKnown ? fallbackIdFromGrants(path, grants) : FALLBACK_UNREADABLE;
    }

    return {
        code: codeSection(scan),
        // Waar de `bf-*`-elementen staan, per bestand en per regel. De Code-tab
        // tekent hier zijn markeringen mee; `scanned:false` betekent dáár dat de
        // legenda moet zeggen dat de markering niet kon worden berekend.
        elements: elementsSection(elements),
        // WELKE tabel, WELKE routine, WELKE agent — per familie, met de plekken
        // erbij. Dit is wat de middenkolom toont en wat de usage-index omdraait.
        uses: usesSection(elements, { fallbackIds }),
        // De elementen ZELF staan in `elements.marks`, elk met zijn `tag`; deze
        // twee velden zeggen alleen nog wat de kolom over dat soort mag
        // beweren. Ze bestonden als "dit kennen we nog niet"-plaatshouders;
        // sinds `<bf-form>` en `<bf-agent>` echt bestaan is dat niet meer waar,
        // en `scanned` draagt nu het verschil tussen "geen" en "niet gekeken".
        forms: { supported: true, scanned: elements !== null },
        // Het Agent-blok is INTERN-ONLY: `ai.ask` is bewust uit de anonieme
        // bridge gehouden (services/publicShareBridge.js kent alleen /ai/chat en
        // /ai/stream), dus een publieke share draait het nooit. De kaart zegt
        // dat erbij in plaats van het blok stil niets te laten doen.
        agent: {
            known: agentKnown,
            agentId: agentKnown ? agentId : null,
            supported: true,
            internalOnly: true,
            scanned: elements !== null,
        },
    };
}

module.exports = {
    describePageActions,
    scanOutboundCalls,
    scanBfElements,
    collectUses,
    readPageCode,
    // Voor de tests én voor W4, dat op dezelfde maskeerder verder bouwt.
    maskCode,
    maskComments,
    FALLBACK_UNREADABLE,
    classifyUrl,
    inlineScripts,
};
