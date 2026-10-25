/**
 * The `bf-*` vocabulary → STATIC HTML, for the public snapshot.
 *
 * ── WHY THIS IS A DIFFERENT PATH, AND NOT A VARIANT ────────────────────
 *
 * For a logged-in reader the page fetches its rows itself via
 * `window.beeflowTables` (routes/webpagesPreviewTables.js), as THAT VISITOR,
 * with their own grade. On `/w/<slug>` that mechanism does not exist: a public share is a script-free snapshot passed through DOMPurify, and the anonymous bridge only knows /ai/chat and /ai/stream. So there is nobody to read "as" and no JS to do it with.
 *
 * That is why the elements here are, at the moment of publishing, expanded ONCE into plain HTML — before DOMPurify, so that what remains is
 * ordinary markup and the `bf-*` element itself disappears.
 *
 * ── TWO KINDS OF ELEMENT, AND BOTH MUST LEAVE SOMETHING BEHIND ─────
 *
 * `VANILLA_HANDLING` below speaks for EVERY element, in two modes:
 *
 *   expand  — the element reads data (`bf-table`, `bf-stat`) and is rendered here to
 *             plain markup from `publicColumns`;
 *   inert   — the element needs JS (`bf-button`, `bf-form`, `bf-agent`)
 *             and no JS runs here. It is expanded into a block that SAYS ITSELF that it does not work in the published copy.
 *
 * That second mode is the whole reason this module is about more than tables. Without expanding,
 * DOMPurify silently unwraps an unknown element (`KEEP_CONTENT: true`, and `ADD_TAGS` contains only `iframe`): from
 * `<bf-button run="a1">Send</bf-button>` literally `Send` remains — the tag gone, the attributes gone, no warning, no trace. The reader then sees
 * a page where a button should have stood, without knowing that something is missing. If we keep the element and pass it through the sanitiser (via `ADD_TAGS`), there is a button that does nothing and does not say so. Both wrong, for the same reason: dead is allowed, silent is not.
 *
 * `assertCoversVocabulary` throws at REQUIRE time if an element is missing from the action table, and `assertHandlingIsWorkable` if a table entry cannot be made good (an `expand` without an expander, an `inert` without
 * text). So adding an element without deciding here stops the server from starting.
 *
 * ── THE GATE IS `publicColumns`, AND ONLY THAT ──────────────────────
 *
 * Not `columns`. `columns` says what the PAGE may read internally;
 * `publicColumns` says what may go outward, and the normaliser already trims that
 * to a subset of `columns`. Empty means NO column — there is deliberately no value that says "all" — so an author who has designated nothing publishes nothing. That is the default, and it should stay that way: an empty list must never come to mean "then all columns after all".
 *
 * That holds for `bf-stat` just as hard as for `bf-table`, and in two ways at once. A sum over a column not in `publicColumns` would still publish that column — summarised, but it is the same data — so that column must itself be listed. And a table with NO public column does not publish a `count` either: how many rows there are is a statement about that table, and about a table of which nothing is public we make no statements.
 *
 * The rows are read AS THE OWNER of the page. That is actually right here: publishing is an explicit act by the author, and what he publishes is an excerpt of data that he himself may see. An anonymous reader has no grade, so there is nothing else to ask. Precisely for that reason the gate is narrow: only the columns the author designated under "Make public".
 *
 * ── EVERYTHING THAT GOES WRONG RENDERS NOTHING ───────────────────────
 * Unbound, no public columns, no grade (any more), database down, or a table that does not fit in one read: in all those cases an empty block comes back, never the unprocessed element and never a broader answer than asked. "Unknown" narrows — and a number that covers half the rows is worse than no number.
 *
 * ── THE DEFINITION IS NOT STORED HERE ───────────────────────────────
 *
 * The tag names, the attributes (`source`, with `datatable` as the older spelling, `limit`, `agg`, …), the upper bound and the texts of the inert notices come from core/webpages/bfElements.js. This module deliberately keeps no copy of that: that is precisely the drift that W4 exists to prevent. See the header of that module for the four locks.
 *
 * ── THE NAME OF THIS FILE LAGS BEHIND ───────────────────────────────
 *
 * It is called `webpageBfTable` because `bf-table` landed in it first. It is by now the expander for the whole vocabulary; the file name was deliberately not changed, so that a rename is not interwoven with this step.
 */
'use strict';

const { JSDOM } = require('jsdom');

// As a namespace, not destructured: then one module is one point of contact and
// the call stays visible at the read site (and replaceable in a test).
const bridgeGrants = require('../stores/webpage/bridgeGrants');
const datatableAccess = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const bfElements = require('../core/webpages/bfElements');
const log = require('../telemetry/log');

/** The definitions this module is about. One place, not a second list. */
const TABLE = bfElements.getBfElement('bf-table');
const STAT = bfElements.getBfElement('bf-stat');

/**
 * What the VANILLA public snapshot does with each element of the vocabulary.
 *
 *   expand  — this module renders it here and now to static HTML from
 *             `publicColumns`;
 *   inert   — it needs JS and there is none here, so it is expanded into a block that itself reports that it does not work. The
 *             text of that notice is in the vocabulary
 *             (`surfaces.vanillaSnapshot.notice`), not here.
 *
 * There is no third mode. Every element in the registry ALREADY SPEAKS for
 * this place (`surfaces.vanillaSnapshot.state`), so "not yet handled" would here always be a contradiction with that statement — and precisely that contradiction is invisible in the output: the element is then not expanded, DOMPurify silently unwraps it, and the page is missing something without anyone noticing. `assertHandlingIsWorkable` therefore sets the table beside the registry and throws at require time on the slightest difference.
 */
const VANILLA_HANDLING = Object.freeze({
    'bf-table': 'expand',
    'bf-stat': 'expand',
    'bf-button': 'inert',
    'bf-form': 'inert',
    'bf-agent': 'inert',
});
bfElements.assertCoversVocabulary('services/webpageBfTable (vanilla snapshot)', VANILLA_HANDLING);

/** Upper bound per public table — a snapshot is a page, not an export. */
const PUBLIC_ROWS_MAX = bfElements.attributeSpec('bf-table', 'limit').max;
const PUBLIC_CELL_MAX = 500;

/**
 * How many rows a `bf-stat` adds up at most.
 *
 * There is (as yet) no `readAggregate` on datatableRuntime, so a sum is calculated over the rows that one read yields. `readRows` itself clamps on `ROWS_PAGE_MAX`, so asking further is pointless — and if the table does not fit in it, then NO number comes (`hasMore` → empty block). A number that covers the first 500 of 5000 rows is not "roughly right": it is wrong, and it looks exactly as reliable as a correct number.
 */
const PUBLIC_STAT_ROWS_MAX = STAT.reads.rowsMax;
if (PUBLIC_STAT_ROWS_MAX > datatableRuntime.ROWS_PAGE_MAX) {
    // Startup error, not a silent clamp: if the registry promises more rows than one
    // read delivers, `hasMore` is always true and this page never publishes a number again
    // — without anyone seeing why.
    throw new Error(`[WebpageBfTable] bf-stat vraagt ${PUBLIC_STAT_ROWS_MAX} rijen, maar één leesbeurt levert er `
        + `hoogstens ${datatableRuntime.ROWS_PAGE_MAX}.`);
}

/** The aggregations that `bf-stat` knows — from the vocabulary, not from a list here. */
const STAT_AGGREGATIONS = bfElements.attributeSpec('bf-stat', 'agg').values;

/** What gets disabled in an inert block: everything that looks operable. */
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
 * An empty block — what is there when there is nothing to show.
 *
 * The reason code does NOT go into the element. It used to stand here as
 * `data-bf-table="<reason>"`, and that survives the sanitiser: DOMPurify leaves `data-*` alone (`ALLOW_DATA_ATTR` is on, and SANITIZE_HTML_CONFIG in services/webpageSnapshot.js does not turn it off). The code therefore literally ended up in the stored bytes and could be read in the source on /w/<slug> — an anonymous visitor could tell 'unavailable' (the author may no longer read the table) and 'read-failed' (the database was down) apart, and saw 'empty' change as soon as the table got its first row, because the reconciler rewrites the snapshot on every table mutation.
 *
 * "Empty" and "unreadable" must stay distinct — that is why there are several codes — but on the ADMIN side, not in what goes outward. That is why the code now sits in the log and the block itself is the same for every reason.
 *
 * NOTE the difference with an INERT block below. An empty block belongs to an element that could have worked here but had nothing to show; that is a state of the DATA and not the anonymous reader's concern. An inert block belongs to an element that by definition does not work here; that is a property of the PUBLISHED COPY, and the reader must indeed see it.
 * @param {string} reason
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

/**
 * The `limit` of the element, clamped; missing or unreadable gives the maximum.
 * @param {{ [x: string]: string; }} attrs
 */
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
 * @param {string} source
 */
function gateFor(source, ctx) {
    const binding = ctx.bindings.find(b => b && b.datatableId === source) || null;
    // "We could not read the bindings" is something other than "this table is not
    // bound", even though the block is empty in both cases: the first is a fault you want to
    // see, the second a choice by the author.
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
 * Why a read failed, without the difference leaking outward.
 * Refused (access gone) and unreachable (database down) get a DIFFERENT code
 * — in the LOG, because the bytes are the same for both.
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
    // Attribute names (and the older spelling `datatable`) come from the
    // vocabulary, not from a second list here.
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
        // `out.columns` is the intersection with what the table still has, so a
        // column that has since been deleted yields no empty column header.
        return renderTable(document, { columns: out.columns, meta: resolved.meta, rows: out.rows });
    } catch (err) {
        return emptyBlock(document, TABLE, readFailureReason(err));
    }
}

/**
 * One number from a bound table.
 *
 * Only `count` touches no column; the other four do, and that column
 * must therefore itself be public. Non-numbers are skipped (an empty cell
 * is not zero), and if nothing remains, then no number — not a 0 that reads as a real answer.
 */
const AGGREGATIONS = Object.freeze({
    count: (rows) => rows.length,
    sum: (rows, numbers) => numbers.reduce((a, b) => a + b, 0),
    avg: (rows, numbers) => numbers.reduce((a, b) => a + b, 0) / numbers.length,
    min: (rows, numbers) => Math.min(...numbers),
    max: (rows, numbers) => Math.max(...numbers),
});

/**
 * Every aggregation that the vocabulary knows must have an implementation here.
 *
 * Without this check `AGGREGATIONS` was a SECOND list next to
 * `STAT_AGGREGATIONS`: a sixth aggregation in the registry then got through the gate (it is after all in `values`), fell through the floor here and became an empty block with the code 'no-number' — indistinguishable from "there was nothing to count". Two very different things, one empty block, one misleading log.
 * It is now a startup error, like the other two locks in this file.
 * @param {string[]} [declared]
 */
function assertAggregationsAreImplemented(declared = STAT_AGGREGATIONS, implemented = AGGREGATIONS) {
    const names = Object.keys(implemented);
    const missing = declared.filter(a => !names.includes(a));
    const stray = names.filter(a => !declared.includes(a));
    if (!missing.length && !stray.length) return true;
    /** @type {string[]} */
    const parts = [];
    if (missing.length) parts.push(`kent geen uitvoering voor ${missing.join(', ')}`);
    if (stray.length) parts.push(`voert ${stray.join(', ')} uit, en dat kent bf-stat niet`);
    throw new Error(`[WebpageBfTable] de aggregatietabel ${parts.join('; ')}.`);
}
assertAggregationsAreImplemented();

/**
 * @param {string} agg
 * @param {string} column
 */
function aggregate(agg, rows, column) {
    const fn = AGGREGATIONS[agg];
    // Cannot happen: the gate let through only declared aggregations, and
    // assertAggregationsAreImplemented threw at require time if one was missing.
    // But "unknown aggregation" must never become the same answer as "there was nothing to count".
    if (!fn) return null;
    if (agg === 'count') return fn(rows);
    /** @type {number[]} */
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
 * The number as text. Deliberately NOT `toLocaleString`: the server's language is not
 * the reader's language, and a snapshot that is written differently per environment makes the reconciler produce different bytes on every rewrite.
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
    // An aggregation the vocabulary does not know is not "then just count":
    // that would produce a different number than was asked for.
    if (!STAT_AGGREGATIONS.includes(eff.agg)) return emptyBlock(document, STAT, 'bad-agg');

    const gate = gateFor(eff.source, ctx);
    if (gate.reason) return emptyBlock(document, STAT, gate.reason);
    // THE GATE, second round. A sum over a column that is not public
    // publishes that column after all — summarised, but it is the same data.
    if (eff.agg !== 'count' && !gate.publicColumns.includes(eff.column)) {
        return emptyBlock(document, STAT, 'column-not-public');
    }

    try {
        const resolved = await datatableRuntime.resolveForPrincipal(eff.source, ctx.principal, { needed: 'viewer' });
        const out = await datatableRuntime.readRows(resolved, {
            allowColumns: gate.publicColumns,
            limit: PUBLIC_STAT_ROWS_MAX,
        });
        // If the table does not fit in one read, this number covers part
        // of the rows — and that is not visible from the number. Rather nothing.
        if (out.hasMore) return emptyBlock(document, STAT, 'too-many-rows');
        // The column still existed at binding time, but is no longer in the
        // table: `out.columns` is the intersection. Summing over `undefined` would
        // yield a 0 here that reads as a real answer.
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

/** The expanders, by tag name. Every `expand` in VANILLA_HANDLING must have one. */
const EXPANDERS = Object.freeze({
    [TABLE.tag]: renderTableElement,
    [STAT.tag]: renderStatElement,
});

// ── de elementen die hier niets kunnen, en dat tonen ──────────────────

/**
 * @param {Element} el
 * @param {HTMLDivElement} box
 */
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
 * The SHAPE of an inert element, per kind.
 *
 * Everything the author wrote inside the element stays — that is his — but
 * nothing of it may still look operable. An empty place and a lively-looking button
 * are both wrong; a visibly disabled button with a notice beneath it is the answer.
 *
 * Never a `<form>`: DOMPurify has `form` in FORBID_TAGS and
 * `KEEP_CONTENT` then leaves the fields standing — a half form without a button.
 */
const INERT_BODY = Object.freeze({
    'bf-button': (document, box, el, attrs) => {
        // The text INSIDE the element is the label for this kind, not markup.
        box.appendChild(disabledButton(document, attrs.label || (el.textContent || '').trim()));
    },
    'bf-form': (document, box, el, attrs) => {
        moveChildren(el, box);
        // Only a button if the author gave it a text; there is no
        // English default text to invent, and the notice already says so.
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
 * An element that can do nothing in the vanilla snapshot, VISIBLY disabled.
 *
 * The notice is the only text in this module that the READER gets to see, and
 * it is therefore not here but in the vocabulary — the same sentence the
 * public bridge shows on a react share.
 * @param {Document} document
 * @param {Element} el
 */
function inertBlock(document, def, el) {
    const box = document.createElement('div');
    // The tag name as a CSS class, just as with an expanded table: the author
    // wrote it himself, so it reveals nothing, and it is the only hook that his
    // own stylesheet has to recognise this block by.
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
 * What the REGISTRY says about this place → what this module must then do.
 *
 * The registry decides what remains of an element; this module carries that
 * out. That is why this is a translation table of two entries and not a second opinion:
 * "static here" means expand, "inert here" means a visibly disabled block. The two other states (`live`, `refused`) concern
 * other places; if one ever appears here, that is a startup error
 * and not silence.
 */
const REQUIRED_HANDLING = Object.freeze({ static: 'expand', inert: 'inert' });

/**
 * The action table must be WORKABLE, not just complete.
 *
 * Runs at require time, for the same reason as `assertCoversVocabulary`. Three
 * errors, all three invisible in the output and here all three a startup error:
 * an action that contradicts the registry (the element is then not
 * expanded and DOMPurify silently strips it), an `expand` without
 * an expander, and an `inert` without a notice.
 * @param {Readonly<{ 'bf-table': 'expand'; 'bf-stat': 'expand'; 'bf-button': 'inert'; 'bf-form': 'inert'; 'bf-agent': 'inert'; }>} [handling]
 */
function assertHandlingIsWorkable(handling = VANILLA_HANDLING, expanders = EXPANDERS, bodies = INERT_BODY) {
    /** @type {string[]} */
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
        // The mirror image of the expand side above. Without this rule
        // INERT_BODY was a SECOND, unchecked list: a new inert element
        // then got its notice but no SHAPE — no disabled button,
        // no disabled field — and nothing said that one should be there.
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
 * Closing `<bf-table … />`, because HTML does not do that.
 *
 * A custom element CANNOT be self-closing in HTML: the parser reads
 * `<bf-table source="t"/>` as an ordinary opening tag and puts the WHOLE rest of the document
 * inside it as children. `el.replaceWith(...)` then throws those children
 * away — so everything that came after the element disappeared from the published
 * page without one warning. With `<bf-form/>` the reverse happens and just as
 * wrongly: the whole page is pulled into the inert block and every form
 * element in it is disabled.
 *
 * `/>` is exactly the habit a language model brings from JSX, and the
 * builder prompt has actively told the model since W4 to write these
 * elements. That is why we repair the spelling instead of relying on it.
 *
 * Only `bf-*` opening tags, and the scanner respects quotation marks, so
 * `label="a/b"` gives no false closing.
 * @param {string} src
 */
function closeSelfClosingBfTags(src) {
    const re = new RegExp(bfElements.BF_TAG_SCAN.source, 'gi');
    let out = '';
    let last = 0;
    /** @type {RegExpExecArray | null} */
    let m;
    while ((m = re.exec(src)) !== null) {
        const tag = String(m[1] || '').toLowerCase();
        // Only elements we know: an unknown tag we leave untouched
        // (we cannot replace it honestly anyway) and it is reported separately.
        if (!bfElements.isKnownBfTag(tag)) continue;
        let i = m.index + m[0].length;
        /** @type {string | null} */
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

    // Make unknown `bf-*` elements AUDIBLE. DOMPurify strips an unknown
    // element without a single warning (KEEP_CONTENT: true, ADD_TAGS knows
    // only `iframe`), so `<bf-widget x="1">Click</bf-widget>` becomes literally
    // `Click` — tag gone, attributes gone, no trace. Whoever wants to know THAT something
    // unknown stood there must count them before this. Touching them we do not: what
    // we do not know, we cannot honestly replace either.
    const scan = bfElements.scanBfTags(src);
    for (const tag of scan.unknown) {
        log.warn('[WebpageBfTable] unknown bf-* element in a published page, it will be stripped silently:', tag);
    }

    // Goedkope uitweg: niets van ons, geen JSDOM, geen grant-lezing.
    if (!scan.known.length) return src;

    const dom = new JSDOM(closeSelfClosingBfTags(src));
    const { document } = dom.window;
    const selector = scan.known.join(',');
    // `<template>` counts. `querySelectorAll` does NOT look inside `template.content`
    // (that is its own document fragment), so an element in there was skipped here and
    // then vanished without trace in DOMPurify: the only case in which a KNOWN element went
    // as silently missing as an unknown one.
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
        for (const tpl of roots[i].querySelectorAll('template')) roots.push(tpl.content);
    }
    const elements = roots.flatMap(root => [...root.querySelectorAll(selector)]);
    if (!elements.length) return src;

    // The grants and the principal are only read when there really is an element that
    // needs data: a page with only a `bf-button` should not request any
    // table binding at all.
    const ctx = {
        webpageId, ownerId, loaded: false, bindings: [], principal: null,
        grantsUnreadable: false, principalUnreadable: false,
    };

    for (const el of elements) {
        const def = bfElements.getBfElement(el.tagName);
        // Cannot happen: querySelectorAll ran on exactly this list. But a
        // missing definition must never become a silent disappearance.
        if (!def) continue;
        // The action table IS the dispatch, not an explanation alongside it: that way
        // there can be no element that is marked "inert" and yet gets expanded
        // merely because an expander happens to exist for it.
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
        // NOT silently to "nothing bound". The reconciler rewrites the snapshot
        // on EVERY table mutation, so one database hiccup here would republish the page
        // with an empty table, and the only trace would say
        // 'not-bound' — indistinguishable from a page that never
        // had a binding. "Empty" and "unreadable" stay apart, on the
        // ADMIN side; the bytes that go outward are the same for both.
        log.error('[WebpageBfTable] could not read the page bindings:', err && /** @type {Error} */ (err).message);
        ctx.grantsUnreadable = true;
        grants = null;
    }
    ctx.bindings = (grants && Array.isArray(grants.tables)) ? grants.tables : [];
    // Eén principal voor alle elementen op de pagina; hij verandert niet tussen
    // twee elementen door.
    try { ctx.principal = await datatableAccess.resolveDatatablePrincipalForUser(ctx.ownerId); }
    catch (err) {
        log.error('[WebpageBfTable] could not resolve the reader:', err && /** @type {Error} */ (err).message);
        ctx.principalUnreadable = true;
        ctx.principal = null;
    }
    return ctx;
}

module.exports = {
    expandBfElements,
    PUBLIC_ROWS_MAX,
    PUBLIC_STAT_ROWS_MAX,
    // This place's decision about the whole vocabulary; the drift test sets
    // it beside core/webpages/bfElements.js.
    VANILLA_HANDLING,
    // test-only
    _closeSelfClosingBfTags: closeSelfClosingBfTags,
    _assertAggregationsAreImplemented: assertAggregationsAreImplemented,
    _cellText: cellText,
    _aggregate: aggregate,
    _assertHandlingIsWorkable: assertHandlingIsWorkable,
};

/**
 * The part of the DOM (jsdom) this module touches; the server has no DOM lib.
 * @typedef {{ firstChild: DomNode | null, textContent: string | null, tagName?: string, content?: DomNode,
 *   setAttribute(name: string, value: string): void, getAttribute(name: string): string | null,
 *   appendChild(node: DomNode): DomNode, replaceWith(node: DomNode): void,
 *   querySelectorAll(selector: string): Iterable<DomNode> }} DomNode
 * @typedef {{ createElement(tag: string): DomNode }} DomDocument
 * @typedef {{ webpageId?: string, ownerId?: string, loaded: boolean,
 *   bindings: import('../stores/webpage/bridgeGrants').TableGrant[],
 *   principal: import('../auth/datatableAccess').DatatablePrincipal | null,
 *   grantsUnreadable: boolean, principalUnreadable: boolean }} DataContext
 * @typedef {(document: DomDocument, box: DomNode, el: DomNode, attrs: Record<string, string>) => void} InertBody
 */
