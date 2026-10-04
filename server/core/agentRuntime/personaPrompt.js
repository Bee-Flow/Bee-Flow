'use strict';

/**
 * Persona — an agent's role as FIELDS, and the one place a system prompt is
 * rendered from them (A1c, PLAN.md "Gestructureerde rol").
 *
 * THE DIRECTION IS ONE-WAY, AND THAT IS THE DESIGN.
 * `agents.persona` is the source; `agents.system_prompt` is generated from it
 * on save (`renderSystemPrompt`). There is no lossless projection back — a
 * prompt a person edited by hand cannot be decomposed into these fields
 * without inventing something — so "back to fields" is an explicit AI parse
 * (`POST /agents/:id/persona/parse`), never a silent round trip. Two modes
 * carry that:
 *
 *   mode:'fields'  the fields are the truth; `system_prompt` is their rendering
 *                  and `freeText` is DROPPED (see below).
 *   mode:'free'    `freeText` is the truth and IS the system prompt; the fields
 *                  are shown read-only, as a description of what is there.
 *
 * WHY `freeText` IS DROPPED IN FIELDS MODE. A stored free text that nothing
 * renders is a second, silent copy of the agent's instructions: the owner
 * deletes a rule in the fields, the prompt loses it, and the copy sits in the
 * row waiting for the next switch to free mode to bring it back. One truth per
 * mode, or the mode means nothing.
 *
 * WHY THERE IS NO MIGRATION. An agent whose `persona` column is NULL — which
 * is every agent that existed before this — reads back as
 * `{mode:'free', freeText: system_prompt}` through `personaOf(row)`. That is
 * the documented migration, computed instead of written: no backfill pass over
 * live rows, no parse run against anyone's data, and an agent that is never
 * opened in the new editor is never touched at all.
 *
 * ONE REQUIRE, NEVER THROWS. This module is read on the concept path of every
 * agent load (`agentCrud.getAgent` / `getAgentViews`) and on the write path of
 * `PUT /agents/:id`. It pulls in no store, no registry and no clock, and every
 * exported function is total: an unreadable persona is an EMPTY persona, never
 * an exception in the middle of a save.
 *
 * The single import is `./agentGrounding`, which is itself dependency-free and
 * is there for exactly one reason: "does this agent have knowledge to fall back
 * on" is a question THREE screens ask (Studio's attention list, the overview
 * card's footer, and the knowledge gate below), and a second implementation of
 * it here is how those three start disagreeing about the same agent. See that
 * file's header.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. `applyPersonaToConfig` only ever adds — it
 * turns `strictKnowledge` ON, never off, and it appends to
 * `enabledIntegrations`, never subtracts. `persona` is not the only writer of
 * those keys (the old editor has its own toggles), and a derived value that
 * can also CLEAR one silently undoes a setting nobody pointed at. The one
 * asymmetric case is spelled out at the function.
 */

const { hasKnowledgeSource } = require('./agentGrounding');

// ── Enums the rest of the stack pins against ────────────────────────
const PERSONA_MODES = Object.freeze(['fields', 'free']);
const UNKNOWN_MODES = Object.freeze(['honest', 'web', 'handoff']);

/**
 * The tone vocabulary the editor offers. NOT a whitelist: a chip outside this
 * list is kept verbatim (clamped like any other text), because the chips are
 * the owner's own words about their own agent — there is nothing to protect
 * here, and dropping an unknown one would silently delete a choice the moment
 * the editor's list and this one drift apart.
 */
const TONE_CHIPS = Object.freeze([
    'friendly', 'formal', 'concise', 'thorough', 'warm', 'direct',
    'playful', 'neutral', 'encouraging', 'patient',
]);

/** The app that `unknown.mode:'web'` asks for. Matches `toolRegistry`'s id. */
const WEB_SEARCH_APP_ID = 'agent-search';

// Bounds. A persona is rendered into the system prompt of every turn and
// stored as JSONB; without caps one paste turns into a per-turn token bill and
// a row nobody can read back.
const LIMITS = Object.freeze({
    who: 600,
    toneText: 400,
    chip: 60,
    chips: 12,
    bullet: 300,
    bullets: 20,
    freeText: 20000,
    language: 16,
    automationId: 128,
});

/**
 * Language codes we can name without guessing. Anything else falls through to
 * `Intl.DisplayNames` and, failing that, is DROPPED — "Always write your
 * replies in xx-YY" is worse than no instruction at all.
 */
const LANGUAGE_NAMES = Object.freeze({
    en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish',
    it: 'Italian', pt: 'Portuguese', pl: 'Polish', da: 'Danish', sv: 'Swedish',
    nb: 'Norwegian', no: 'Norwegian', fi: 'Finnish', tr: 'Turkish', cs: 'Czech',
    ro: 'Romanian', hu: 'Hungarian', el: 'Greek', bg: 'Bulgarian', uk: 'Ukrainian',
    ru: 'Russian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
    id: 'Indonesian', hi: 'Hindi',
});

// Case-insensitive on purpose: BCP-47 spells the region in caps and plenty of
// clients send the whole tag that way ("NL-be", "EN-GB"). A code we refuse over
// its casing silently drops the owner's language line.
const LANGUAGE_CODE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function _plainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Text, clamped. Control characters go (a persona ends up inside a system
 * prompt; a stray carriage return or NUL there is noise at best).
 * `multiline:false` folds newlines into spaces so a bullet stays a bullet.
 */
function _text(value, max, { multiline = false } = {}) {
    if (typeof value !== 'string') return '';
    let s = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (!multiline) s = s.replace(/[\r\n]+/g, ' ');
    else s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/[ \t]+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trim() : s;
}

/** A bounded, de-duplicated list of short strings (bullets, chips). */
function _list(value, { max, itemMax }) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
        const s = _text(raw, itemMax);
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

/** The persona an unreadable value normalises to. Fresh object every call. */
function emptyPersona() {
    return {
        who: '',
        tone: { chips: [], text: '' },
        does: [],
        doesNot: [],
        unknown: { mode: 'honest', automationId: null },
        language: null,
        mode: 'fields',
        freeText: '',
    };
}

/**
 * A language code we can put a NAME to, or null.
 *
 * Unknown ⇒ null on purpose: `language` drives a literal prompt line, and a
 * line naming a language the model has to guess at is worse than the line not
 * being there. `Intl.DisplayNames` is tried second and wrapped — a Node build
 * without full ICU answers with the code itself, which we refuse.
 */
function languageNameOf(code) {
    if (typeof code !== 'string' || !code) return null;
    const norm = code.trim();
    if (!LANGUAGE_CODE_RE.test(norm)) return null;
    const base = norm.toLowerCase().split('-')[0];
    if (LANGUAGE_NAMES[base]) return LANGUAGE_NAMES[base];
    try {
        const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(base);
        if (typeof name === 'string' && name && name.toLowerCase() !== base) return name;
    } catch (_) { /* no ICU ⇒ no name ⇒ no line */ }
    return null;
}

/**
 * Clamp any value into a persona. Total: never throws, always returns the full
 * shape, and every field it cannot read comes back EMPTY rather than absent —
 * so no reader downstream has to defend against a half-persona.
 *
 * @param {*} raw
 * @returns {{persona: object, warnings: string[]}}
 */
function normalisePersona(raw) {
    const warnings = [];
    const persona = emptyPersona();
    let input = raw;
    if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch (_) { input = null; }
    }
    if (!_plainObject(input)) {
        if (raw !== undefined && raw !== null) warnings.push('persona: not an object — ignored');
        return { persona, warnings };
    }

    persona.who = _text(input.who, LIMITS.who);

    const tone = _plainObject(input.tone) ? input.tone : {};
    persona.tone = {
        chips: _list(tone.chips, { max: LIMITS.chips, itemMax: LIMITS.chip }),
        text: _text(tone.text, LIMITS.toneText),
    };

    persona.does = _list(input.does, { max: LIMITS.bullets, itemMax: LIMITS.bullet });
    persona.doesNot = _list(input.doesNot, { max: LIMITS.bullets, itemMax: LIMITS.bullet });

    // ── unknown ──
    // An unreadable or unknown mode lands on 'honest', which is the narrowest
    // of the three: it promises nothing and reaches for nothing. 'web' turns an
    // app on and 'handoff' hands an automation to the model, so neither may be
    // where a typo ends up.
    const unknown = _plainObject(input.unknown) ? input.unknown : {};
    const mode = UNKNOWN_MODES.includes(unknown.mode) ? unknown.mode : 'honest';
    const automationId = mode === 'handoff' ? _text(unknown.automationId, LIMITS.automationId) : '';
    persona.unknown = { mode, automationId: automationId || null };
    if (unknown.mode !== undefined && !UNKNOWN_MODES.includes(unknown.mode)) {
        warnings.push(`persona.unknown.mode: "${String(unknown.mode).slice(0, 40)}" is not one of ${UNKNOWN_MODES.join('/')} — using "honest"`);
    }
    if (mode === 'handoff' && !persona.unknown.automationId) {
        warnings.push('persona.unknown: "hand off" without an automation — the agent will say it does not know instead');
    }

    // ── language ──
    const langRaw = _text(input.language, LIMITS.language);
    persona.language = languageNameOf(langRaw) ? langRaw.trim() : null;
    if (langRaw && !persona.language) warnings.push(`persona.language: "${langRaw}" is not a language code we can name — dropped`);

    // ── mode / freeText ──
    persona.mode = PERSONA_MODES.includes(input.mode) ? input.mode : 'fields';
    if (input.mode !== undefined && !PERSONA_MODES.includes(input.mode)) {
        warnings.push(`persona.mode: "${String(input.mode).slice(0, 40)}" is not one of ${PERSONA_MODES.join('/')} — using "fields"`);
    }
    // See the header: in fields mode the free text is not kept.
    persona.freeText = persona.mode === 'free' ? _text(input.freeText, LIMITS.freeText, { multiline: true }) : '';

    return { persona, warnings };
}

/**
 * The persona of a stored agent ROW — the read projection, and the whole of
 * the "migration" for agents that predate the column.
 *
 * Two fallbacks, both to the row's own `system_prompt`:
 *   - `persona` IS NULL          ⇒ `{mode:'free', freeText: system_prompt}`
 *   - free mode with empty text  ⇒ same, so "free mode shows the live prompt"
 *                                  is true even for a row written by a client
 *                                  that sent the mode and forgot the text.
 *
 * Call it with the row whose `system_prompt` you want it to describe. The
 * runtime projection (`projectRuntime`) swaps in the PUBLISHED prompt, which is
 * why `getForRuntime` does not carry a persona at all: the concept persona
 * describes the concept prompt, and pairing it with the published one would be
 * a statement nobody checked.
 */
function personaOf(row) {
    let raw = row ? row.persona : null;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = null; } }
    // "Nothing readable in the column" and "free mode with an empty box" are
    // the same answer: the prompt is the only description of this agent there
    // is, so free mode over the prompt is the one true thing to say. Note that
    // a column holding JUNK lands here too — the fallback is what an
    // unreadable persona degrades to, never `mode:'fields'` over blank fields,
    // which would render an empty prompt on the next save.
    const readable = _plainObject(raw);
    const { persona } = normalisePersona(raw);
    if (!readable || (persona.mode === 'free' && !persona.freeText)) {
        persona.mode = 'free';
        persona.freeText = _text(row && row.system_prompt, LIMITS.freeText, { multiline: true });
    }
    return persona;
}

// ── Rendering ───────────────────────────────────────────────────────

const UNKNOWN_LINES = Object.freeze({
    honest: 'When you do not know the answer, or it is not in the material you have been given, say so plainly. Never guess, and never invent an answer.',
    web: 'When the answer is not in the material you have been given, search the web for it and name the source you used. If you still cannot find it, say so plainly rather than guessing.',
});

/**
 * Render a persona into a system prompt.
 *
 * `mode:'free'` returns the free text verbatim — it IS the prompt.
 *
 * @param {object} persona
 * @param {object} [opts]
 * @param {string} [opts.handoffLabel] The VERIFIED name of the hand-off
 *   automation. Without it a `handoff` persona renders the HONEST line instead:
 *   the caller is the only one that can check that the automation exists, is
 *   active and belongs to the agent's owner, and a prompt that tells the model
 *   to use an action it was never given is an instruction to hallucinate one.
 * @returns {string} '' when there is nothing to say — see the note at
 *   `renderedPromptFor` about what a caller must do with that.
 */
function renderSystemPrompt(persona, opts = {}) {
    const p = normalisePersona(persona).persona;
    if (p.mode === 'free') return p.freeText;

    const blocks = [];
    if (p.who) blocks.push(p.who);

    const toneBits = [];
    if (p.tone.chips.length > 0) toneBits.push(`Tone: ${p.tone.chips.join(', ')}.`);
    if (p.tone.text) toneBits.push(p.tone.text);
    if (toneBits.length > 0) blocks.push(toneBits.join(' '));

    if (p.does.length > 0) blocks.push(`What you do:\n${p.does.map(d => `- ${d}`).join('\n')}`);
    if (p.doesNot.length > 0) blocks.push(`What you never do:\n${p.doesNot.map(d => `- ${d}`).join('\n')}`);

    const label = _text(opts.handoffLabel, 120);
    if (p.unknown.mode === 'handoff' && label) {
        blocks.push(`When you cannot answer a question yourself, hand it over with the "${label}" action instead of guessing. Tell the user you are handing it over.`);
    } else if (p.unknown.mode === 'handoff') {
        // Unverified hand-off ⇒ the narrow line, not a promise.
        blocks.push(UNKNOWN_LINES.honest);
    } else {
        blocks.push(UNKNOWN_LINES[p.unknown.mode] || UNKNOWN_LINES.honest);
    }

    const langName = languageNameOf(p.language);
    if (langName) blocks.push(`Always write your replies in ${langName}, whatever language the question is in.`);

    // A persona with nothing in it renders to nothing. The default `unknown`
    // line and the language line alone are NOT a prompt — they would turn "I
    // filled in no fields" into an instruction set nobody wrote — so they only
    // ship alongside real content.
    //
    // AN EXPLICIT `unknown.mode` IS CONTENT. 'honest' is what an untouched
    // persona normalises to, so it proves nothing; 'web' and 'handoff' are
    // choices somebody made, and both of them have CONSEQUENCES the save
    // writes down (`applyPersonaToConfig` asks for the search app, or grants
    // the hand-off automation). Leaving them out of this test produced an agent
    // that was granted an automation, showed its name on a pill, and carried not
    // one word of instruction that ever mentioned it — the Role card promises
    // "It starts an automation you pick", and that promise has to reach the prompt.
    // Language stays out on purpose: it is set from the hero on any agent,
    // including one whose role nobody has written yet.
    const chose = p.unknown.mode !== 'honest';
    const hasContent = !!(p.who || p.tone.chips.length || p.tone.text
        || p.does.length || p.doesNot.length || chose);
    return hasContent ? blocks.join('\n\n') : '';
}

/**
 * The prompt a save should persist, or null for "leave the stored prompt
 * alone".
 *
 * NULL IS THE POINT. A persona that renders to nothing — every field cleared,
 * or a free mode with an empty box — is not a request to erase the agent's
 * instructions; it is a persona that is not a source yet. Returning '' here
 * would let one PUT carrying an empty persona object wipe a prompt the owner
 * spent an afternoon on, with the row's own version history as the only way
 * back. So the empty render narrows to "not my decision", and the caller keeps
 * what it already had.
 */
function renderedPromptFor(persona, opts = {}) {
    const rendered = renderSystemPrompt(persona, opts);
    return rendered ? rendered : null;
}

// ── Config side effects ─────────────────────────────────────────────

/**
 * Does this config name a KNOWLEDGE SOURCE — anything for "answer only from
 * your knowledge" to be about?
 *
 * THE RULE IS NOT HERE. `agentGrounding.hasKnowledgeSource` answers it, and it
 * is the same function Studio's attention list and the overview card's footer
 * reach for (through `groundedOn`). A copy in this file would be a second
 * implementation of a rule three screens read, and the first place that shows
 * is a card saying one thing while Studio says another about the same agent.
 *
 * What that function narrows to, and why it matters here: `config.knowledge_base_ids`
 * ONLY — not datatable grants and not the camelCase spelling. `knowledgeSearch.js`
 * builds the "KNOWLEDGE BASE RESULTS" section from that one key, so those two
 * shapes give an agent zero searched bases, and `strictKnowledge` on an agent
 * with no such section is an order to refuse EVERYTHING (see below). An
 * unreadable config counts as ABSENT, which is the honest reading for this one
 * question: the flag it guards is a behaviour, never a permission, so a config
 * we could not read must not be the thing that silently switches an agent to
 * refusing.
 */

/**
 * Fold a persona's `unknown.mode` into the agent CONFIG. Pure: it returns a new
 * config (or the same object when nothing changed) and never reads a store.
 *
 * ADDITIVE ONLY, in all three directions:
 *
 *   honest  → `strictKnowledge: true`, but ONLY for an agent that HAS a
 *             knowledge source. Never `false`: the old editor has its own
 *             "answer only from the knowledge base" toggle, and a derived value
 *             that can also clear it would silently undo a setting the owner
 *             made somewhere else. Switching a persona to 'web' turns the
 *             prompt line around; unticking strict mode stays a deliberate act.
 *
 *             THE KNOWLEDGE CHECK IS NOT A DETAIL. `strictKnowledge` is not a
 *             gentler version of the honest prompt line — `contextBuilder`
 *             turns it into a CRITICAL OPERATIONAL CONSTRAINT that overrides
 *             every other instruction and orders a refusal whenever there is no
 *             "KNOWLEDGE BASE RESULTS" section. On an agent with nothing linked
 *             there never is one, so the flag would not make it honest, it
 *             would make it answer nothing at all — and the wizard creates
 *             exactly that agent: fields, `honest`, no knowledge base yet.
 *             `knowledgeSearch.js` builds that section from
 *             `config.knowledge_base_ids` and nothing else, which is why a
 *             DATATABLE grant does not count as knowledge here even though it
 *             is a real source elsewhere: switching the flag on for a
 *             table-only agent would make it refuse questions its own table
 *             could answer. The honest LINE ships whenever the persona renders
 *             a prompt at all, so nothing about the agent's honesty depends on
 *             this flag.
 *   web     → `agent-search` appended to `enabledIntegrations`, and only when
 *             that key already holds an array. Creating the array would write
 *             an explicit one-app list onto a config that had none, which reads
 *             as "every other app off" to `isAppOn` — a wipe dressed up as an
 *             addition. The runtime still gates the app on credentials and
 *             entitlements, so this is a REQUEST for web search, not a grant of
 *             it.
 *   handoff → a grant for the hand-off automation in `config.tools.automations`,
 *             and only for an id the CALLER has verified (see `opts`). An
 *             existing grant is never rewritten — the owner's `confirm` there
 *             outranks this default.
 *
 * @param {object} config
 * @param {object} persona
 * @param {object} [opts]
 * @param {string|null} [opts.handoffAutomationId] The hand-off automation id AFTER
 *   the caller checked that it exists, is active and belongs to the agent's
 *   OWNER. Null/absent ⇒ no grant is written. There is no "unknown" case that
 *   writes one: this module cannot check, so it never assumes.
 * @returns {{config: object, warnings: string[]}}
 */
function applyPersonaToConfig(config, persona, opts = {}) {
    const warnings = [];
    if (!_plainObject(config)) return { config, warnings };
    const p = normalisePersona(persona).persona;
    if (p.mode === 'free') return { config, warnings };

    let out = config;
    const mode = p.unknown.mode;

    // No warning on the other branch, and that is deliberate. Nothing the owner
    // asked for goes missing: the honest LINE is rendered into the prompt
    // either way, and `strictKnowledge` is a derived convenience on top of it,
    // not the request itself. A warning here would also be read out loud —
    // `resolvePersonaWrite` turns any warning on a config-less save into "the
    // matching app/knowledge setting was not applied", and the editor renders
    // the count as "references couldn't be linked" on EVERY save — so an agent
    // that is behaving exactly as designed would nag once per keystroke.
    if (mode === 'honest' && out.strictKnowledge !== true && hasKnowledgeSource(out)) {
        out = { ...out, strictKnowledge: true };
        warnings.push('persona.unknown: "say I do not know" also switches this agent to answering only from its knowledge');
    }

    if (mode === 'web') {
        const apps = out.enabledIntegrations;
        if (Array.isArray(apps)) {
            if (!apps.includes(WEB_SEARCH_APP_ID)) {
                out = { ...out, enabledIntegrations: [...apps, WEB_SEARCH_APP_ID] };
                warnings.push(`persona.unknown: "search the web" switched the ${WEB_SEARCH_APP_ID} app on`);
            }
        } else {
            warnings.push(`persona.unknown: "search the web" needs the ${WEB_SEARCH_APP_ID} app — switch it on in Apps`);
        }
    }

    const handoffId = typeof opts.handoffAutomationId === 'string' && opts.handoffAutomationId
        ? opts.handoffAutomationId
        : null;
    if (mode === 'handoff' && handoffId) {
        const tools = _plainObject(out.tools) ? out.tools : {};
        const autos = _plainObject(tools.automations) ? tools.automations : {};
        if (!_plainObject(autos[handoffId])) {
            // `{confirm:'ask'}`, not `{}`. An empty grant means "run it the
            // moment the model asks", and nothing here knows what the automation
            // DOES — there is no automation-level effect classifier yet. Asking
            // is the only answer that is right whether the automation files a
            // ticket or mails a customer; the owner can relax it in the picker.
            out = {
                ...out,
                tools: { ...tools, automations: { ...autos, [handoffId]: { confirm: 'ask' } } },
            };
            warnings.push('persona.unknown: the hand-off automation is now the automation this agent may run — pick any others in Apps & actions');
        }
    }

    return { config: out, warnings };
}

module.exports = {
    PERSONA_MODES,
    UNKNOWN_MODES,
    TONE_CHIPS,
    LANGUAGE_NAMES,
    LIMITS,
    WEB_SEARCH_APP_ID,
    emptyPersona,
    languageNameOf,
    normalisePersona,
    personaOf,
    renderSystemPrompt,
    renderedPromptFor,
    applyPersonaToConfig,
};
