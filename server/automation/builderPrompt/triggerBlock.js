// @typecheck
/**
 * The `## Triggers` block of the LEAN system prompt.
 *
 * The app-event knowledge — which events exist, which filter keys each one
 * honours, what its payload carries — lived in ONE place for the small band:
 * the 12.5 kB prose of builder_propose_trigger's description (schemas.js).
 * The lean schema projection cuts that description to a paragraph, so the
 * knowledge moves here, in the shape a 3.8B-active model reads best: one line
 * per event family, keys in brackets, payload after an arrow, the one caution
 * that matters at the end.
 *
 * Two sources, deliberately:
 *   - event ids and payload fields come from the DECLARATIONS
 *     (triggerSources/declared/*.js via the global registry), so a renamed or
 *     removed event cannot survive here;
 *   - filter keys and cautions come from TRIGGER_PROMPT_NOTES (./triggerNotes.js), verified
 *     by hand against the matchers in triggerBus/filters.js and the pollers
 *     in triggerBus.js — the declarations do not carry filter keys, and the
 *     generic fallback matcher (exact equality on a payload field) is what an
 *     event without a custom matcher gets. triggerBlock.test.js pins every
 *     listed key to a `filter.<key>` read in one of those two files, so a
 *     key that stops being read stops being promised.
 *
 * GLOBAL registry only (listTriggerSources, never the per-org list): the
 * block sits in the system prompt, the front of the prompt cache on the
 * single-slot local box, and must be byte-identical across users and
 * sessions. Rendered once per process and memoised.
 *
 * The FULL band reads the same knowledge per user: renderAppEventProviderLines
 * renders the providers THIS user has (builderPickerCatalog's list) into the
 * "App events you may use" block of the per-turn message, with the extra
 * filter keys (`more`) and cautions (`fullNote`, PROVIDER_PROMPT_NOTES). It is
 * the only per-provider catalogue on that band: builder_propose_trigger's
 * description is one paragraph that points here, because a global catalogue
 * in a tool schema is ~16k characters of every provider on every turn for
 * every user. triggerBlock.test.js and builderTools/promptCatalogSync.test.js
 * check these lines.
 */

'use strict';

const { listTriggerSources, getEventDef } = require('../triggerSources');
const { pickMatcher } = require('../triggerBus/filters');
const { matchFilter } = require('../triggers/dslFilters');
const { PUSH_PENDING } = require('../deliverableEvents');

const { TRIGGER_PROMPT_NOTES, PROVIDER_PROMPT_NOTES } = require('./triggerNotes');

// The wording for the generic matcher: exact equality on a payload field.
const GENERIC_FILTER_TEXT = 'a payload field = exact value';

/**
 * Does this (provider, event) fall back to the shallow exact-match matcher?
 * @param {string} provider
 * @param {string} event
 */
function usesGenericMatcher(provider, event) {
    return pickMatcher(provider, event) === matchFilter;
}

/**
 * The declared, non-hidden events per non-hidden provider, registry order.
 * @returns {DeclaredEvent[]}
 */
function declaredEvents() {
    const out = [];
    for (const src of listTriggerSources({ includeHidden: false })) {
        for (const ev of (src.events || [])) {
            if (!ev || !ev.id || ev.hidden) continue;
            out.push({ provider: src.id, event: ev.id, fields: Array.isArray(ev.fields) ? ev.fields : [] });
        }
    }
    return out;
}

/**
 * The filter bracket for one line. The full detail adds the sidecar's `more`
 * keys (verified like the rest, see the test).
 * @param {string} provider
 * @param {string} event
 * @param {TriggerNote | undefined} note
 * @param {Detail} detail
 */
function renderFilters(provider, event, note, detail) {
    const base = note && Array.isArray(note.filters) ? note.filters : null;
    const keys = base && detail === 'full' && Array.isArray(note?.more) ? [...base, ...note.more] : base;
    if (keys && keys.length) return ` [${keys.join(', ')}]`;
    if (usesGenericMatcher(provider, event)) return ` [${GENERIC_FILTER_TEXT}]`;
    // A custom matcher this file has no verified notes for: say nothing
    // rather than guess a key.
    return '';
}

/** "resourceData.id" → "resourceData", "values (keyed …)" → "values". */
const bareField = (/** @type {string} */ f) => (/^[a-zA-Z_]+/.exec(f) || [''])[0];

/**
 * The payload arrow for one line: the sidecar's subset, else the declaration.
 * The full detail names every declared field (the subset first).
 * @param {DeclaredEvent} decl
 * @param {TriggerNote | undefined} note
 * @param {Detail} detail
 */
function renderFields(decl, note, detail) {
    let fields = note && Array.isArray(note.fields) && note.fields.length ? note.fields : decl.fields.slice(0, 8);
    if (detail === 'full') {
        const named = new Set(fields.map(bareField));
        fields = [...fields, ...decl.fields.filter(f => !named.has(bareField(f)))];
    }
    return fields.length ? ` → ${fields.join(', ')}` : '';
}

/**
 * @param {TriggerNote | undefined} note
 * @param {Detail} detail
 */
function renderNote(note, detail) {
    if (!note) return '';
    return [note.note, detail === 'full' ? note.fullNote : null].filter(Boolean).join(' ');
}

/** The sidecar entry that carries a group's filters, fields and note: its first member. */
function groupLead(/** @type {string} */ group) {
    const key = Object.keys(TRIGGER_PROMPT_NOTES).find(k => TRIGGER_PROMPT_NOTES[k].group === group);
    return key ? TRIGGER_PROMPT_NOTES[key] : undefined;
}

/**
 * One line per event (or per run of events sharing a sidecar `group`), and
 * the events nothing produces, which get no line of their own.
 * @param {DeclaredEvent[]} decls
 * @param {{ detail: Detail, lead: (provider: string) => string, skipBare?: boolean }} opts
 *   `lead` = the text before the event ids; `skipBare` drops a line that would
 *   say nothing but the id (an event with neither notes nor declared fields)
 * @returns {{ lines: string[], never: DeclaredEvent[] }}
 */
function renderEventLines(decls, { detail, lead, skipBare = false }) {
    /** @type {DeclaredEvent[]} */
    const never = [];
    /** @type {string[]} */
    const lines = [];
    // Group consecutive events that share a sidecar `group` onto one line —
    // the first member carries the filters/fields/note for all of them.
    /** @type {{ provider: string, group: string | null, events: string[], filters: string, fields: string, note: string } | null} */
    let open = null;
    const flush = () => {
        if (!open) return;
        const head = open.events.join(' / ');
        if (!(skipBare && !open.fields && !open.note)) {
            lines.push(`${lead(open.provider)}${head}${open.filters}${open.fields}${open.note ? ` — ${open.note}` : ''}`);
        }
        open = null;
    };
    for (const decl of decls) {
        const key = `${decl.provider}.${decl.event}`;
        if (PUSH_PENDING[decl.provider] && PUSH_PENDING[decl.provider].has(decl.event)) {
            // Declared, listed in the UI with its deliverability note, and
            // produced by nothing: the one event the model must be told NOT
            // to propose (the recorded builds proposed it twice).
            never.push(decl);
            continue;
        }
        const note = TRIGGER_PROMPT_NOTES[key];
        const group = note && note.group ? note.group : null;
        if (group && open && open.group === group && open.provider === decl.provider) {
            open.events.push(decl.event);
            continue;
        }
        flush();
        const entry = group ? groupLead(group) : note;
        open = {
            provider: decl.provider,
            group,
            events: [decl.event],
            filters: renderFilters(decl.provider, decl.event, entry, detail),
            fields: renderFields(decl, entry, detail),
            note: renderNote(entry, detail),
        };
        if (!group) flush();
    }
    flush();
    return { lines, never };
}

/** @type {string | null} */
let memo = null;

/**
 * The `## Triggers` block. Pure function of the global registry and the
 * sidecar; memoised so every session renders the same bytes at no cost.
 * @returns {string}
 */
function renderTriggerBlockLean() {
    if (memo !== null) return memo;
    const { lines, never } = renderEventLines(declaredEvents(), { detail: 'lean', lead: (provider) => `- ${provider}: ` });
    memo = [
        '## Triggers (builder_propose_trigger — the first call of a new draft)',
        '',
        'kind: manual | schedule {cron:"0 9 * * 1-5", tz} | form {form:{title, fields:[{name,type,label,required}]}} → trigger.output.<name> | webhook → trigger.output = the POSTed JSON | app_event {appProvider, appEvent, filter} | agent_call {toolName, description, params:[{name,type,required,description}]} | app_trigger {params:[{name,type,required}]}.',
        'An agent_call or app_trigger argument arrives as trigger.output.<name> (there is no trigger.payload): declare every argument the steps need, with a description the agent can read. After building an agent_call automation, tell the user to link it to an agent under "Who can call this" in the trigger panel: you cannot do that yourself.',
        'App events, as `appProvider: appEvent [filter keys] → payload fields` (bind them as trigger.output.<field>; an omitted filter = every event):',
        ...lines,
        ...(never.length ? [`NEVER propose ${never.map(d => `${d.provider} ${d.event}`).join(', ')} (nothing produces it).`] : []),
    ].join('\n');
    return memo;
}

// The per-user list's cap per provider: an auto-derived MCP provider can
// declare dozens of watchable list tools. catalogRender.test.js pins it (40
// shown, the rest counted).
const PROVIDER_EVENTS_CAP = 40;

/** @param {unknown} v @param {number} max */
const oneLine = (v, max) => {
    const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The lines of the per-user "App events you may use" block, for the providers
 * THIS user has (builderPickerCatalog.buildAppEventProvidersFor; an entry is
 * `{ id, label?, events: [{ id, deliverability? }] }`).
 *
 * Every band gets one header line per provider: `- <id> (<label>): <event>,
 * …`, the connector-dependent events marked. That is the whole render on the
 * 'lean' band, whose system prompt already carries the global `## Triggers`
 * block with every filter key and payload field (repeating them in the
 * per-turn message would be re-read on every turn on the local box).
 *
 * The 'full' band (the default: the cloud bands and the MCP guide) has no
 * other per-provider source (builder_propose_trigger's description points
 * here), so under each header it renders one line per event: the
 * filter keys the runtime reads (TRIGGER_PROMPT_NOTES `filters` + `more`),
 * every declared payload field, and the cautions (`note` + `fullNote`), then
 * the provider's PROVIDER_PROMPT_NOTES and the events nothing produces.
 * Field lists come from the declaration (getEventDef), so an org-scoped or
 * auto-derived provider gets its real payload too; an event with nothing to
 * say beyond its id gets no detail line.
 *
 * @param {AppEventProvider[]} providers
 * @param {{ band?: 'full' | 'lean' }} [opts]
 * @returns {string} the lines, joined by newlines ('' for no providers)
 */
function renderAppEventProviderLines(providers, { band = 'full' } = {}) {
    const list = Array.isArray(providers) ? providers.filter(p => p && p.id) : [];
    /** @type {string[]} */
    const out = [];
    if (band === 'full' && list.length) {
        out.push('Under each provider, one line per event: `event [filter keys] → payload fields — caution`. Use only the filter keys listed (an omitted filter = every event) and bind the payload as trigger.output.<field>; never add a search step for data the payload already has.');
    }
    for (const p of list) {
        const events = (Array.isArray(p.events) ? p.events : []).filter(e => e && e.id);
        const shown = events.slice(0, PROVIDER_EVENTS_CAP);
        const more = events.length - shown.length;
        const ids = shown.map(e => `${e.id}${e.deliverability === 'connector' ? ' [needs the connector]' : ''}`);
        out.push(`- ${p.id} (${oneLine(p.label || p.id, 40)}): ${ids.join(', ')}${more > 0 ? `, …and ${more} more events` : ''}`);
        if (band !== 'full') continue;
        const decls = shown.map(e => {
            const def = getEventDef(p.id, e.id);
            return { provider: p.id, event: e.id, fields: def && Array.isArray(def.fields) ? def.fields : [] };
        });
        const { lines, never } = renderEventLines(decls, { detail: 'full', lead: () => '  - ', skipBare: true });
        out.push(...lines);
        if (PROVIDER_PROMPT_NOTES[p.id]) out.push(`  ${PROVIDER_PROMPT_NOTES[p.id]}`);
        if (never.length) out.push(`  NEVER propose ${never.map(d => d.event).join(', ')} (nothing produces it, so it would never fire).`);
    }
    return out.join('\n');
}

module.exports = {
    renderTriggerBlockLean,
    renderAppEventProviderLines,
    TRIGGER_PROMPT_NOTES,
    PROVIDER_PROMPT_NOTES,
    GENERIC_FILTER_TEXT,
    // Test seams.
    _declaredEvents: declaredEvents,
    _usesGenericMatcher: usesGenericMatcher,
};

/** @typedef {'lean' | 'full'} Detail */

/** @typedef {import('./triggerNotes').TriggerNote} TriggerNote */

/** @typedef {{ provider: string, event: string, fields: string[] }} DeclaredEvent */

/** @typedef {{ id: string, label?: string, events?: Array<{ id: string, deliverability?: string }> }} AppEventProvider */
