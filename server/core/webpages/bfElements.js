/**
 * bfElements — THE `bf-*` vocabulary. One list, three consumers.
 *
 * ── THE PROBLEM THIS MODULE EXISTS TO PREVENT ───────────────────────
 *
 * The vocabulary lives in THREE places:
 *
 *   1. the client        — agent-hub/src/utils/bfElements.js, the generated
 *      mirror from which composeWebpageDocument.js and buildWebpagePreview.js
 *      read: what the preview and a LOGGED-IN viewer see;
 *   2. the server twin   — services/publicBridgeScript.js, the bridge that is
 *      injected into a publicly shared react-mui page;
 *   3. the snapshot renderer — services/webpageSnapshot.js, which expands
 *      BEFORE DOMPurify (services/webpageBfTable.js does that for `bf-table` today).
 *
 * Two hand-kept lists drift apart. This is not theory here: on reactBundleServer.js
 * it has said "KEEP IN SYNC with buildWebpagePreview.js" for years, and precisely there
 * `window.beeflowAI` carries three names (`complete`/`ground`/
 * `generate`) that do not exist in the other two bridge files, while the four
 * names that ARE there (`chat`/`chatJSON`/`stream`/`ask`) are missing. A
 * comment line holds nothing back.
 *
 * ── WHY THIS VARIANT CANNOT QUIETLY DRIFT APART ─────────────────────
 *
 * Four locks, each in a different place:
 *
 *   (a) The two SERVER places cannot keep a copy. They `require` this
 *       module. The drift test moreover forbids any hand-written `bf-<name>`
 *       literal in those files outside the derived path, so that
 *       no second list CAN come into being.
 *   (b) The public bridge is DERIVED, not declared: it broadcasts what
 *       `publicShareVocabulary()` returns. Adding an element changes
 *       its output by itself — nothing can be forgotten.
 *   (c) The vanilla snapshot MUST decide. `assertCoversVocabulary()` throws at
 *       REQUIRE time if the action table of webpageBfTable.js misses a tag or
 *       names one that does not exist here. The server then does not start and every
 *       test that touches the path turns red. That is not a test you can
 *       forget to run.
 *   (d) The CLIENT mirror is generated. `renderClientMirror()` makes the block
 *       that literally belongs between the markers in agent-hub/src/utils/bfElements.js;
 *       the drift test compares that text character by character. A new element,
 *       a new attribute or a changed judgement changes that text, so the
 *       test is red until the block has been replaced — and the error message contains
 *       the text that must go in.
 *
 * WHAT THIS CAN PROVE: that all three places carry the same NAMES,
 * know the same attributes, and per place pronounce the same JUDGEMENT about what
 * remains of an element.
 *
 * WHAT THIS CANNOT PROVE: that three implementations BEHAVE the same. This module is a
 * data structure; whether the renderer that reads from it draws an inert button
 * must be proven by that renderer itself.
 *
 * ── THE RULE THAT PROTECTS ALL OF THIS ──────────────────────────────
 *
 * In the VANILLA public snapshot NO JS runs (services/webpageSnapshot.js
 * deliberately leaves out the js slot). Everything that needs JS is therefore dead there.
 * And "dead" must be VISIBLE, not silent: DOMPurify quietly unwraps an unknown element
 * (`KEEP_CONTENT: true`, and `ADD_TAGS` contains only `iframe`), so
 * `<bf-button action="a1">Send</bf-button>` becomes literally `Send` — the tag
 * gone, the attributes gone, no warning, no trace. That is precisely why
 * every element below carries a `notice`: the expander in the next step places
 * ordinary, visibly disabled HTML there BEFORE the sanitizer, so that after the
 * sanitizer there is plain markup that itself says it does not work.
 *
 * This module RENDERS NOTHING. It records what exists; the renderers read
 * from it.
 */

'use strict';

const { deepFreeze } = require('../../utils/deepFreeze');

/** Upper bound on the number of rows that a public table may show. */
const PUBLIC_ROWS_MAX = 100;

/**
 * How many rows a `bf-stat` adds up at most — the same at EVERY place.
 *
 * This number used to stand only on the server (`datatableRuntime.ROWS_PAGE_MAX`),
 * and the client asked for nothing: `/tables/:id/query` then fell back to its
 * own DEFAULT_LIMIT of 50. A `<bf-stat agg="sum">` therefore counted over 50 rows in
 * the preview and over 500 on the published page — two different numbers for the same
 * element, from two places that should precisely read from one
 * registry. That is why the number stands here.
 *
 * services/webpageBfTable.js checks at require time that it fits within
 * `datatableRuntime.ROWS_PAGE_MAX`; anything further asks for trouble.
 */
const STAT_ROWS_MAX = 500;

/** De vier plekken, met exact deze sleutels. */
const SURFACES = Object.freeze(['clientComposer', 'reactShare', 'vanillaSnapshot', 'headlessRender']);

/**
 * The states that an element can have at a place.
 *
 *   live     — the element works here: JS runs and the bridges are there;
 *   static   — it is expanded here server-side to plain HTML;
 *   inert    — it is there, but it does nothing, and that is visible;
 *   refused  — it is not served here at all, WITH a reason.
 */
const STATES = Object.freeze(['live', 'static', 'inert', 'refused']);

/** Only this form counts as a `bf-*` tag. */
const BF_TAG_PATTERN = /^bf-[a-z][a-z0-9-]*$/;

/**
 * How a `bf-*` element begins in markup. One group: the written name.
 *
 * Only the OPENING TAG: `</bf-table>` does not match, because `\s*` does not swallow
 * a slash. That is deliberate — whoever counts occurrences wants each element
 * once, not twice.
 *
 * Exported because `core/webpages/webpageBindings.js` uses it to look up the author's
 * markings. Do not copy this pattern there: how an element LOOKS in markup
 * belongs to the vocabulary just as much as what it is CALLED, and two patterns
 * drift apart just as hard as two lists.
 */
const BF_TAG_SCAN = /<\s*(bf-[a-z0-9-]*)/gi;

// ── THE VOCABULARY ───────────────────────────────────────────────────
//
// Fields per element:
//   tag         the tag name, lower case, always with the `bf-` prefix;
//   summary     one line of English — this is also what the model gets to read;
//   needsJs     does this element NEED JS to do something? If so, it can in the
//               vanilla snapshot by definition be nothing more than inert;
//   attributes  what it knows, what is required, and what it means;
//   binding     what it yields for the usage index: which table, which
//               automation, which agent — plus the gate that has to be passed through;
//   surfaces    per place: what remains of it, and why.
//
// Fields per place (`surfaces.<place>`):
//   state    one of STATES;
//   why      Dutch justification for DEVELOPERS. Stays on the server;
//   message  developer text for the CONSOLE, with the tag name in it — what
//            `beeflowBf.reason()` answers on a public share;
//   notice   the sentence that the READER sees on the page. English, without
//            tag names and without internal concepts. A refused or inert
//            element must carry one: without text the difference between
//            "this cannot work here" and "this is empty" is not visible, and precisely that
//            difference is the rule that W4 protects.
//
// Attribute fields:
//   name          canonical name;
//   required      mandatory — without this attribute the element makes no sense;
//   aliases       older/alternative spellings that translate to `name`;
//   means         English explanation in one line;
//   values        the allowed values (if it is a closed list);
//   default       what applies when the attribute is absent;
//   max           upper bound for a number;
//   requiredWhen  conditionally required: `{ attr, notOneOf }` means
//                 "required as soon as `attr` is something other than these values".

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
            // The same gate as bf-table, for the same reason: a sum over a column that
            // is not public would publish that column anyway.
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
                why: 'De stub-brug maakt van beeflowAutomations.run een weigering; een automatisering starten vanuit een '
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
            // Without an attribute it falls back to the agent of the PAGE. That is
            // not "no binding": the usage index must count that page agent.
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

// ── THE PROJECTION TO A PUBLIC SHARE ────────────────────────────────
//
// `publicShareVocabulary()` sends the vocabulary into the browser. What belongs in there
// and what does not is decided not by the bridge but by this table, and the table must be
// COMPLETE: `assertProjectionComplete()` throws at REQUIRE time as soon as a
// field is in neither column.
//
// Why both columns explicitly, and not "everything except"? Two dangers, and they point in opposite directions:
//
//   - "send everything unless held back" lets a new field slip unnoticed into the source
//     of a public page. `binding.gate` names internal gate paths; such a thing does not
//     belong there;
//   - "send nothing unless listed" lets a new field stay unnoticed on the server, and then the twin no longer carries
//     the same definition — precisely the drift that this module exists to prevent.
//
// With both columns explicit there is no silent third way: you must choose.
/**
 * The places where a BRIDGE broadcasts the judgement, and which must therefore be covered by
 * PUBLIC_SHARE_PROJECTION.
 *
 *   reactShare      — the publicly shared react-mui page;
 *   headlessRender  — the picture that the builder-AI gets of the page (services/webpageRender.js,
 *                     via the embedded stub bridge).
 *
 * `clientComposer` is not among them: that one reads the generated mirror, so the WHOLE
 * vocabulary goes there and there is nothing to project.
 * `vanillaSnapshot` is not either: no bridge runs there — the expander puts
 * plain HTML there.
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
 * Throws if a field from the vocabulary is in neither column of the
 * projection. Module level, so a new field added without deciding about it stops this
 * module — and with it the public bridge — from loading.
 *
 * @param {Array} [elements]  definitions to check. The default is the real
 *   vocabulary; a test passes an invented element to it, because the real one is frozen and
 *   so cannot be mutated.
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
        // Every place whose BRIDGE broadcasts the judgement. `clientComposer` goes
        // via the generated mirror and not via this projection.
        for (const surface of BRIDGE_SURFACES) {
            // A place about which this element says nothing at all is neither a crash nor
            // silence: it comes back below as undecided, with the same notice
            // as an undecided field.
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

/** Does this look like one of OUR elements? Says nothing about whether we know it. */
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

/** The canonical name for a written name, or `null` if we do not know it. */
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
 * The attributes of one element, by canonical name.
 *
 * @param {string} tag
 * @param {object|Function} source  a DOM element (`getAttribute`) or a
 *                                  plain object with the written names
 * @returns {Object<string,string>} only non-empty values, trimmed. An alias
 *                                  lands under its canonical name; an empty or
 *                                  missing value is simply absent.
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

/** Is this attribute required here, given what else is written? */
function isRequired(spec, effective) {
    if (spec.required === true) return true;
    const when = spec.requiredWhen;
    if (!when) return false;
    const value = effective[when.attr];
    if (value === undefined) return false;
    return !(when.notOneOf || []).includes(value);
}

/**
 * Which required attributes are missing? Canonical names, in vocabulary order.
 * An UNKNOWN element yields `null` — "we do not know" is something other than
 * "nothing is missing".
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
 * What this element yields for the usage index.
 *
 * @returns {{kind:string, id:(string|null), from:string, gate:string, fallback:(string|null)}|null}
 *   `null` if the element binds nothing or we do not know it. `id: null` with a
 *   `fallback` means: take what is in that field of the PAGE.
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
 * Everything you want to know about one element, in one answer.
 *
 * An unknown `bf-*` element comes back here as `{ known: false }` with a
 * `reason` — RECOGNIZABLY unknown, never an empty definition that presents itself as a known
 * element.
 */
function inspectBfElement(tag, source) {
    const name = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
    const def = getBfElement(name);
    if (!def) {
        return {
            tag: name,
            known: false,
            // Two kinds of "not ours": `<div>` is not a bf element, and
            // `<bf-widget>` does look like one but does not exist.
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
 * Which `bf-*` tags stand in this HTML — and which of them do we not know?
 *
 * This is the place that makes "quietly let through" impossible: DOMPurify unwraps an unknown element
 * without a single warning, so whoever wants to know THAT something unknown stood there must count it
 * beforehand.
 *
 * @returns {{found:string[], known:string[], unknown:string[]}} de-duplicated,
 *   lower case, in order of first occurrence.
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
 * THE BITE TEST. Throws if a consumer does not fully cover the vocabulary.
 *
 * Called at MODULE LEVEL by every server consumer, so adding an element without
 * recording a decision for it stops the module from loading. Both directions: a missing tag and a tag that does not exist here.
 *
 * @param {string} surface  who covers it — appears literally in the error message
 * @param {string[]|Object} handled  the tags that the consumer handles
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
 * The vocabulary as it applies to a PUBLIC react share.
 *
 * Derived, not declared: the public bridge broadcasts this literally, so a
 * new element — or a new ATTRIBUTE of an existing element — is in there
 * by itself. What does and does not go along is stated in PUBLIC_SHARE_PROJECTION, and
 * that table must be complete (see `assertProjectionComplete`).
 *
 * Each entry carries two texts, and that difference is the whole purpose:
 *
 *   message  developer text, with the tag name in it, for the console
 *            (`beeflowBf.reason()`);
 *   notice   the sentence that the READER sees in the element itself.
 *
 * Both are a refusal WITH a reason — the same rule as `beeflowTables`, which
 * on a share deliberately REFUSES instead of returning an empty list
 * ("no rows" ≠ "you cannot read a table here"). A refused element that
 * says nothing is indistinguishable from an empty element, and that is exactly
 * the difference W4 protects.
 *
 * @returns {Object<string, object>} tag → the projection. Nothing in this output
 *   is a reference to the frozen vocabulary: the bridge serializes it
 *   to JSON and the browser may do with it what it likes.
 */
function bridgeVocabulary(surface = 'reactShare') {
    if (!BRIDGE_SURFACES.includes(surface)) {
        // No silent fallback to reactShare: then a mistyped place would broadcast the
        // texts of a DIFFERENT place, and that is exactly the lie that
        // this module must prevent ("on a shared link" at a place that is
        // not a shared link).
        throw new Error(`[bfElements] ${surface} is geen brug-plek; ken er een in BRIDGE_SURFACES.`);
    }
    const project = (level, source) => {
        const out = {};
        for (const key of PUBLIC_SHARE_PROJECTION[level].ship) {
            // A field that this element does not have is simply absent — except for the
            // two texts below, which must always carry a statement.
            if (source[key] !== undefined) out[key] = source[key];
        }
        return out;
    };
    const out = {};
    for (const def of BF_ELEMENTS) {
        const entry = project('element', def);
        entry.attributes = def.attributes.map(a => project('attribute', a));
        Object.assign(entry, project('surface', def.surfaces[surface]));
        // Explicit `null` rather than "absent": the bridge must be able to see
        // that there is no text, and then fall back itself.
        if (entry.message === undefined) entry.message = null;
        if (entry.notice === undefined) entry.notice = null;
        out[def.tag] = entry;
    }
    return out;
}

/** The vocabulary of the PUBLIC react share. One place, with a name of its own. */
function publicShareVocabulary() {
    return bridgeVocabulary('reactShare');
}

/**
 * The vocabulary as prose, for the builder prompt.
 *
 * This too is derived: that way no FOURTH hand-kept list arises
 * in routes/ai/webpageChat.js, which today names no `bf-*` element at all and
 * therefore cannot suggest them either.
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

const CLIENT_MIRROR_BEGIN = '// >>> BF-ELEMENTS: BEGIN GENERATED MIRROR <<<';
const CLIENT_MIRROR_END = '// >>> BF-ELEMENTS: END GENERATED MIRROR <<<';

/**
 * The block that belongs literally between the markers in
 * agent-hub/src/utils/bfElements.js.
 *
 * The client is ESM frontend code outside the build of the server
 * modules; it cannot import this CommonJS module (the same reason why
 * publicBridgeScript.js and reactBundleServer.js keep their own copy
 * of the client bridge). A mirror is therefore unavoidable — but it is
 * GENERATED and compared character by character, not kept by hand
 * and checked by eye.
 */
function renderClientMirror() {
    return [
        CLIENT_MIRROR_BEGIN,
        '// Generated from server/core/webpages/bfElements.js — do NOT edit by',
        '// hand. bfElements.drift.test.js compares this block character by character',
        '// with renderClientMirror() and puts the replacement text in its failure message.',
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

/**
 * @typedef {object} BfAttribute
 * @property {string} name
 * @property {boolean} required
 * @property {string[]} [aliases]
 * @property {string} means
 * @property {string[]} [values]
 * @property {string} [default]
 * @property {number} [max]
 * @property {{ attr: string, notOneOf?: string[] }} [requiredWhen]
 */

/**
 * @typedef {object} BfSurface
 * @property {string} state
 * @property {string} why
 * @property {string} [message]
 * @property {string} [notice]
 */

/**
 * @typedef {object} BfBinding
 * @property {string} kind
 * @property {string} from
 * @property {string} gate
 * @property {string} [fallback]
 */

/**
 * @typedef {object} BfElement
 * @property {string} tag
 * @property {string} summary
 * @property {boolean} needsJs
 * @property {BfAttribute[]} attributes
 * @property {{ rowsMax: number }} [reads]
 * @property {BfBinding} [binding]
 * @property {Record<string, BfSurface>} surfaces
 */
