import { Code, Loader2, PenLine } from 'lucide-react';
import React from 'react';
import BulletsCard from './BulletsCard';
import {
    READ, addBullet, editBullet, patchPersona, personaShape, removeBullet, toggleToneChip, type Persona,
} from './personaFacts';
import RoleCard, { RoleNote } from './RoleCard';
import ToneCard from './ToneCard';
import UnknownCard from './UnknownCard';
import WhoCard from './WhoCard';
import type { TranslateFn } from '../../../../hooks/useTranslation';

/**
 * The five cards of the "Rol" tab (Agents artboard 1c, A3 part A): the first
 * writer of `agents.persona` on the client side.
 *
 * CONTROLLED, NO OWN STATE: a persona comes in, a COMPLETE new persona goes out via
 * `onChange`. The parent holds it in `stateRef.current.persona` and lets the autosave
 * send it along. Half objects are impossible here, and that is deliberate:
 * `PUT /agents/:id` reads a MISSING field as "keep the column", so a patch with only `who`
 * in it would silently put back a bullet that someone had just removed.
 *
 * ── THREE STATES, THREE SCREENS ──────────────────────────────────
 *   not read yet       one line, no cards. Drawing five empty boxes while the read
 *                      is still running is a claim.
 *   not readable       a warning. `GET /agents/:id` only returns the persona with
 *                      `?draft=1` AND edit rights; otherwise `parseConfig`/`_stripPersona`
 *                      strip the column out. "Absent" here therefore means UNKNOWN,
 *                      and unknown is not an empty role.
 *   `mode: 'free'`     the five cards are there, but read-only. The free text IS the
 *                      prompt; these fields describe it. The way back is an explicit
 *                      AI parse (`POST /agents/:id/persona/parse`), never a silent
 *                      back-translation, which is why the button only appears if the
 *                      parent passes a handler for it.
 */

/** De strook onder de kaarten: overstappen naar één vrije instructie. */
function FreeFooter({ t, onOpenFree }: { t: TranslateFn; onOpenFree: () => void }) {
    return (
        <div
            data-testid="agent-role-free-footer"
            className="sm:col-span-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-secondary)]"
        >
            <Code size={13} aria-hidden="true" className="flex-shrink-0" />
            <span>{t('agent_studio.role.free_footer', 'Rather write it all as one text?')}</span>
            <button
                type="button"
                data-testid="agent-role-free-open"
                onClick={onOpenFree}
                className="font-medium text-[var(--text-primary)] underline hover:opacity-80"
            >
                {t('agent_studio.role.free_footer_action', 'Open as free instruction')}
            </button>
            {/* The artboard says here "the boxes stay in sync". That is
                not true: the direction is one way (fields → prompt), and back
                only happens via an explicit parse. See personaPrompt.js. */}
            <span className="text-[var(--text-tertiary)]">
                {t('agent_studio.role.free_footer_note', 'That text becomes what the agent runs; these fields stay behind as a description of it, and reading them back is a separate step.')}
            </span>
        </div>
    );
}

/**
 * The banner above the cards when the agent is in free mode.
 *
 * TWO SENTENCES, AND THE DIFFERENCE IS THE MAJORITY CASE. "The fields describe
 * it" is true for an agent that was once written in fields and then moved to free
 * text. For EVERY agent from before A1c it is not true: `personaOf` returns
 * `{mode:'free', freeText: system_prompt}` there with ALL fields empty, and then
 * there was a banner saying the boxes describe it, above five cards that say
 * "Nothing written down yet.", about an agent that demonstrably has a role, a tone
 * and rules. Those fields are not EMPTY but NOT YET DERIVED, and the derivation is
 * the explicit parse that the button next to it is for.
 */
function FreeBanner({ t, onBackToFields, describes }: { t: TranslateFn; onBackToFields: (() => void) | null; describes: boolean }) {
    return (
        <div
            data-testid="agent-role-free-banner"
            data-describes={describes ? 'yes' : 'no'}
            className="sm:col-span-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-secondary)]"
        >
            <PenLine size={13} aria-hidden="true" className="flex-shrink-0" />
            <span>{describes
                ? t('agent_studio.role.free_banner', 'This agent is written as one free instruction, and that text is what it runs. The fields below describe it — changing them here does nothing until it goes back to fields.')
                : t('agent_studio.role.free_banner_underived', 'This agent is written as one free instruction, and that text is what it runs. Nothing has been read back out of it yet, so the empty fields below say nothing about the agent.')}</span>
            {onBackToFields && (
                <button
                    type="button"
                    data-testid="agent-role-back-to-fields"
                    onClick={onBackToFields}
                    className="font-medium text-[var(--text-primary)] underline hover:opacity-80"
                >
                    {t('agent_studio.role.free_back_action', 'Read the instruction back into fields')}
                </button>
            )}
        </div>
    );
}

/** Not read yet / not readable: never five empty cards. */
function RoleUnknown({ t, state }: { t: TranslateFn; state: string }) {
    if (state === READ.LOADING) {
        return (
            <div aria-live="polite" data-testid="agent-role-loading" className="flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                <span>{t('agent_studio.role.persona_loading', 'Reading the role of this agent…')}</span>
            </div>
        );
    }
    return (
        <RoleCard testId="agent-role-unreadable" title={t('agent_studio.role.persona_title', 'Role')}>
            <RoleNote tone="warn" testId="agent-role-unreadable-note">
                {t('agent_studio.role.persona_unreadable', 'The role of this agent could not be read here, so these fields are not shown. That is not the same as the agent having no role.')}
            </RoleNote>
        </RoleCard>
    );
}

/**
 * Which of the three screens this becomes.
 *
 * THE PERSONA WINS FROM THE STATE. If `personaState === READ.ERROR` came before
 * the readability test, a role we DID have disappeared as soon as the second read
 * (`GET /agents/:id?draft=1`) failed, while the caller composes
 * `persona={agent?.persona ?? conceptFacts.persona}` and that first half can
 * perfectly well be readable. Showing a role that was read is never wrong.
 *
 * And the other way round: if there is NOTHING readable, that is "unknown", not
 * "empty". `READ.OK` with a stripped column should give the same warning as
 * `READ.ERROR`, because in both cases we do not know. Only LOADING gets its own
 * screen, because there an answer is still on its way.
 */
function roleScreen({ readable, personaState }: { readable: boolean; personaState: string }): 'cards' | 'loading' | 'unreadable' {
    if (readable) return 'cards';
    return personaState === READ.LOADING ? 'loading' : 'unreadable';
}

export default function RoleCards({
    t,
    persona,
    personaState = READ.OK,
    onChange,
    readOnly = false,
    automations = null,
    automationsState = READ.OK,
    agentOwnerId = null,
    userId = null,
    onOpenFree = null,
    onBackToFields = null,
}: {
    t: TranslateFn;
    persona?: unknown;
    personaState?: string;
    onChange?: (next: Persona) => void;
    readOnly?: boolean;
    automations?: unknown;
    automationsState?: string;
    agentOwnerId?: string | null;
    userId?: string | null;
    onOpenFree?: (() => void) | null;
    onBackToFields?: (() => void) | null;
}) {
    const { persona: p, readable } = personaShape(persona);
    const screen = roleScreen({ readable, personaState });
    if (screen === 'loading') return <RoleUnknown t={t} state={READ.LOADING} />;
    if (screen === 'unreadable') return <RoleUnknown t={t} state={READ.ERROR} />;

    const free = p.mode === 'free';
    const ro = readOnly || free;
    const write = (next: Persona) => onChange?.(next);
    const addTo = (field: 'does' | 'doesNot') => (text: string) => {
        const { list, rejected } = addBullet(p[field], text);
        if (!rejected) write(patchPersona(p, { [field]: list }));
        return rejected;
    };
    // Passes the refusal code on to the card. An edit that silently
    // does nothing is worse than an edit that says why.
    const editIn = (field: 'does' | 'doesNot') => (i: number, text: string) => {
        const { list, rejected } = editBullet(p[field], i, text);
        if (!rejected) write(patchPersona(p, { [field]: list }));
        return rejected;
    };
    const removeFrom = (field: 'does' | 'doesNot') => (i: number) => write(patchPersona(p, { [field]: removeBullet(p[field], i) }));
    // Is the banner telling the truth? Only if there is actually something in the fields.
    const describes = !!(p.who || p.tone.chips.length || p.tone.text || p.does.length || p.doesNot.length);

    return (
        <div data-testid="agent-role-cards" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {free && <FreeBanner t={t} onBackToFields={onBackToFields} describes={describes} />}

            <WhoCard t={t} value={p.who} readOnly={ro} onChange={(v) => write(patchPersona(p, { who: v }))} />

            <ToneCard
                t={t}
                persona={p}
                readOnly={ro}
                onToggleChip={(chip) => write(toggleToneChip(p, chip))}
                onChangeText={(v) => write(patchPersona(p, { tone: { ...p.tone, text: v } }))}
            />

            <BulletsCard
                t={t} variant="does" items={p.does} readOnly={ro}
                onAdd={addTo('does')} onEdit={editIn('does')} onRemove={removeFrom('does')}
            />
            <BulletsCard
                t={t} variant="doesNot" items={p.doesNot} readOnly={ro}
                onAdd={addTo('doesNot')} onEdit={editIn('doesNot')} onRemove={removeFrom('doesNot')}
            />

            <UnknownCard
                t={t}
                persona={p}
                readOnly={ro}
                automations={automations}
                automationsState={automationsState}
                agentOwnerId={agentOwnerId}
                userId={userId}
                onChangeMode={(mode) => write(patchPersona(p, {
                    unknown: { mode, automationId: mode === 'handoff' ? p.unknown.automationId : null },
                }))}
                onChangeHandoff={(id) => write(patchPersona(p, {
                    unknown: { mode: 'handoff', automationId: id || null },
                }))}
            />

            {!ro && onOpenFree && <FreeFooter t={t} onOpenFree={onOpenFree} />}
        </div>
    );
}
