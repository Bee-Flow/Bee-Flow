/**
 * Builder tools — a name for an automation the model never named.
 *
 * builder_set_metadata is on every menu and every prompt now says to call it
 * in the first reply, and still a build can reach finalize — the model's own
 * or the route's auto-finalize — with `draftWrap.title` at its default. That
 * default, "Untitled automation", is then the name the person sees in every
 * list, on the playbook rail and in the activation e-mail. Before this the
 * only remedy was the person renaming it by hand.
 *
 * This is the deterministic fallback: a title read off the brief, else off
 * the definition, never a model call — on the single-slot local box a second
 * prompt would evict the builder's own cache entry, and six briefs in
 * scripts/builder-briefs/ make a pure function testable. The route calls
 * ensureDraftTitle before the finalize gate, before auto-finalize and once
 * after the loop; the finalize result then carries a `_hint` naming what was
 * done so the model (and the person) can rename.
 *
 * Rules, first match wins:
 *   (a) a title the brief STATES — `Title "…"`, `Titel "…"`, `Naam "…"`,
 *       `Name "…"`, `App name "…"` (the playbook briefs carry exactly this,
 *       playbooks/recipes/invoiceTracker.js) — as a statement, not as any
 *       "name" followed by a quote: `the sender name "From"` and `kolom naam
 *       "Leverancier"` are field names, not titles;
 *   (b) a markdown heading: its quoted part when it has one
 *       (`## Build an automation "Facturen goedkeuren"`), else the heading
 *       itself unless it is generic ("Build an automation");
 *   (c) the first sentence of ≥ 25 chars that is not trigger boilerplate
 *       ("I start it by hand: manual trigger…"), a leading imperative
 *       stripped ("Create an automation that …"), cut at a word boundary;
 *   (d) the definition: `<trigger>: <first step> → <last step>`;
 *   (e) 'New automation'.
 * Always ≤ 60 chars, never the default name.
 */

'use strict';

const UNTITLED_AUTOMATION = 'Untitled automation';
const MAX_TITLE = 60;

// (a) `Title "…"` in any of the four spellings, with an optional colon and
// straight, curly or single quotes, in STATEMENT position. `title`/`titel`
// is a statement wherever it stands ("give it the title "X""); `naam`/`name`
// only at the start of the brief, a line or a sentence (after . ! ? ;), or
// with a colon — mid-sentence it names a field ("the sender name "From"",
// "kolom naam "Leverancier"") and once naming the automation after that nothing
// downstream repairs it. A quoted title is ≥ 3 chars, and an apostrophe
// followed by a letter ("It's") is part of a single-quoted title rather than
// its end. Mirrored by the playbook's AutomationStage (agent-hub) so the seed
// title it sends is the one this would derive — deriveTitle.test.js pins the
// two sources equal.
const TITLE_IN_BRIEF_RE = /(?:\b(?:app\s+)?(?:title|titel)|(?:^|\n|[.!?;]\s+)\s*(?:[-*•]\s+)?(?:app\s+)?(?:naam|name)|\b(?:app\s+)?(?:naam|name)(?=\s*[:=]))\s*[:=]?\s*["“„'‘]((?:[^"”“'’\n]|['’](?=\w)){3,120})["”“'’](?!\w)/i;

// (b) headings that name the kind of work, not the work.
const GENERIC_HEADING_RE = /^(?:build|create|make|maak|bouw)\s+(?:an?|een|the|de)\s+(?:automation|routine|automatisering|app|flow|workflow)\b\s*$/i;
const QUOTED_RE = /["“„]([^"”“\n]{2,120})["”“]/;

// (c) sentences that describe how the automation STARTS, not what it does.
const BOILERPLATE_RE = /\b(?:met de hand|by hand|manual trigger|handmatig|no schedule|geen schema|start it by hand|die ik met|that I start)\b/i;
// A leading imperative that would make every title read "Create an automation
// that …": the verb + article + noun + relative pronoun, all optional pieces
// matched together. "Can you " / "Kun je " / "Please " are polite prefixes
// of the same kind.
const IMPERATIVE_RE = /^(?:(?:can|could|would) you\s+|kun je\s+|kunt u\s+|please\s+|graag\s+)?(?:(?:create|build|make|set up|maak|bouw|zet)\s+(?:an?|een|the|de|een nieuwe|a new)\s+(?:automation|routine|automatisering|flow|workflow)\s+(?:that|which|die|dat|to|om)\s+)?/i;
const POLITE_RE = /^(?:(?:can|could|would) you\s+|kun je\s+|kunt u\s+|please\s+|graag\s+)/i;

const KIND_LABELS = {
    manual: 'Manual', schedule: 'Scheduled', form: 'Form', webhook: 'Webhook',
    agent_call: 'Agent', app_trigger: 'App',
};

/** Cap at MAX_TITLE on a word boundary, with an ellipsis when cut. */
function clamp(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= MAX_TITLE) return s;
    const cut = s.slice(0, MAX_TITLE - 1);
    // A cut that lands exactly on a word boundary keeps the whole word.
    const at = s[MAX_TITLE - 1] === ' ' ? cut.length : cut.lastIndexOf(' ');
    return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[\s,;:—–-]+$/, '')}…`;
}

function capitalise(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The brief's own title, when it states one. */
function titleStatedIn(brief) {
    const m = TITLE_IN_BRIEF_RE.exec(brief);
    return m ? m[1].trim() : null;
}

/** The first heading worth naming the automation after. */
function titleFromHeading(brief) {
    for (const line of brief.split('\n')) {
        const m = /^\s*#{1,3}\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const heading = m[1].trim();
        const quoted = QUOTED_RE.exec(heading);
        if (quoted) return quoted[1].trim();
        if (GENERIC_HEADING_RE.test(heading)) continue;
        return heading;
    }
    return null;
}

/** The first sentence that says what the automation does. */
function titleFromSentence(brief) {
    const text = brief
        .split('\n').map(l => l.replace(/^\s*(?:#{1,3}\s+|[-*]\s+|\d+\.\s+)/, '')).join('\n')
        .replace(/\*\*/g, '');
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
    for (const raw of sentences) {
        if (BOILERPLATE_RE.test(raw)) continue;
        // A `Title "…"` line is rule (a)'s business; as a sentence it would
        // name the automation 'Title "…"'.
        if (TITLE_IN_BRIEF_RE.test(raw)) continue;
        let s = raw.replace(/[.!?:]+$/, '').trim();
        s = s.replace(IMPERATIVE_RE, '').replace(POLITE_RE, '').trim();
        if (s.length < 25) continue;
        return capitalise(s);
    }
    return null;
}

/** What a step is called: its label, its tool, its type. */
function stepName(step) {
    if (!step || typeof step !== 'object') return null;
    return [step.label, step.tool, step.type].find(v => typeof v === 'string' && v.trim()) || null;
}

/** `<trigger>: <first step> → <last step>` off the definition. */
function titleFromDefinition(def) {
    const trigger = def && def.trigger;
    if (!trigger) return null;
    const kind = trigger.kind === 'app_event' && trigger.appEvent
        ? `${trigger.appEvent.provider || 'app'} ${trigger.appEvent.event || 'event'}`
        : (KIND_LABELS[trigger.kind] || 'Automation');
    const steps = (Array.isArray(def.steps) ? def.steps : []).filter(s => s && s.type !== 'note');
    if (!steps.length) return null;
    const first = stepName(steps[0]);
    const last = steps.length > 1 ? stepName(steps[steps.length - 1]) : null;
    return `${kind}: ${first}${last ? ` → ${last}` : ''}`;
}

/**
 * @param {{ brief?: string, def?: object }} p
 * @returns {string} a title ≤ 60 chars, never the default name
 */
function deriveTitle({ brief, def } = {}) {
    const text = typeof brief === 'string' ? brief : '';
    const candidates = [
        () => titleStatedIn(text),
        () => titleFromHeading(text),
        () => titleFromSentence(text),
        () => titleFromDefinition(def),
        () => 'New automation',
    ];
    for (const pick of candidates) {
        const raw = pick();
        if (!raw) continue;
        const title = clamp(raw);
        if (title && title !== UNTITLED_AUTOMATION) return title;
    }
    return 'New automation';
}

/**
 * Name the draft when nobody did. Sets `draftWrap.title` only while it is
 * empty or the default, so a title builder_set_metadata chose always wins.
 * @returns {{ derived: boolean, title: string }}
 */
function ensureDraftTitle(draftWrap, { brief } = {}) {
    const current = typeof draftWrap.title === 'string' ? draftWrap.title.trim() : '';
    if (current && current !== UNTITLED_AUTOMATION) return { derived: false, title: current };
    const title = deriveTitle({ brief, def: draftWrap.def });
    draftWrap.title = title;
    return { derived: true, title };
}

module.exports = { deriveTitle, ensureDraftTitle, TITLE_IN_BRIEF_RE, UNTITLED_AUTOMATION, MAX_TITLE };
