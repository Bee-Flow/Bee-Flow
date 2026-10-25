/**
 * The Bee Flow elements as they work FOR THE READER.
 *
 * -- WHICH OF THE THREE PLACES THIS IS ------------------------------
 *
 * This is the CLIENT side: the preview in the app and a LOGGED-IN reader.
 * JavaScript does run there and the bridges exist, so here the elements
 * really work, unlike in the public snapshot, where no JS runs and everything
 * that needs JS is inert, and unlike on a public react share, where the
 * bridge refuses them. What remains of an element per place is stated in
 * server/core/webpages/bfElements.js; this file IMPLEMENTS the client side.
 *
 * -- THE VOCABULARY IS NOT HERE ---------------------------------------
 *
 * Not a single element name, attribute or upper bound is written down in
 * this file. Everything comes from ./bfElements.js, the generated mirror of
 * the registry. The emitted code does contain the names (they are in the
 * JSON passed in), but the SOURCE here does not: that is exactly the
 * difference between "derived" and "a second list", and a second list is
 * the drift W4 exists to prevent. A test in composeWebpageDocument.test.js
 * holds this file to that.
 *
 * What IS hand-written here is CLIENT_HANDLING: the decision this place
 * has to state about every element of the vocabulary, exactly as
 * VANILLA_HANDLING does in server/services/webpageBfTable.js. An element
 * the registry knows but that has no renderer here is not silent: it
 * counts as a gap (`clientCoverageGaps()`), it appears in `window.beeflowBf`
 * as "unsupported" instead of "live", and the reader gets a visible notice
 * on the page.
 *
 * -- FAILING MATTERS MORE THAN SUCCEEDING -----------------------------
 *
 * An element that cannot read its source must SHOW that. The reasons stay
 * apart, because they call for different behaviour from the reader:
 *
 *   unavailable  the bridge is not there (no preview token); this block is
 *                deliberately emitted even without a token, precisely to be
 *                able to say so instead of staying invisible;
 *   forbidden    the server said 401/403: you may not see this;
 *   gone         the server said 404: the source is no longer bound to
 *                this page;
 *   failed       everything else: something broke;
 *   empty        the read worked and there is nothing. That is NOT an error,
 *                and it must not look like one.
 *
 * On a public snapshot that reason deliberately does NOT go to the reader
 * (services/webpageBfTable.js explains why: an anonymous visitor must not
 * be able to tell "not allowed" from "broken"). Here the audience is
 * different: a logged-in reader or the author in their own preview, who
 * needs to know why nothing is shown.
 */

import { BF_ELEMENTS, type BfElementDef } from './bfElements';

/** The prefix of all elements; the rest of the name is the renderer key. */
const PREFIX = 'bf-';

/** The key under which an element finds its renderer: the name after the prefix. */
export function localNameOf(tag?: string | null): string {
    return String(tag || '').slice(PREFIX.length);
}

/**
 * What THIS place does with each element: the decision the client states.
 *
 *   live  - there is a renderer for it below, and it talks to the bridges.
 *
 * An element from the registry that is missing here is a GAP, not silence:
 * `clientCoverageGaps()` reports it, the test fails on it, `window.beeflowBf`
 * calls it "unsupported" and the reader gets a notice instead of an empty
 * spot. Whoever adds an element puts its key here.
 */
export const CLIENT_HANDLING: Readonly<Record<string, string>> = Object.freeze({
    table: 'live',
    stat: 'live',
    button: 'live',
    form: 'live',
    agent: 'live',
});

/**
 * The name of the render function that belongs to a key.
 *
 * The RENDERERS table in the emitted block is GENERATED from this, and the
 * coverage check then reads the emitted source text to see whether that
 * function really exists. Without that, RENDERERS was a second, hand-kept
 * list next to CLIENT_HANDLING: removing a key left the check green and
 * `window.beeflowBf` claiming "live" for an element that showed "unsupported"
 * on the page; the bridge was then lying to the page.
 */
function rendererNameOf(local?: string | null): string {
    return 'render' + String(local || '').charAt(0).toUpperCase() + String(local || '').slice(1);
}

/**
 * The two directions between the registry and the renderers above.
 *
 * @returns {{missing:string[], stray:string[]}} `missing`: in the vocabulary,
 *   but not served here. `stray`: served here, but the vocabulary does not
 *   know it (any more).
 */
export function clientCoverageGaps(body: string | null = null): { missing: string[]; stray: string[]; unimplemented: string[] } {
    const locals = BF_ELEMENTS.map((def: BfElementDef) => localNameOf(def.tag));
    const declared = Object.keys(CLIENT_HANDLING);
    // Third direction: declared, but there is no function for it in the
    // emitted code. Can only be checked on the SOURCE TEXT, because the
    // renderers only exist in the browser.
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
 * The vocabulary as the BROWSER needs it: only the fields the emitted code
 * does something with. The Dutch justifications (`why`) and the texts of the
 * other two places stay behind; they are none of a reader's page's business.
 */
function clientVocabulary(unimplemented: string[] = []) {
    return BF_ELEMENTS.map((def: BfElementDef) => {
        const local = localNameOf(def.tag);
        const served = !!CLIENT_HANDLING[local] && !unimplemented.includes(local);
        return {
            tag: def.tag,
            local,
            // No renderer => no 'live'. Better recognisably not served than
            // a promise this place does not keep. `served` also counts the
            // MISSING function, so the bridge cannot say "live" about
            // something the page shows as "unsupported".
            state: served ? def.surfaces.clientComposer.state : 'unsupported',
            needsJs: !!def.needsJs,
            // How many rows this element works with. From the registry, so the
            // preview yields the same number as the published page.
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

/** JSON that is safe inside an inline <script>. */
function jsonLiteral(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * The styling. A custom element is `display:inline` and empty by default,
 * exactly the invisibility being fought here, so everything first becomes a
 * block. Beyond that only neutral greys with transparency, so it is readable
 * on a light and a dark page, and the author can override it with their own
 * CSS (this style comes before theirs in the <head>).
 */
function buildBfStyles() {
    const selector = BF_ELEMENTS.map((def: BfElementDef) => def.tag).join(',');
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

/** The vocabulary, the bridge lookup and all sentences the reader can see. */
function emitVocabulary(unimplemented: string[] = []): string {
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
  // The bridges are READ by name and never defined here. This block is
  // also emitted when the shims above were missing (no token): precisely
  // then an element must say it cannot reach its source, instead of
  // staying invisible.
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

/** Building blocks for the DOM, and the distinction between the kinds of failure. */
function emitDom() {
    return `
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== null && text !== undefined) n.textContent = String(text);
    return n;
  }
  // What the AUTHOR wrote in the element stays theirs: the same rule as in
  // the two server places (inertBlock moves its children, bfDecorate leaves
  // them in place). They go into a block of their own once; afterwards we only
  // write in our OWN block next to it. Discarding was not allowed: with a typo
  // in an attribute the author's whole form markup vanished from the preview.
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
  // The element this hangs UNDER. A status line sits in a plain <div>,
  // but the state belongs on the bf element itself: that is what the
  // author's CSS targets, and where the public bridge puts it too.
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
    // Emptying also wipes the verdict: otherwise "loading" stays on an element
    // that by now simply shows its rows.
    mark(host, null);
  }
  // We take over: our output replaces what the author wrote as a fallback
  // (a "loading..." text, a button label). Hide, do not discard: as soon as
  // it goes wrong after all, their text comes back.
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
    // A notice is a FAILURE, not a render: what the author wrote
    // reappears (or stays), so their fallback text and their
    // fields are still there.
    own(host).hidden = false;
    // The state on the bf ELEMENT, even when this call concerns a status line
    // below it: the same place where the public bridge puts it, so CSS and
    // tests can ask the same thing in both places.
    mark(host, kind);
    box.appendChild(message(kind, text, detail));
  }
  // Keep the three kinds of failure apart. "Empty" NEVER passes through here:
  // it is not an error and must not look like one.
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
 * The attribute reader: the same rules as the server side (aliases, defaults,
 * conditionally required), but here over the same passed-in definitions.
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
  // A closed list of values is a promise: a value that is not in it
  // is reported, not silently set to the default.
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

/** The reading itself: one place the rows come from, for both readers. */
function emitRows() {
    return `
  // Reads AS THE VISITOR, with their own grade, and clipped to the columns
  // the author bound to this page. That is a different reader from the one
  // the public snapshot uses, deliberately.
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
      // An element without a limit attribute asked for nothing, so the server
      // picked its own default (50) while the published page reads 500:
      // two different numbers for the same element. The number now lives
      // in the registry and both places ask for it.
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

/** The table: rows as plain markup. */
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
        // The column must be BOUND. If it is not there, that means "you may
        // not see it", not zero.
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
      // A number over a TRUNCATED result is a wrong number. It must
      // never appear on the page without that notice.
      var partial = partialNotice(res, rows);
      if (partial) box.appendChild(partial);
    }, function (err) { fail(el, err); });
  }`;
}

/** Starting an automation, and confirming without a modal dialog. */
function emitRunner() {
    return `
  function runAutomation(host, def, attrs, inputs, done) {
    var autos = bridge("beeflowAutomations");
    if (!autos || typeof autos.run !== "function") { show(host, "unavailable", SAY.unavailable); return done(); }
    show(host, "busy", SAY.running);
    autos.run(attrs[def.binding.from], inputs || {}, { wait: true }).then(function (res) {
      // NOTE: this route answers 200 with a FAILED run in the body.
      // Whoever only looks at the HTTP status reports "succeeded" about
      // something that broke. Only 'success' without an error succeeded; everything
      // else is a visible state of its own.
      var status = (res && res.status) ? String(res.status) : "";
      if (res && res.error) show(host, "failed", SAY.runFailed, String(res.error));
      else if (status === "success") show(host, "done", SAY.done);
      else show(host, "pending", SAY.runPending, status);
      done();
    }, function (err) { fail(host, err); done(); });
  }
  // \`confirm\` is deliberately NOT window.confirm here: the preview runs in an
  // iframe with sandbox="allow-scripts allow-forms" and without allow-modals,
  // so the browser silently ignores confirm() and the button would never do
  // anything. Two clicks with a visible intermediate state works everywhere.
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

/** The two elements that MAKE SOMETHING HAPPEN: the button and the form. */
function emitControls() {
    return `
  function renderButton(el, def, attrs) {
    // For this kind the text INSIDE the element is the LABEL, not markup. Read
    // it before takeOver, because afterwards it is hidden.
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
    // The author's children STAY and stay VISIBLE: those are their
    // fields, not a fallback text. Only a button and a status line are
    // added. No real <form> element: with allow-forms an Enter would navigate
    // the whole frame away.
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

/** The conversation block: the bridge's agentic loop, embedded in the page. */
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
    // Without the attribute this is the PAGE's agent: the bridge picks it, as
    // it knows the binding. If an id is present, it is passed along.
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
        // An empty answer is an outcome, not nothing: say so.
        if (!answer.textContent) show(status, "empty", SAY.emptyAnswer);
        // A TRUNCATED answer looks exactly as reliable as a complete
        // one: the same fault the number element reports for a truncated
        // result.
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
 * Finding and updating the elements on the page, plus the window in which a
 * page can ask what becomes of an element here.
 */
function rendererTable() {
    // From CLIENT_HANDLING, not from a second list below. The function names
    // follow `rendererNameOf`; `clientCoverageGaps` checks against the emitted
    // source text that every name really exists.
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
    // Unknown is RECOGNISABLY unknown. Without this nothing is left: an
    // unknown element is an empty inline box to the browser.
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
  // What the PAGE itself inserts later counts too. Without this, an
  // element that comes from script.js works nowhere, and without a single notice.
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
  // The same shape as the public bridge, so a page can find out in both
  // places with the same question what becomes of an element.
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
 * The style plus the script that brings the elements on the page to life.
 *
 * Deliberately NOT behind the same gate as the bridges above: without a token
 * `beeflowTables` / `beeflowAutomations` / `beeflowAI` do not exist, and
 * precisely then every element must say it cannot reach its source. This
 * block never defines those bridges; it only reads them by name.
 */
export function buildBfElementsScript() {
    // The renderers first, only then the vocabulary: the coverage check reads the
    // emitted SOURCE TEXT, and what is not in it must not promise 'live'.
    const body = `${emitDom()}${emitAttributes()}${emitRows()}${emitTable()}${emitStat()}`
        + `${emitRunner()}${emitControls()}${emitAgent()}`;
    const gaps = clientCoverageGaps(body);
    if (gaps.missing.length || gaps.stray.length || gaps.unimplemented.length) {
        // Loud in the dev console, but never fatal: a white page is a worse
        // warning than a notice on the element itself, and that notice appears
        // anyway (state 'unsupported').
        console.warn('[bfElements] de client bedient het vocabulaire niet volledig:', gaps);
    }
    return `${buildBfStyles()}<script>(function(){${emitVocabulary(gaps.unimplemented)}${body}${emitBoot()}
})();<\/script>`;
}

