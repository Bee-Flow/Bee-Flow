/**
 * De Bee Flow-elementen zoals ze BIJ DE LEZER werken.
 *
 * ── WELKE VAN DE DRIE PLEKKEN DIT IS ────────────────────────────────
 *
 * Dit is de CLIENT-kant: de preview in de app en een INGELOGDE lezer. Daar
 * draait wel JavaScript en zijn de bruggen er, dus hier werken de elementen
 * echt — anders dan in de publieke snapshot, waar geen JS draait en alles wat
 * JS nodig heeft inert is, en anders dan op een publieke react-share, waar de
 * brug ze weigert. Wat er per plek van een element overblijft, staat in
 * server/core/webpages/bfElements.js; dit bestand VOERT de client-kant uit.
 *
 * ── HET VOCABULAIRE STAAT HIER NIET ─────────────────────────────────
 *
 * Geen enkele elementnaam, geen enkel attribuut en geen enkele bovengrens
 * staat in dit bestand opgeschreven. Alles komt uit ./bfElements.js, de
 * gegenereerde spiegel van de registry. De uitgezonden code bevat de namen dus
 * wél (ze staan in de meegegeven JSON), maar de BRON hier niet — dat is precies
 * het verschil tussen "afgeleid" en "een tweede lijst", en een tweede lijst is
 * de drift die W4 bestaat om te voorkomen. Een test in
 * composeWebpageDocument.test.js houdt dit bestand daaraan.
 *
 * Wat hier wél met de hand staat is CLIENT_HANDLING: de beslissing die deze
 * plek moet uitspreken over élk element van het vocabulaire — precies zoals
 * VANILLA_HANDLING dat doet in server/services/webpageBfTable.js. Een element
 * dat de registry kent maar dat hier geen renderer heeft, is niet stil: het
 * telt als een gat (`clientCoverageGaps()`), het staat in `window.beeflowBf`
 * als "unsupported" in plaats van als "live", en de lezer krijgt op de pagina
 * een zichtbare melding te zien.
 *
 * ── FALEN IS BELANGRIJKER DAN LUKKEN ────────────────────────────────
 *
 * Een element dat zijn bron niet kan lezen moet dat TONEN. De vier redenen
 * blijven daarbij uit elkaar, want ze vragen om ander gedrag van de lezer:
 *
 *   unavailable  de brug is er niet (geen preview-token) — dit blok wordt met
 *                opzet ook zónder token uitgezonden, juist om dat te kunnen
 *                zeggen in plaats van onzichtbaar te blijven;
 *   forbidden    de server zei 401/403 — je mag dit niet zien;
 *   gone         de server zei 404 — de bron is niet (meer) aan deze pagina
 *                gebonden;
 *   failed       al het andere — er ging iets stuk;
 *   empty        het lezen lukte en er is niets. Dat is GEEN fout, en het mag
 *                er ook niet als een fout uitzien.
 *
 * Op een publieke snapshot gaat die reden bewust NIET mee naar de lezer
 * (services/webpageBfTable.js legt uit waarom: een anonieme bezoeker mag
 * "mag niet" en "kapot" niet uit elkaar kunnen houden). Hier is het publiek een
 * ander: een ingelogde lezer of de auteur in zijn eigen preview, en die moet
 * juist wél weten waaróm er niets staat.
 */

import { BF_ELEMENTS } from './bfElements';

/** Het voorvoegsel van alle elementen; de rest van de naam is de renderersleutel. */
const PREFIX = 'bf-';

/** De sleutel waaronder een element zijn renderer vindt: de naam ná het voorvoegsel. */
export function localNameOf(tag) {
    return String(tag || '').slice(PREFIX.length);
}

/**
 * Wat DEZE plek met elk element doet — de beslissing die de client uitspreekt.
 *
 *   live  — er staat hieronder een renderer voor, en die praat met de bruggen.
 *
 * Een element uit de registry dat hier ontbreekt is een GAT, geen stilte:
 * `clientCoverageGaps()` meldt het, de test valt erover, `window.beeflowBf`
 * noemt het "unsupported" en de lezer krijgt een melding in plaats van een lege
 * plek. Wie een element toevoegt, zet zijn sleutel hier neer.
 */
export const CLIENT_HANDLING = Object.freeze({
    table: 'live',
    stat: 'live',
    button: 'live',
    form: 'live',
    agent: 'live',
});

/**
 * De naam van de renderfunctie die bij een sleutel hoort.
 *
 * De RENDERERS-tabel in het uitgezonden blok wordt hieruit GEGENEREERD, en de
 * dekkingscontrole leest daarna de uitgezonden brontekst om te zien of die
 * functie er ook echt staat. Zonder dat was RENDERERS een tweede, met de hand
 * bijgehouden lijst naast CLIENT_HANDLING: een sleutel eruit halen liet de
 * controle groen en `window.beeflowBf` "live" beweren over een element dat op de
 * pagina "unsupported" toonde — de brug loog dan tegen de pagina.
 */
export function rendererNameOf(local) {
    return 'render' + String(local || '').charAt(0).toUpperCase() + String(local || '').slice(1);
}

/**
 * De twee richtingen tussen de registry en de renderers hierboven.
 *
 * @returns {{missing:string[], stray:string[]}} `missing`: in het vocabulaire,
 *   maar hier niet bediend. `stray`: hier bediend, maar het vocabulaire kent
 *   het niet (meer).
 */
export function clientCoverageGaps(body = null) {
    const locals = BF_ELEMENTS.map(def => localNameOf(def.tag));
    const declared = Object.keys(CLIENT_HANDLING);
    // Derde richting: verklaard, maar er staat geen functie voor in de
    // uitgezonden code. Alleen te toetsen op de BRONTEKST, want de renderers
    // bestaan pas in de browser.
    const unimplemented = body === null ? [] : declared.filter(
        l => !new RegExp(`function ${rendererNameOf(l)}\\b`).test(body),
    );
    return {
        missing: locals.filter(l => !declared.includes(l)),
        stray: declared.filter(d => !locals.includes(d)),
        unimplemented,
    };
}

/**
 * Het vocabulaire zoals de BROWSER het nodig heeft: alleen de velden waar de
 * uitgezonden code iets mee doet. De Nederlandse verantwoordingen (`why`) en de
 * teksten van de andere twee plekken blijven achter — die gaan de pagina van
 * een lezer niet aan.
 */
function clientVocabulary(unimplemented = []) {
    return BF_ELEMENTS.map((def) => {
        const local = localNameOf(def.tag);
        const served = !!CLIENT_HANDLING[local] && !unimplemented.includes(local);
        return {
            tag: def.tag,
            local,
            // Geen renderer ⇒ geen 'live'. Liever herkenbaar niet-bediend dan
            // een belofte die deze plek niet waarmaakt. `served` telt ook de
            // ONTBREKENDE functie mee, zodat de brug niet "live" kan zeggen over
            // iets dat de pagina als "unsupported" te zien krijgt.
            state: served ? def.surfaces.clientComposer.state : 'unsupported',
            needsJs: !!def.needsJs,
            // Over hoeveel rijen dit element rekent. Uit de registry, zodat de
            // preview hetzelfde getal oplevert als de gepubliceerde pagina.
            ...(def.reads ? { reads: def.reads } : {}),
            attributes: def.attributes.map(a => ({
                name: a.name,
                ...(a.aliases ? { aliases: a.aliases } : {}),
                ...(a.required ? { required: true } : {}),
                ...(a.requiredWhen ? { requiredWhen: a.requiredWhen } : {}),
                ...(a.values ? { values: a.values } : {}),
                ...(a.default !== undefined ? { default: a.default } : {}),
                ...(a.max !== undefined ? { max: a.max } : {}),
            })),
            binding: def.binding ? { kind: def.binding.kind, from: def.binding.from } : null,
        };
    });
}

/** JSON dat veilig binnen een inline <script> staat. */
function jsonLiteral(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * De opmaak. Een custom element is standaard `display:inline` en leeg — precies
 * de onzichtbaarheid die hier bestreden wordt — dus alles krijgt eerst een blok.
 * Verder alleen neutrale grijstinten met doorzichtigheid, zodat het op een
 * lichte én een donkere pagina leesbaar is, en de auteur het met zijn eigen CSS
 * kan overschrijven (deze stijl staat vóór de zijne in de <head>).
 */
function buildBfStyles() {
    const selector = BF_ELEMENTS.map(def => def.tag).join(',');
    return `<style>
${selector}{display:block;margin:.5em 0}
.bf-own[hidden]{display:none!important}
.bf-msg{display:block;margin:.25em 0;padding:.45em .65em;border:1px solid rgba(127,127,127,.45);border-radius:6px;background:rgba(127,127,127,.09);font-size:.875em;line-height:1.45}
.bf-msg-detail{display:block;margin-top:.15em;opacity:.7;font-size:.9em;word-break:break-word}
.bf-msg[data-bf-state="forbidden"],.bf-msg[data-bf-state="failed"],.bf-msg[data-bf-state="invalid"]{border-color:rgba(200,60,60,.55);background:rgba(200,60,60,.09)}
.bf-msg[data-bf-state="done"]{border-color:rgba(60,160,90,.55);background:rgba(60,160,90,.09)}
.bf-grid{border-collapse:collapse;width:100%;font-size:.9em}
.bf-grid th,.bf-grid td{border:1px solid rgba(127,127,127,.35);padding:.35em .5em;text-align:left;vertical-align:top}
.bf-stat-value{display:block;font-size:1.8em;font-weight:600;line-height:1.1}
.bf-stat-label{display:block;opacity:.75;font-size:.9em}
.bf-btn{font:inherit;padding:.4em .9em;border:1px solid rgba(127,127,127,.5);border-radius:6px;background:rgba(127,127,127,.12);cursor:pointer}
.bf-btn[disabled]{opacity:.55;cursor:default}
.bf-form-bar{margin-top:.5em}
.bf-agent-log{max-height:16em;overflow:auto;margin-bottom:.5em}
.bf-agent-you,.bf-agent-bot{margin:.25em 0;padding:.35em .55em;border-radius:6px;white-space:pre-wrap}
.bf-agent-you{background:rgba(127,127,127,.14)}
.bf-agent-bot{background:rgba(127,127,127,.06)}
.bf-agent-row{display:flex;gap:.5em}
.bf-agent-input{flex:1;font:inherit;padding:.4em .6em;border:1px solid rgba(127,127,127,.5);border-radius:6px}
</style>`;
}

/** Het vocabulaire, de brug-opzoeker en alle zinnen die de lezer kan zien. */
function emitVocabulary(unimplemented = []) {
    return `
  var ELEMENTS = ${jsonLiteral(clientVocabulary(unimplemented))};
  var PREFIX = ${jsonLiteral(PREFIX)};
  var READY = "data-bf-ready";
  var STATE = "data-bf-state";
  var BY_TAG = {}, VOCAB = {};
  for (var vi = 0; vi < ELEMENTS.length; vi++) {
    BY_TAG[ELEMENTS[vi].tag] = ELEMENTS[vi];
    VOCAB[ELEMENTS[vi].tag] = { state: ELEMENTS[vi].state, needsJs: ELEMENTS[vi].needsJs, message: null };
  }
  // De bruggen worden op naam GELEZEN en nooit hier gedefinieerd. Dit blok
  // wordt namelijk ook uitgezonden als de shims hierboven ontbraken (geen
  // token): juist dan moet een element zeggen dat het zijn bron niet kan
  // bereiken, in plaats van onzichtbaar te blijven.
  function bridge(name) {
    try { return window[name] || null; } catch (e) { return null; }
  }
  var SAY = {
    unavailable: "This block cannot reach Bee Flow from here.",
    unsupported: "Bee Flow cannot show this block here yet.",
    unknown: "Unknown Bee Flow element:",
    invalid: "This block is missing something it needs:",
    invalidValue: "This block was given a value it does not know:",
    forbidden: "You are not allowed to see this.",
    gone: "This page is not linked to that source any more.",
    failed: "Could not load this.",
    emptyRows: "No rows to show.",
    emptyNumbers: "That column has no numbers to work with.",
    emptyAnswer: "The assistant did not answer.",
    columnGone: "That column is not available on this page.",
    partial: "Showing the first",
    partialAnswer: "This answer was cut short before the assistant finished.",
    rowsWord: "rows only.",
    loading: "Loading...",
    run: "Run",
    submit: "Submit",
    send: "Send",
    confirmAgain: "Click again to confirm",
    running: "Running...",
    done: "Done.",
    runFailed: "That did not finish.",
    runPending: "Still busy:",
    asking: "Thinking..."
  };`;
}

/** Bouwstenen voor de DOM, en het onderscheid tussen de soorten mislukking. */
function emitDom() {
    return `
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== null && text !== undefined) n.textContent = String(text);
    return n;
  }
  // Wat de AUTEUR in het element schreef, blijft van hem — dezelfde regel als
  // op de twee serverplekken (inertBlock verhuist zijn kinderen, bfDecorate laat
  // ze staan). Ze gaan één keer in een eigen blok; wij schrijven daarna alleen
  // nog in ons EIGEN blok ernaast. Weggooien mocht niet: bij een tikfout in een
  // attribuut verdween zo de hele formuliermarkup van de auteur uit de preview.
  function own(host) {
    if (host.__bfOwn && host.__bfOwn.parentNode === host) return host.__bfOwn;
    var box = node("div", "bf-own");
    while (host.firstChild) box.appendChild(host.firstChild);
    host.__bfOwn = box;
    host.appendChild(box);
    return box;
  }
  function out(host) {
    if (host.__bfOut && host.__bfOut.parentNode === host) return host.__bfOut;
    own(host);
    var box = node("div", "bf-out");
    host.__bfOut = box;
    host.appendChild(box);
    return box;
  }
  function empty(box) { while (box.firstChild) box.removeChild(box.firstChild); }
  // Het element waar dit ONDER hangt. Een statusregel zit in een gewone <div>,
  // maar de stand hoort op het bf-element zelf te staan — daar mikt de CSS van
  // de auteur op, en daar zet de publieke brug hem ook neer.
  function hostOf(el) {
    var n = el;
    while (n && n.nodeType === 1) {
      if (isOurs(n.tagName)) return n;
      n = n.parentNode;
    }
    return null;
  }
  function mark(el, kind) {
    var h = hostOf(el);
    if (!h) return;
    if (kind) h.setAttribute(STATE, kind);
    else h.removeAttribute(STATE);
  }
  function clear(host) {
    empty(out(host));
    // Leeghalen wist ook het oordeel: anders blijft "loading" op een element
    // staan dat inmiddels gewoon zijn rijen toont.
    mark(host, null);
  }
  // Wij nemen het over: onze uitvoer vervangt wat de auteur als terugval
  // schreef (een "laden…"-tekst, het label van een knop). Verbergen, niet
  // weggooien — zodra het alsnog misgaat komt zijn tekst terug.
  function takeOver(host) {
    var box = out(host);
    empty(box);
    own(host).hidden = true;
    mark(host, null);
    return box;
  }
  function message(kind, text, detail) {
    var box = node("div", "bf-msg");
    box.setAttribute(STATE, kind);
    box.setAttribute("role", "status");
    box.appendChild(node("span", "bf-msg-text", text));
    if (detail) box.appendChild(node("span", "bf-msg-detail", String(detail)));
    return box;
  }
  function show(host, kind, text, detail) {
    var box = out(host);
    empty(box);
    // Een melding is een MISLUKKING, geen render: wat de auteur zelf schreef
    // komt weer tevoorschijn (of blijft staan), zodat zijn terugvaltekst en zijn
    // velden er nog zijn.
    own(host).hidden = false;
    // De stand op het bf-ELEMENT, ook als deze aanroep een statusregel eronder
    // betreft — dezelfde plek waar de publieke brug hem neerzet, zodat CSS en
    // tests op beide plekken hetzelfde kunnen vragen.
    mark(host, kind);
    box.appendChild(message(kind, text, detail));
  }
  // De drie soorten mislukking uit elkaar houden. "Leeg" komt hier NOOIT langs:
  // dat is geen fout en hoort er ook niet als een fout uit te zien.
  function classify(err) {
    var status = (err && typeof err.status === "number") ? err.status : 0;
    if (status === 401 || status === 403) return "forbidden";
    if (status === 404) return "gone";
    return "failed";
  }
  function fail(host, err) {
    var kind = classify(err);
    var text = kind === "forbidden" ? SAY.forbidden : (kind === "gone" ? SAY.gone : SAY.failed);
    show(host, kind, text, (err && err.message) ? String(err.message) : null);
  }
  function cellText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
      try { return JSON.stringify(value).slice(0, 500); } catch (e) { return ""; }
    }
    return String(value).slice(0, 500);
  }
  function formatNumber(n) {
    if (typeof n !== "number" || !isFinite(n)) return String(n);
    return String(Math.round(n * 100) / 100);
  }`;
}

/**
 * De attribuutlezer: dezelfde regels als de serverkant (aliassen, defaults,
 * voorwaardelijk verplicht), maar hier over dezelfde meegegeven definities.
 */
function emitAttributes() {
    return `
  function specOf(def, name) {
    for (var i = 0; i < def.attributes.length; i++) if (def.attributes[i].name === name) return def.attributes[i];
    return null;
  }
  function readAttributes(def, el) {
    var out = {}, i, j;
    for (i = 0; i < def.attributes.length; i++) {
      var spec = def.attributes[i];
      var names = [spec.name].concat(spec.aliases || []);
      for (j = 0; j < names.length; j++) {
        var raw = el.getAttribute(names[j]);
        if (raw === null || raw === undefined) continue;
        var value = String(raw).trim();
        if (!value) continue;
        out[spec.name] = value;
        break;
      }
    }
    for (i = 0; i < def.attributes.length; i++) {
      var d = def.attributes[i];
      if (out[d.name] === undefined && d["default"] !== undefined) out[d.name] = d["default"];
    }
    return out;
  }
  function requiredHere(spec, attrs) {
    if (spec.required === true) return true;
    var when = spec.requiredWhen;
    if (!when) return false;
    var value = attrs[when.attr];
    if (value === undefined) return false;
    return (when.notOneOf || []).indexOf(value) === -1;
  }
  function missingAttributes(def, attrs) {
    var out = [];
    for (var i = 0; i < def.attributes.length; i++) {
      var spec = def.attributes[i];
      if (requiredHere(spec, attrs) && !attrs[spec.name]) out.push(spec.name);
    }
    return out;
  }
  // Een gesloten lijst met waarden is een belofte: een waarde die er niet in
  // staat wordt gemeld, niet stil op de default gezet.
  function badValues(def, attrs) {
    var out = [];
    for (var i = 0; i < def.attributes.length; i++) {
      var spec = def.attributes[i];
      if (!spec.values || attrs[spec.name] === undefined) continue;
      if (spec.values.indexOf(attrs[spec.name]) === -1) out.push(spec.name + "=" + attrs[spec.name]);
    }
    return out;
  }`;
}

/** Het lezen zelf: één plek waar de rijen vandaan komen, voor beide lezers. */
function emitRows() {
    return `
  // Leest ALS DE BEZOEKER, met diens eigen graad, en geknipt tot de kolommen
  // die de auteur aan deze pagina heeft gebonden. Dat is een andere lezer dan
  // de publieke snapshot gebruikt, en met opzet.
  function readRows(def, attrs) {
    var tables = bridge("beeflowTables");
    if (!tables || typeof tables.query !== "function") return null;
    var opts = {};
    var spec = specOf(def, "limit");
    if (spec) {
      var max = (typeof spec.max === "number") ? spec.max : 0;
      var want = parseInt(attrs[spec.name], 10);
      if (!isFinite(want) || want <= 0) want = max;
      if (max) want = Math.min(want, max);
      if (want) opts.limit = want;
    } else if (def.reads && def.reads.rowsMax) {
      // Een element zonder limit-attribuut vroeg niets, en dan koos de server
      // zijn eigen default (50) terwijl de gepubliceerde pagina er 500 leest:
      // twee verschillende getallen voor hetzelfde element. Het getal staat nu
      // in de registry en beide plekken vragen het op.
      opts.limit = def.reads.rowsMax;
    }
    return tables.query(attrs[def.binding.from], opts);
  }
  function partialNotice(res, rows) {
    if (!res || !res.hasMore) return null;
    return message("partial", SAY.partial + " " + rows.length + " " + SAY.rowsWord);
  }
`;
}

/** De tabel: rijen als gewone opmaak. */
function emitTable() {
    return `
  function renderTable(el, def, attrs) {
    var p = readRows(def, attrs);
    if (!p) return show(el, "unavailable", SAY.unavailable);
    show(el, "loading", SAY.loading);
    p.then(function (res) {
      var rows = (res && res.rows) || [], cols = (res && res.columns) || [];
      if (!rows.length || !cols.length) return show(el, "empty", SAY.emptyRows);
      var box = takeOver(el);
      var table = node("table", "bf-grid"), head = node("tr"), body = node("tbody"), i, k;
      for (i = 0; i < cols.length; i++) head.appendChild(node("th", null, cols[i]));
      table.appendChild(node("thead")).appendChild(head);
      for (i = 0; i < rows.length; i++) {
        var tr = node("tr");
        for (k = 0; k < cols.length; k++) tr.appendChild(node("td", null, cellText(rows[i][cols[k]])));
        body.appendChild(tr);
      }
      table.appendChild(body);
      box.appendChild(table);
      var partial = partialNotice(res, rows);
      if (partial) box.appendChild(partial);
    }, function (err) { fail(el, err); });
  }
`;
}

/** Het losse getal: één uitkomst over dezelfde rijen. */
function emitStat() {
    return `
  function aggregate(agg, nums) {
    var i, out;
    if (agg === "sum" || agg === "avg") {
      out = 0;
      for (i = 0; i < nums.length; i++) out += nums[i];
      return agg === "sum" ? out : out / nums.length;
    }
    if (agg === "min" || agg === "max") {
      out = nums[0];
      for (i = 1; i < nums.length; i++) {
        if (agg === "min" ? nums[i] < out : nums[i] > out) out = nums[i];
      }
      return out;
    }
    return null;
  }
  function renderStat(el, def, attrs) {
    var p = readRows(def, attrs);
    if (!p) return show(el, "unavailable", SAY.unavailable);
    show(el, "loading", SAY.loading);
    p.then(function (res) {
      var rows = (res && res.rows) || [], cols = (res && res.columns) || [];
      var value = rows.length;
      if (attrs.agg !== "count") {
        // De kolom moet gebonden ZIJN. Staat hij er niet bij, dan is dat "mag
        // je niet zien" — geen nul.
        if (cols.indexOf(attrs.column) === -1) return show(el, "forbidden", SAY.columnGone, attrs.column);
        var nums = [];
        for (var i = 0; i < rows.length; i++) {
          var raw = rows[i] ? rows[i][attrs.column] : null;
          if (raw === null || raw === undefined || raw === "") continue;
          var n = Number(raw);
          if (isFinite(n)) nums.push(n);
        }
        if (!nums.length) return show(el, "empty", SAY.emptyNumbers);
        value = aggregate(attrs.agg, nums);
        if (value === null) return show(el, "unsupported", SAY.unsupported, attrs.agg);
      }
      var box = takeOver(el);
      box.appendChild(node("span", "bf-stat-value", formatNumber(value)));
      if (attrs.label) box.appendChild(node("span", "bf-stat-label", attrs.label));
      // Een getal over een AFGEKAPTE uitslag is een verkeerd getal. Dat mag
      // nooit zonder die mededeling op de pagina staan.
      var partial = partialNotice(res, rows);
      if (partial) box.appendChild(partial);
    }, function (err) { fail(el, err); });
  }`;
}

/** Het starten van een routine, en het bevestigen zonder modaal venster. */
function emitRunner() {
    return `
  function runAutomation(host, def, attrs, inputs, done) {
    var autos = bridge("beeflowAutomations");
    if (!autos || typeof autos.run !== "function") { show(host, "unavailable", SAY.unavailable); return done(); }
    show(host, "busy", SAY.running);
    autos.run(attrs[def.binding.from], inputs || {}, { wait: true }).then(function (res) {
      // LET OP: deze route antwoordt met 200 en een MISLUKTE run in het lichaam.
      // Wie alleen naar de HTTP-status kijkt, meldt "gelukt" over iets dat
      // stukliep. Alleen 'success' zonder fout is gelukt; al het andere is een
      // eigen, zichtbare stand.
      var status = (res && res.status) ? String(res.status) : "";
      if (res && res.error) show(host, "failed", SAY.runFailed, String(res.error));
      else if (status === "success") show(host, "done", SAY.done);
      else show(host, "pending", SAY.runPending, status);
      done();
    }, function (err) { fail(host, err); done(); });
  }
  // \`confirm\` is hier met opzet GEEN window.confirm: de preview draait in een
  // iframe met sandbox="allow-scripts allow-forms" en zonder allow-modals
  // negeert de browser confirm() stil — de knop zou dan nooit iets doen. Twee
  // klikken met een zichtbare tussenstand werkt overal.
  function arming(btn, label, go) {
    var armed = false, timer = null;
    function disarm() {
      armed = false;
      btn.textContent = label;
      if (timer) clearTimeout(timer);
      timer = null;
    }
    return function (needsConfirm) {
      if (needsConfirm && !armed) {
        armed = true;
        btn.textContent = SAY.confirmAgain;
        timer = setTimeout(disarm, 5000);
        return;
      }
      disarm();
      go();
    };
  }
`;
}

/** De twee elementen die iets LATEN GEBEUREN: de knop en het formulier. */
function emitControls() {
    return `
  function renderButton(el, def, attrs) {
    // De tekst IN het element is bij deze soort het LABEL, geen opmaak — lezen
    // vóór takeOver, want daarna is hij verborgen.
    var label = attrs.label || String(el.textContent || "").trim() || SAY.run;
    var box = takeOver(el);
    var btn = node("button", "bf-btn", label), status = node("div", "bf-status");
    btn.type = "button";
    box.appendChild(btn);
    box.appendChild(status);
    var autos = bridge("beeflowAutomations");
    if (!autos || typeof autos.run !== "function") {
      btn.disabled = true;
      return show(status, "unavailable", SAY.unavailable);
    }
    var press = arming(btn, label, function () {
      btn.disabled = true;
      runAutomation(status, def, attrs, {}, function () { btn.disabled = false; });
    });
    btn.addEventListener("click", function () { press(!!attrs.confirm); });
  }
  function renderForm(el, def, attrs) {
    // De kinderen van de auteur BLIJVEN staan én ZICHTBAAR — dat zijn zijn
    // velden, niet een terugvaltekst. Er komt alleen een knop en een statusregel
    // bij. Geen echt <form>-element: met allow-forms zou een Enter de hele frame
    // wegnavigeren.
    var label = attrs["submit-label"] || SAY.submit;
    var box = out(el);
    empty(box);
    var bar = node("div", "bf-form-bar"), btn = node("button", "bf-btn", label), status = node("div", "bf-status");
    btn.type = "button";
    bar.appendChild(btn);
    box.appendChild(bar);
    box.appendChild(status);
    var autos = bridge("beeflowAutomations");
    if (!autos || typeof autos.run !== "function") {
      btn.disabled = true;
      return show(status, "unavailable", SAY.unavailable);
    }
    function collect() {
      var out = {}, fields = el.querySelectorAll("input[name],select[name],textarea[name]");
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i], name = f.getAttribute("name");
        var type = String(f.getAttribute("type") || "").toLowerCase();
        if (!name) continue;
        if (type === "checkbox") out[name] = !!f.checked;
        else if (type === "radio") { if (f.checked) out[name] = f.value; }
        else out[name] = f.value;
      }
      return out;
    }
    var press = arming(btn, label, function () {
      btn.disabled = true;
      runAutomation(status, def, attrs, collect(), function () { btn.disabled = false; });
    });
    btn.addEventListener("click", function () { press(!!attrs.confirm); });
    el.addEventListener("keydown", function (e) {
      if (!e || e.key !== "Enter" || !e.target) return;
      if (String(e.target.tagName || "").toUpperCase() !== "INPUT") return;
      e.preventDefault();
      press(!!attrs.confirm);
    });
  }`;
}

/** Het gespreksblok: de agentische lus van de brug, ingebed in de pagina. */
function emitAgent() {
    return `
  function renderAgent(el, def, attrs) {
    var box = takeOver(el);
    var log = node("div", "bf-agent-log"), row = node("div", "bf-agent-row");
    var input = node("input", "bf-agent-input"), send = node("button", "bf-btn", SAY.send);
    var status = node("div", "bf-status");
    input.type = "text";
    if (attrs.placeholder) input.placeholder = attrs.placeholder;
    send.type = "button";
    row.appendChild(input);
    row.appendChild(send);
    box.appendChild(log);
    box.appendChild(row);
    box.appendChild(status);
    var ai = bridge("beeflowAI");
    if (!ai || typeof ai.ask !== "function") {
      input.disabled = true;
      send.disabled = true;
      return show(status, "unavailable", SAY.unavailable);
    }
    // Zonder attribuut is dit de agent van de PAGINA — de brug kiest hem, want
    // die kent de binding. Staat er wel een id, dan gaat het mee.
    var agentId = attrs[def.binding.from] || null;
    function busy(on) {
      input.disabled = on;
      send.disabled = on;
    }
    function ask() {
      var question = String(input.value || "").trim();
      if (!question) return;
      input.value = "";
      log.appendChild(node("div", "bf-agent-you", question));
      var answer = node("div", "bf-agent-bot", "");
      log.appendChild(answer);
      busy(true);
      show(status, "busy", SAY.asking);
      var opts = { onToken: function (t) { answer.textContent += String(t || ""); } };
      if (agentId) opts.agentId = agentId;
      ai.ask(question, opts).then(function (res) {
        if (!answer.textContent && res && res.text) answer.textContent = String(res.text);
        // Een leeg antwoord is een uitkomst, geen niets: zeg het.
        if (!answer.textContent) show(status, "empty", SAY.emptyAnswer);
        // Een AFGEKAPT antwoord ziet er precies zo betrouwbaar uit als een heel
        // antwoord — dezelfde fout die het getalelement bij een afgekapte
        // uitslag meldt.
        else if (res && res.truncated) show(status, "partial", SAY.partialAnswer);
        else clear(status);
        busy(false);
      }, function (err) {
        fail(status, err);
        busy(false);
      });
    }
    send.addEventListener("click", ask);
    input.addEventListener("keydown", function (e) {
      if (!e || e.key !== "Enter") return;
      e.preventDefault();
      ask();
    });
  }`;
}

/**
 * Het opzoeken en bijwerken van de elementen op de pagina, plus het venster
 * waarin een pagina kan vragen wat er hier van een element terechtkomt.
 */
function rendererTable() {
    // Uit CLIENT_HANDLING, niet uit een tweede lijst hieronder. De functienamen
    // volgen `rendererNameOf`; `clientCoverageGaps` toetst op de uitgezonden
    // brontekst dat elke naam er ook echt staat.
    return Object.keys(CLIENT_HANDLING)
        .map(local => `${local}: ${rendererNameOf(local)}`)
        .join(', ');
}

function emitBoot() {
    return `
  var RENDERERS = { ${rendererTable()} };
  function upgrade(el) {
    if (!el || el.nodeType !== 1 || el.getAttribute(READY)) return;
    el.setAttribute(READY, "1");
    var tag = String(el.tagName || "").toLowerCase();
    var def = BY_TAG[tag];
    // Onbekend is HERKENBAAR onbekend. Zonder dit blijft er niets staan: een
    // onbekend element is voor de browser een lege inline-doos.
    if (!def) return show(el, "unknown", SAY.unknown, tag);
    var render = RENDERERS[def.local];
    if (!render) return show(el, "unsupported", SAY.unsupported, tag);
    var attrs = readAttributes(def, el);
    var missing = missingAttributes(def, attrs);
    if (missing.length) return show(el, "invalid", SAY.invalid, missing.join(", "));
    var bad = badValues(def, attrs);
    if (bad.length) return show(el, "invalid", SAY.invalidValue, bad.join(", "));
    try { render(el, def, attrs); }
    catch (e) { show(el, "failed", SAY.failed, e && e.message); }
  }
  function isOurs(tag) { return String(tag || "").toLowerCase().indexOf(PREFIX) === 0; }
  function scan(root) {
    if (!root) return;
    if (root.nodeType === 1 && isOurs(root.tagName)) upgrade(root);
    if (!root.querySelectorAll) return;
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) if (isOurs(all[i].tagName)) upgrade(all[i]);
  }
  // Wat de PAGINA zelf later neerzet, telt ook mee. Zonder dit werkt een
  // element dat uit script.js komt nergens, en wel zonder één melding.
  function watch() {
    if (typeof MutationObserver !== "function") return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes || [];
        for (var j = 0; j < added.length; j++) scan(added[j]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  function start() {
    scan(document.body || document.documentElement);
    watch();
  }
  // Dezelfde vorm als de publieke brug, zodat een pagina op beide plekken met
  // dezelfde vraag kan uitvinden wat er van een element terechtkomt.
  window.beeflowBf = {
    elements: VOCAB,
    lookup: function (tag) { return this.elements[String(tag || "").toLowerCase()] || null; },
    state: function (tag) { var e = this.lookup(tag); return e ? e.state : "unknown"; },
    reason: function (tag) {
      var e = this.lookup(tag);
      if (e) return e.message || null;
      return "Unknown Bee Flow element " + String(tag || "");
    },
    refresh: function (root) { scan(root || document.body || document.documentElement); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();`;
}

/**
 * De stijl plus het script dat de elementen op de pagina tot leven brengt.
 *
 * Met opzet NIET achter dezelfde poort als de bruggen hierboven: zonder token
 * bestaan `beeflowTables` / `beeflowAutomations` / `beeflowAI` niet, en juist
 * dan moet elk element zeggen dat het zijn bron niet kan bereiken. Dit blok
 * definieert die bruggen nooit — het leest ze alleen op naam.
 */
export function buildBfElementsScript() {
    // De renderers eerst, dan pas het vocabulaire: de dekkingscontrole leest de
    // uitgezonden BRONTEKST, en wat er niet in staat mag geen 'live' beloven.
    const body = `${emitDom()}${emitAttributes()}${emitRows()}${emitTable()}${emitStat()}`
        + `${emitRunner()}${emitControls()}${emitAgent()}`;
    const gaps = clientCoverageGaps(body);
    if (gaps.missing.length || gaps.stray.length || gaps.unimplemented.length) {
        // Luid in de ontwikkelconsole, maar nooit fataal: een witte pagina is
        // een slechtere waarschuwing dan een melding op het element zelf, en
        // die melding komt er hoe dan ook (state 'unsupported').
        console.warn('[bfElements] de client bedient het vocabulaire niet volledig:', gaps);
    }
    return `${buildBfStyles()}<script>(function(){${emitVocabulary(gaps.unimplemented)}${body}${emitBoot()}
})();<\/script>`;
}

export default buildBfElementsScript;
