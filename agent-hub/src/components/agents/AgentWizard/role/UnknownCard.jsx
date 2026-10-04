import { Ban, Globe, Hand, HandHelping, Loader2, Workflow } from 'lucide-react';
import React from 'react';
import { READ, handoffBlockedBecause, handoffChoices, selectedHandoff } from './personaFacts';
import RoleCard, { RoleEmpty, RoleNote } from './RoleCard';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import ChoiceCards from '../../../shared/ChoiceCards';

/**
 * "Als het niet weet" — wat er gebeurt buiten de kennis (Agents-artboard 1c).
 *
 * Drie keuzes, en dit is de plek waar `shared/ChoiceCards` wél hoort: precies
 * één van de drie geldt tegelijk, dus een ARIA-radiogroup zegt de waarheid.
 * Tot nu toe stond hier één `Toggle` op `strictKnowledge` met een comment dat
 * de andere twee keuzes nog niet bestonden; ze bestaan sinds A1c
 * (`personaPrompt.UNKNOWN_MODES`), en dit is de kaart die ze aanbiedt.
 *
 * ── DE ROUTINEKIEZER IS DE MOEILIJKE HELFT ──────────────────────────
 * `verifyHandoffAutomation` (server/routes/agents/crud.js) accepteert een
 * automatisering alleen als hij bestaat, van de EIGENAAR van de agent is, aan staat
 * en een `agent_call`-trigger heeft — dat laatste via `automationToTool`, wat
 * meteen de exacte toolnaam oplevert die de runtime aanbiedt. Wat niet door
 * die keten komt wordt weggegooid, niet bewaard-en-genegeerd, en het prompt
 * valt terug op de eerlijke regel.
 *
 * Deze kaart spiegelt die keten vooraf, met één harde regel: een lijst die
 * niet gelezen kon worden is NIET "geen automations". `GET /api/automation` hangt
 * achter de automations-module en kan 403'en of omvallen; landen op een lege
 * lijst zou de kaart laten beweren dat deze gebruiker niets heeft om aan door
 * te geven. Vandaar de `READ`-toestand, en vandaar dat de vier takken
 * (laden → fout → leeg → keuzes) in één `aria-live`-blok staan, hetzelfde
 * patroon als `Datatables/DatatablesStudio.jsx`.
 */

/** Waarom er niet gekozen mag worden, als zin. Letterlijke t()-aanroepen voor de i18n-guard. */
function blockedMessage(t, code) {
    if (code === 'not_owner') {
        return t('agent_studio.role.handoff_not_owner', 'This agent belongs to someone else. The hand-off automation is checked against its owner, not against you, so an automation of yours would be refused when it saves.');
    }
    if (code === 'unknown_owner') {
        return t('agent_studio.role.handoff_unknown_owner', 'Who owns this agent is not known here, and the automation is checked against the owner — so no automation can be picked yet.');
    }
    return null;
}

/** De pil die de gekozen automatisering toont — of zegt dat hij niet te lezen was. */
function HandoffPill({ t, chosen }) {
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
                className="self-start inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-semibold"
                style={{ background: 'color-mix(in srgb, var(--type-trigger) 14%, transparent)', color: 'var(--type-trigger)' }}
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
 * De vijf takken laden → fout → geblokkeerd → geen/allemaal-uit → keuzes, in
 * één aria-live-blok.
 *
 * "GEEN" EN "ALLEMAAL UIT" ZIJN TWEE ZINNEN. Ze vielen samen op
 * `offered.length === 0`, en dan noemde het scherm de TRIGGER als reden terwijl
 * de trigger juist klopte — en zette daar één regel lager "2 automatiseringen are
 * switched off" onder, wat het tegendeel zei. De eigenaar werd zo naar het
 * aanpassen van een trigger gestuurd die al goed was, in plaats van naar de
 * aan/uit-schakelaar.
 */
function HandoffChooser({ t, rows, state, blocked, value, onChange, readOnly }) {
    const offered = rows.filter(r => r.active);
    const switchedOff = rows.length - offered.length;
    const message = blockedMessage(t, blocked);
    // Alleen naast een gevulde kiezer: staat ALLES uit, dan zegt de tak
    // hierboven dat al, en twee keer hetzelfde is één keer te veel.
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
                        onChange={(e) => onChange?.(e.target.value || null)}
                        className="bg-[var(--bg-secondary)]/60 border border-[var(--border-default)] rounded-lg px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none disabled:opacity-60"
                    >
                        <option value="">{t('agent_studio.role.handoff_pick_none', 'No automation')}</option>
                        {offered.map(r => (
                            <option key={r.id} value={r.id}>{r.title || r.id}</option>
                        ))}
                    </select>
                </label>
            )}
            {/* `!message`: de telling komt uit `GET /api/automation`, en dat is
                de lijst van de INGELOGDE gebruiker. Op andermans agent zou hij
                dus als een feit over DIE agent gelezen worden. */}
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
function unknownOptions(t) {
    return [
        {
            value: 'honest',
            Icon: Ban,
            label: t('agent_studio.role.unknown_honest', 'Say honestly that it does not know'),
            // "kennisbank", niet "kennis". De strenge stand die hier eventueel
            // bij wordt gezet leunt op de KNOWLEDGE BASE RESULTS-sectie, en die
            // bouwt de server alleen uit `config.knowledge_base_ids` — een
            // tabelgrant levert er geen. Zou de zin "kennis" beloven, dan zou
            // een tabel-agent hier lezen dat hij netjes uit zijn tabel gaat
            // antwoorden terwijl hij alles zou weigeren.
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
