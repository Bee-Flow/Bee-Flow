/**
 * personaFacts: the FACTS behind the "Rol" tab (Agents artboard 1c, A3 part A),
 * separate from how they are drawn.
 *
 * Everything here is pure: in goes the stored `agents.persona` plus the raw automation
 * list, and out come FACTS, never sentences. The sentences are in the cards, because
 * that is where the literal `t()` keys live that the i18n guard reads. A reason for
 * something NOT to be allowed is therefore a CODE (`'not_owner'`), not text.
 *
 * ── THIS IS A MIRROR, AND THE MIRROR MUST MATCH ──────────────────
 * `server/core/agentRuntime/personaPrompt.js` normalises every persona again on save:
 * it truncates texts, deduplicates bullets case-insensitively, and throws away everything
 * above the twentieth bullet. This module does exactly the same before anything goes out
 * the door, for one reason: otherwise someone types a twenty-first line, sees it there,
 * saves, and it is gone without anything ever having been on the screen. If the server
 * deviates, then this module deviates along with it, not the other way round.
 *
 * ── THE TONE VALUES ARE PROMPT TEXT, NOT UI TEXT ─────────────────
 * `tone.chips` is rendered literally in the system prompt (`Tone: formal, friendly.`).
 * The VALUE must therefore be stable English. It must not move along with the interface
 * language, otherwise tomorrow there is a different instruction in the prompt because
 * someone set the interface to German, and "is this chip on?" no longer holds. The
 * LABEL does go through `t()`; that is in `ToneCard.jsx`.
 *
 * The first three values come from the vocabulary the server already knows
 * (`personaPrompt.TONE_CHIPS`); the last two do not, and that is allowed: that
 * vocabulary is explicitly NOT a whitelist, so an unknown chip stays verbatim. A chip
 * the owner typed himself (or that comes from the AI parse) therefore also belongs on
 * screen, and must not silently disappear.
 *
 * ── UNKNOWN IS NOT EMPTY, HERE TOO ──────────────────────────────
 * A `persona` we could not read is not "an agent without a role": the column is
 * STRIPPED on the list route (`agentCrud.parseConfig`), and `GET /agents/:id` only gives
 * it with `?draft=1` and edit rights. Hence `readable`, and hence the automation list
 * carries its own `READ` state: a failed read of `/api/automation` is not "this user
 * has no automations".
 */
import { isAgentCallable } from '../../../admin/Studio/SkillsStudio/skillModel';
import { READ } from '../canUse/canUseFacts';
import type { AutomationSummary, BulletRejection, HandoffRow, HandoffSelection, Persona } from './personaFacts.types';

export { READ };

export type { BulletRejection, HandoffRow, HandoffSelection, Persona } from './personaFacts.types';

/** Spiegel van personaPrompt.LIMITS. Boven deze grenzen knipt de server. */
export const PERSONA_LIMITS = Object.freeze({
    who: 600,
    toneText: 400,
    chip: 60,
    chips: 12,
    bullet: 300,
    bullets: 20,
    freeText: 20000,
});

/** Spiegel van personaPrompt.PERSONA_MODES / UNKNOWN_MODES. */
export const PERSONA_MODES: readonly unknown[] = Object.freeze(['fields', 'free']);
export const UNKNOWN_MODES: readonly unknown[] = Object.freeze(['honest', 'web', 'handoff']);

/**
 * De vijf toonchips die de kaart aanbiedt, in artboardvolgorde. Waarden, geen
 * labels — zie de kop.
 */
export const TONE_CHIPS = Object.freeze([
    'formal',
    'friendly',
    'concise',
    'amounts in euros',
    'Dutch unless asked otherwise',
]);

/** De chip die iets over TAAL zegt; botst met een harde `persona.language`. */
export const TONE_CHIP_LANGUAGE = 'Dutch unless asked otherwise';

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Text, truncated: mirror of `_text` in personaPrompt.js, including the removal of
 * control characters and the flattening of line endings in a single-line field.
 * Without that last part, one pasted paragraph in a bullet would show on screen
 * something different from what is stored.
 */
export function clampText(value: unknown, max: number, { multiline = false }: { multiline?: boolean } = {}): string {
    if (typeof value !== 'string') return '';
    let s = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    s = multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/[\r\n]+/g, ' ');
    s = s.replace(/[ \t]+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trim() : s;
}

/** Spiegel van `_list`: geknipt, leeg eruit, hoofdletter-ongevoelig ontdubbeld, gecapt. */
export function clampList(value: unknown, { max, itemMax }: { max: number; itemMax: number }): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of value) {
        const s = clampText(raw, itemMax);
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

/** De persona waar een onleesbare waarde op landt. Vers object per aanroep. */
export function emptyPersona(): Persona {
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
 * What is in the column, in full form.
 *
 * STRUCTURAL, not clamping, and that is a deliberate asymmetry with the server.
 * The server is the only writer of this column and normalises on EVERY save, so what
 * arrives here is already truncated and already deduplicated. Doing it again gains
 * nothing and costs something: `clampText` strips spaces, and a read function that
 * turns "hallo " into "hallo" while someone is typing pushes the cursor back.
 * Truncation is therefore done only where the user could lose something he typed
 * himself: at the bullets (`addBullet`, `editBullet`) and at the chips, plus
 * `maxLength` on the text boxes.
 *
 * What does happen here is NARROWING: an unknown `unknown.mode` becomes `'honest'`
 * (the narrowest: it promises nothing and grabs nothing), and an unknown `mode` becomes
 * `'fields'`, exactly as `normalisePersona` does on the server.
 *
 * `readable` is the answer to "was there something here that we could read", and NOT
 * to "is there something in the fields". An agent from before A1c has an empty persona
 * that IS read; a list row has NONE, because that route strips the column. Those two
 * must not produce the same screen.
 */
export function personaShape(raw: unknown): { persona: Persona; readable: boolean } {
    const persona = emptyPersona();
    let input = raw;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) { input = null; } }
    if (!isPlainObject(input)) return { persona, readable: false };

    persona.who = typeof input.who === 'string' ? input.who : '';

    const tone: Record<string, unknown> = isPlainObject(input.tone) ? input.tone : {};
    persona.tone = {
        chips: Array.isArray(tone.chips) ? tone.chips.filter(c => typeof c === 'string' && c) : [],
        text: typeof tone.text === 'string' ? tone.text : '',
    };

    // CLAMPED, unlike the text fields above. The reason is not the server
    // but the INDEX: `BulletsCard` draws this list and returns positions, while
    // `removeBullet`/`editBullet` work on the clamped list. If those were two different
    // lists, then line 3 on screen would point to line 2 in the mutation:
    // `removeBullet(['a','A','b'], 2)` would remove 'A' instead of 'b'. Reachable as soon
    // as something other than this card puts a list in the persona (a parse answer, a
    // refine merge, an import), so the two lists are one list here.
    persona.does = clampList(input.does, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });
    persona.doesNot = clampList(input.doesNot, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });

    const unknown: Record<string, unknown> = isPlainObject(input.unknown) ? input.unknown : {};
    const mode = UNKNOWN_MODES.includes(unknown.mode) ? unknown.mode as string : 'honest';
    const automationId = mode === 'handoff' ? clampText(unknown.automationId, 128) : '';
    persona.unknown = { mode, automationId: automationId || null };

    persona.language = typeof input.language === 'string' && input.language ? input.language : null;
    persona.mode = PERSONA_MODES.includes(input.mode) ? input.mode as string : 'fields';
    persona.freeText = persona.mode === 'free' && typeof input.freeText === 'string' ? input.freeText : '';

    return { persona, readable: true };
}

// ── Writing ───────────────────────────────────────────────────────
//
// Every helper returns a COMPLETE new persona, not a patch. The server reads a missing
// `persona` as "keep the column" (routes/agents/crud.js), so sending a half object
// would silently keep a field that someone had just emptied.

/** Een kopie van `persona` met `patch` erover, in de volle vorm. */
export function patchPersona(persona: unknown, patch: Record<string, unknown>): Persona {
    const base = personaShape(persona).persona;
    return personaShape({ ...base, ...patch }).persona;
}

/**
 * Zitten alle twaalf chipplaatsen vol? Boven de twaalfde gooit
 * `normalisePersona` de rest weg zonder iets te zeggen; de kaart schakelt de
 * uit-staande chips daarom uit in plaats van een klik te laten verdampen.
 */
export function toneChipsFull(persona: unknown): boolean {
    return personaShape(persona).persona.tone.chips.length >= PERSONA_LIMITS.chips;
}

/**
 * Turns one tone chip on or off. Switching off is always allowed; switching on is no
 * longer possible when the twelve are full. Then nothing happens, and `toneChipsFull`
 * makes sure that button is already off.
 */
export function toggleToneChip(persona: unknown, chip: unknown): Persona {
    const base = personaShape(persona).persona;
    const value = clampText(chip, PERSONA_LIMITS.chip);
    if (!value) return base;
    const on = base.tone.chips.some(c => c.toLowerCase() === value.toLowerCase());
    if (!on && base.tone.chips.length >= PERSONA_LIMITS.chips) return base;
    const chips = on
        ? base.tone.chips.filter(c => c.toLowerCase() !== value.toLowerCase())
        : [...base.tone.chips, value];
    return patchPersona(base, { tone: { ...base.tone, chips } });
}

/**
 * The chips as the card draws them: first the five that the card OFFERS, then whatever
 * the owner (or the AI parse) added himself. That second group must really be shown.
 * The server stores it verbatim and renders it in the prompt, so not drawing it would
 * hide the instruction.
 */
export function toneChipRows(persona: unknown): Array<{ value: string; on: boolean; offered: boolean }> {
    const base = personaShape(persona).persona;
    const on = new Set(base.tone.chips.map(c => c.toLowerCase()));
    const offered = TONE_CHIPS.map(value => ({ value, on: on.has(value.toLowerCase()), offered: true }));
    const known = new Set(TONE_CHIPS.map(c => c.toLowerCase()));
    const own = base.tone.chips
        .filter(c => !known.has(c.toLowerCase()))
        .map(value => ({ value, on: true, offered: false }));
    return [...offered, ...own];
}

/**
 * Does the language rule clash with the soft language chip?
 *
 * `persona.language` renders an ABSOLUTE rule ("Always write your replies in X,
 * whatever language the question is in", personaPrompt.js), and the chip says
 * "unless asked otherwise". If both are on, the prompt contains two instructions that
 * contradict each other, and nobody sees that: the language is in the hero and the
 * chip is here.
 */
export function toneLanguageClash(persona: unknown): boolean {
    const base = personaShape(persona).persona;
    if (!base.language) return false;
    return base.tone.chips.some(c => c.toLowerCase() === TONE_CHIP_LANGUAGE.toLowerCase());
}

/**
 * Adds a bullet. Returns `{list, rejected}`: `rejected` says WHY nothing changed, as a
 * code: `'empty'`, `'duplicate'` or `'full'`. The server silently throws all three
 * away; here the user hears it before he thinks it succeeded.
 */
export function addBullet(bullets: unknown, value: unknown): { list: string[]; rejected: BulletRejection } {
    const current = clampList(bullets, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });
    const text = clampText(value, PERSONA_LIMITS.bullet);
    if (!text) return { list: current, rejected: 'empty' };
    if (current.some(b => b.toLowerCase() === text.toLowerCase())) return { list: current, rejected: 'duplicate' };
    if (current.length >= PERSONA_LIMITS.bullets) return { list: current, rejected: 'full' };
    return { list: [...current, text], rejected: null };
}

/**
 * Replaces a bullet; making it empty removes it (as the server would truncate it away).
 * Same shape as `addBullet`: `{list, rejected}`.
 *
 * `'duplicate'` is the reason this function HAS a reason. Clamping after the
 * replacement deduplicates case-insensitively and keeps the first hit, so editing a
 * line to something already in the list let two in and one out: the line you were
 * editing was gone, without a single word on screen. That is exactly the silent
 * disappearance this card guards against, now done by the card itself. Now nothing
 * changes and the card says why.
 */
export function editBullet(bullets: unknown, index: number, value: unknown): { list: string[]; rejected: BulletRejection } {
    const current = clampList(bullets, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });
    if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { list: current, rejected: 'missing' };
    }
    const text = clampText(value, PERSONA_LIMITS.bullet);
    if (!text) {
        const next = current.slice();
        next.splice(index, 1);
        return { list: next, rejected: null };
    }
    const clash = current.findIndex(b => b.toLowerCase() === text.toLowerCase());
    if (clash !== -1 && clash !== index) return { list: current, rejected: 'duplicate' };
    const next = current.slice();
    next[index] = text;
    return { list: next, rejected: null };
}

/** Een bullet verwijderen. */
export function removeBullet(bullets: unknown, index: number): string[] {
    const current = clampList(bullets, { max: PERSONA_LIMITS.bullets, itemMax: PERSONA_LIMITS.bullet });
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return current;
    const next = current.slice();
    next.splice(index, 1);
    return next;
}

// ── De hand-off-automation ─────────────────────────────────────────────

/**
 * May this editor choose a hand-off automation?
 *
 * `verifyHandoffAutomation` (routes/agents/crud.js) checks the automation against
 * `agent.owner_id`, while `GET /api/automation` returns the automations of the
 * LOGGED-IN user. If an org admin edits someone else's agent, the picker therefore
 * shows automations that the server is guaranteed to refuse. Offering a choice that
 * surely fails is the silent form of doing nothing.
 *
 * Unknown narrows: without both ids we do not know whether this is the same person,
 * and then nothing is chosen.
 *
 * Returns `null` if choosing is allowed.
 */
export function handoffBlockedBecause({ agentOwnerId, userId }: { agentOwnerId?: unknown; userId?: unknown }): 'not_owner' | 'unknown_owner' | null {
    const owner = typeof agentOwnerId === 'string' && agentOwnerId ? agentOwnerId : null;
    const me = typeof userId === 'string' && userId ? userId : null;
    if (!owner || !me) return 'unknown_owner';
    return owner === me ? null : 'not_owner';
}

/**
 * The automations that qualify as hand-off.
 *
 * The gate is `trigger.kind === 'agent_call'`, the same one that `automationToTool`
 * (server/automation/agentCallableTools.js) applies, because that is the only kind the
 * runtime offers as an action. Switched-off automations are NOT filtered out but marked
 * (`active: false`): they stay in the user's list, the server refuses them, and hiding
 * them would only yield "where has my automation gone".
 *
 * `state` travels along, with one correction. A `READ.OK` with something that is NOT a
 * list is not an empty list but an UNREADABLE answer, and that becomes `READ.ERROR`
 * here. Without that narrowing, the card said "No automatisering can be started by an
 * agent yet" on exactly the input the defaults yield (`automations = null,
 * automationsState = READ.OK`), while `selectedHandoff` and `toolGrants.automationRows`
 * next to it read the same input as unreadable. One card contradicting itself is worse
 * than a card that says it does not know.
 */
export function handoffChoices({ automations, state = READ.OK }: { automations?: unknown; state?: string }): { rows: HandoffRow[]; state: string } {
    if (state !== READ.OK) return { rows: [], state };
    if (!Array.isArray(automations)) return { rows: [], state: READ.ERROR };
    const rows = automations
        .filter(a => a && typeof a.id === 'string' && a.id && isAgentCallable(a))
        .map(a => ({
            id: a.id,
            title: typeof a.title === 'string' && a.title
                ? a.title
                : (typeof a.name === 'string' && a.name ? a.name : null),
            active: a.isActive === true || a.is_active === true,
        }));
    return { rows, state };
}

/**
 * The chosen automation, as the card must draw it.
 *
 * Never `null` for a set id: an automation we cannot name is `readable: false` and
 * stays with its id. Leaving it out would claim there is no hand-off, while the server
 * can indeed verify it.
 */
export function selectedHandoff({ automations, state = READ.OK, automationId }: {
    automations?: unknown;
    state?: string;
    automationId?: unknown;
}): HandoffSelection | null {
    const id = clampText(automationId, 128);
    if (!id) return null;
    const index = state === READ.OK && Array.isArray(automations)
        ? new Map(automations.filter(a => a && typeof a.id === 'string').map((a): [string, AutomationSummary] => [a.id, a]))
        : null;
    const found = index ? index.get(id) : null;
    if (!found) return { id, title: null, readable: false, active: null, callable: null };
    return {
        id,
        title: typeof found.title === 'string' && found.title
            ? found.title
            : (typeof found.name === 'string' && found.name ? found.name : null),
        readable: true,
        active: found.isActive === true || found.is_active === true,
        callable: isAgentCallable(found),
    };
}
