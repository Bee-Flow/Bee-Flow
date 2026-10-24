import { Ban, Globe, Hand, HandHelping, Loader2, Workflow } from 'lucide-react';
import React from 'react';
import { READ, handoffBlockedBecause, handoffChoices, selectedHandoff, type HandoffRow, type HandoffSelection, type Persona } from './personaFacts';
import RoleCard, { RoleEmpty, RoleNote } from './RoleCard';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import ChoiceCards from '../../../shared/ChoiceCards';
import type { TranslateFn } from '../../../../hooks/useTranslation';

/**
 * "If it does not know": what happens outside the knowledge (Agents artboard 1c).
 *
 * Three choices, and this is the place where `shared/ChoiceCards` DOES belong: exactly
 * one of the three applies at a time, so an ARIA radiogroup tells the truth.
 * Until now there was one `Toggle` here on `strictKnowledge`, with a comment that
 * the other two choices did not exist yet. They have existed since A1c
 * (`personaPrompt.UNKNOWN_MODES`), and this is the card that offers them.
 *
 * ── THE ROUTINE PICKER IS THE HARD HALF ──────────────────────────
 * `verifyHandoffAutomation` (server/routes/agents/crud.js) accepts an automation only
 * if it exists, belongs to the OWNER of the agent, is switched on, and has an
 * `agent_call` trigger. The latter is checked via `automationToTool`, which yields
 * the exact tool name the runtime offers. Anything that does not come through that
 * chain is thrown away, not stored and ignored, and the prompt falls back to the
 * honest rule.
 *
 * This card mirrors that chain in advance, with one hard rule: a list that could not
 * be read is NOT "no automations". `GET /api/automation` sits behind the automations
 * module and can 403 or fall over; landing on an empty list would let the card claim
 * that this user has nothing to hand over. Hence the `READ` state, and hence the four
 * branches (loading, error, empty, choices) are in one `aria-live` block: the same
 * pattern as `Datatables/DatatablesStudio.jsx`.
 */

/** Why one may not choose, as a sentence. Literal t() calls for the i18n guard. */
function blockedMessage(t: TranslateFn, code: string | null) {
    if (code === 'not_owner') {
        return t('agent_studio.role.handoff_not_owner', 'This agent belongs to someone else. The hand-off automation is checked against its owner, not against you, so an automation of yours would be refused when it saves.');
    }
    if (code === 'unknown_owner') {
        return t('agent_studio.role.handoff_unknown_owner', 'Who owns this agent is not known here, and the automation is checked against the owner — so no automation can be picked yet.');
    }
    return null;
}

/** De pil die de gekozen automatisering toont — of zegt dat hij niet te lezen was. */
function HandoffPill({ t, chosen }: { t: TranslateFn; chosen: HandoffSelection | null }) {
    if (!chosen) {
        return (
            <RoleNote tone="warn" testId="agent-role-handoff-none">
                {t('agent_studio.role.handoff_none', 'No automation picked, so the agent says it does not know instead of handing the question over.')}
            </RoleNote>
        );
    }
    return (
        <div className="flex flex-col gap-1">
            <span
                data-testid="agent-role-handoff-pill"
                className="self-start inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-semibold [background:color-mix(in_srgb,var(--type-trigger)_14%,transparent)] [color:var(--type-trigger)]!"
            >
                <Workflow size={11} aria-hidden="true" />
                {chosen.title || chosen.id}
            </span>
            {!chosen.readable && (
                <RoleNote tone="warn" testId="agent-role-handoff-unreadable">
                    {t('agent_studio.role.handoff_unreadable', 'This automation could not be read here, so its name is missing — it has not gone away.')}
                </RoleNote>
            )}
            {chosen.readable && chosen.active === false && (
                <RoleNote tone="warn" testId="agent-role-handoff-inactive">
                    {t('agent_studio.role.handoff_off', 'This automation is switched off. Until it is on again the agent says it does not know instead.')}
                </RoleNote>
            )}
            {chosen.readable && chosen.callable === false && (
                <RoleNote tone="warn" testId="agent-role-handoff-not-callable">
                    {t('agent_studio.role.handoff_not_callable', 'This automation no longer starts on an agent call, so the agent is never offered it.')}
                </RoleNote>
            )}
        </div>
    );
}

/**
 * The five branches loading, error, blocked, none/all-off, choices, in one
 * aria-live block.
 *
 * "NONE" AND "ALL OFF" ARE TWO SENTENCES. They collapsed on
 * `offered.length === 0`, and then the screen named the TRIGGER as the reason while
 * the trigger was actually correct. It also put "2 automatiseringen are switched off"
 * one line lower, which said the opposite. The owner was thus sent to adjust a trigger
 * that was already fine, instead of to the on/off switch.
 */
function HandoffChooser({ t, rows, state, blocked, value, onChange, readOnly }: {
    t: TranslateFn;
    rows: HandoffRow[];
    state: string;
    blocked: string | null;
    value: string | null;
    onChange?: (id: string | null) => void;
    readOnly: boolean;
}) {
    const offered = rows.filter(r => r.active);
    const switchedOff = rows.length - offered.length;
    const message = blockedMessage(t, blocked);
    // Only next to a filled picker: if EVERYTHING is off, the branch above already
    // says that, and saying it twice is once too often.
    const showSwitchedOff = state === READ.OK && !message && offered.length > 0 && switchedOff > 0;

    return (
        <div aria-live="polite" className="flex flex-col gap-1.5">
            {state === READ.LOADING ? (
                <p data-testid="agent-role-handoff-loading" className="flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)] m-0">
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                    <span>{t('agent_studio.role.handoff_loading', 'Looking up which automations this agent could hand off to…')}</span>
                </p>
            ) : state === READ.ERROR ? (
                <RoleNote tone="warn" announce={false} testId="agent-role-handoff-unreadable-list">
                    {t('agent_studio.role.handoff_list_unreadable', 'The automations could not be read, so which one this agent may hand off to is unknown — this is not the same as having none.')}
                </RoleNote>
            ) : message ? (
                <RoleNote tone="warn" announce={false} testId="agent-role-handoff-blocked">{message}</RoleNote>
            ) : rows.length === 0 ? (
                <RoleEmpty testId="agent-role-handoff-empty">
                    {t('agent_studio.role.handoff_empty', 'No automation can be started by an agent yet — an automation only qualifies once its trigger is an agent call.')}
                </RoleEmpty>
            ) : offered.length === 0 ? (
                <RoleNote tone="warn" announce={false} testId="agent-role-handoff-all-off">
                    {nOf(
                        t, 'agent_studio.role.handoff_all_off', rows.length,
                        'The one automation an agent could start is switched off, so there is nothing to hand over to. Switch it back on first.',
                        'All {count} automations an agent could start are switched off, so there is nothing to hand over to. Switch one back on first.',
                    )}
                </RoleNote>
            ) : (
                <label className="flex flex-col gap-1 text-[12px] text-[var(--text-tertiary)]">
                    <span>{t('agent_studio.role.handoff_pick', 'Automation to hand the question to')}</span>
                    <select
                        data-testid="agent-role-handoff-select"
                        value={value || ''}
                        disabled={readOnly}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange?.(e.target.value || null)}
                        className="bg-[var(--bg-secondary)]/60 border border-[var(--border-default)] rounded-lg px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none disabled:opacity-60"
                    >
                        <option value="">{t('agent_studio.role.handoff_pick_none', 'No automation')}</option>
                        {offered.map(r => (
                            <option key={r.id} value={r.id}>{r.title || r.id}</option>
                        ))}
                    </select>
                </label>
            )}
            {/* `!message`: the count comes from `GET /api/automation`, and that is
                the list of the LOGGED-IN user. On someone else's agent it would
                thus be read as a fact about THAT agent. */}
            {showSwitchedOff && (
                <RoleNote announce={false} testId="agent-role-handoff-switched-off">
                    {nOf(
                        t, 'agent_studio.role.handoff_switched_off', switchedOff,
                        '{count} automation is switched off and is not offered here.',
                        '{count} automations are switched off and are not offered here.',
                    )}
                </RoleNote>
            )}
        </div>
    );
}

/** De drie keuzes. Losse functie zodat de kaart zelf kort blijft. */
function unknownOptions(t: TranslateFn) {
    return [
        {
            value: 'honest',
            Icon: Ban,
            label: t('agent_studio.role.unknown_honest', 'Say honestly that it does not know'),
            // "kennisbank", not "kennis". The strict setting that may be applied here
            // relies on the KNOWLEDGE BASE RESULTS section, and the server builds that
            // only from `config.knowledge_base_ids`; a table grant yields none. If the
            // sentence promised "kennis", a table agent would read here that it will
            // neatly answer from its table, while it would in fact refuse everything.
            description: t('agent_studio.role.unknown_honest_desc', 'It says so plainly instead of guessing. On an agent with a knowledge base linked it also limits the agent to answering from that base; a table on its own does not count here.'),
        },
        {
            value: 'web',
            Icon: Globe,
            label: t('agent_studio.role.unknown_web', 'Search the web'),
            description: t('agent_studio.role.unknown_web_desc', 'It looks the answer up and names the source. This asks for the web-search app — switch it on under "Can use", or the agent still just says it does not know.'),
        },
        {
            value: 'handoff',
            Icon: HandHelping,
            label: t('agent_studio.role.unknown_handoff', 'Hand it to a person'),
            description: t('agent_studio.role.unknown_handoff_desc', 'It starts an automation you pick and tells the user the question was handed over.'),
        },
    ];
}

export default function UnknownCard({
    t, persona, onChangeMode, onChangeHandoff,
    automations = null, automationsState = READ.OK,
    agentOwnerId = null, userId = null,
    readOnly = false,
}: {
    t: TranslateFn;
    persona?: Partial<Persona> | null;
    onChangeMode?: (mode: string) => void;
    onChangeHandoff?: (id: string | null) => void;
    automations?: unknown;
    automationsState?: string;
    agentOwnerId?: string | null;
    userId?: string | null;
    readOnly?: boolean;
}) {
    const mode = persona?.unknown?.mode || 'honest';
    const automationId = persona?.unknown?.automationId || null;
    const { rows, state } = handoffChoices({ automations, state: automationsState });
    const blocked = handoffBlockedBecause({ agentOwnerId, userId });
    const chosen = selectedHandoff({ automations, state: automationsState, automationId });

    return (
        <RoleCard
            wide
            testId="agent-role-unknown"
            icon={<Hand size={14} />}
            title={t('agent_studio.role.unknown_title', "If it doesn't know")}
            hint={t('agent_studio.role.unknown_hint', 'what happens outside its knowledge')}
        >
            <ChoiceCards
                columns={3}
                value={mode}
                disabled={readOnly}
                onChange={(next) => onChangeMode?.(next)}
                ariaLabel={t('agent_studio.role.unknown_title', "If it doesn't know")}
                options={unknownOptions(t)}
            />

            {mode === 'handoff' && (
                <>
                    <HandoffChooser
                        t={t}
                        rows={rows}
                        state={state}
                        blocked={blocked}
                        value={automationId}
                        onChange={onChangeHandoff}
                        readOnly={readOnly}
                    />
                    <HandoffPill t={t} chosen={chosen} />
                </>
            )}
        </RoleCard>
    );
}
