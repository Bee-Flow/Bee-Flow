import { ArrowUpRight, ChevronDown, Workflow } from 'lucide-react';
import React, { useMemo, useRef, useState, type ReactNode } from 'react';
import CanUseCard, { EmptyRow, LinkButton, UnreadableNotice } from './CanUseCard';
import { READ } from './canUseFacts';
import { CHOOSER_SECTION, chooserRequest } from './toolChooser';
import { ACT_AS, ACT_AS_KIND, CONFIRM } from './toolGrants';
import { getIntegrationIcon } from '../../../../config/integrationIcons';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import { actionLabelMap } from '../../../automation/Builder/flow/appLabels';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import SegmentedControl from '../../../shared/SegmentedControl';
import { SECTION_LBL } from '../../../shell/sidebar/sidebarTokens';
import type { AutomationCardRow, ToolApp, ToolCardRow, ToolRowProps, ToolsCardProps, TranslateFn } from './ToolsCard.types';
/**
 * The Tools card of the "Can use" tab: what the agent may do in OTHER systems (Agents artboard 1a, A2 step 3).
 *
 * One row per app: how many of its actions are switched on, which verbs those are, in whose name the app runs,
 * and whether a human must first say yes. The ↗ opens the picker on THAT app.
 *
 * ── THREE NARROWINGS, ALL THREE TAKEN OVER FROM THE RUNTIME ─────────
 * The facts come from `toolGrants.js`, which mirrors `server/core/agentRuntime/toolPolicy.js` line by line.
 * This card draws them, and in doing so draws three things that look like strictness but are honesty:
 *
 *   1. SENDS ⇒ LOCKED. An app that can mail, post or invite is on "confirm first", and the switch is locked.
 *      That is not a choice the card makes: `confirmForTool` decides at dispatch based on the effect, and there
 *      it always says `ask`. A switch that shows "direct" would show a promise that nobody keeps.
 *   2. UNKNOWN EFFECT ⇒ ALSO LOCKED. Without a catalogue we do not know what an action does. Then unknown
 *      counts as "it sends", exactly what `normaliseToolsConfig` does when the attribution is broken.
 *   3. NO LENT GRANT ⇒ NO OWNER OPTION. And "I could not read the grants" falls on the same side: that is not a yes.
 *
 * ── AND ONE PLACE WHERE THE CARD BECAME EQUAL TO THE RUNTIME (A2-2) ─
 * The capsule draws "As: the person asking" as soon as no `actAs` has been saved. Until A2-2 that was a promise
 * the runtime did not keep: `mayLendOwnerConnection` gave `true` for an app WITHOUT an entry, and the OWNER's
 * connection went out the door anyway. The runtime now follows the card: only a saved yes lends. That is a
 * change of behaviour for existing agents, and it should not happen silently, so the row says so:
 *   `ownerLendingUnset`     the agent is curated, nothing is stored here, and the lent connection is therefore
 *                           NO LONGER used;
 *   `ownerLendsUncurated`   nobody curated this agent, so the runtime still lends here. That is the opt-in
 *                           boundary, out loud.
 *
 * ── A FAILED CATALOGUE IS NOT AN EMPTY CARD ────────────────────────
 * The GRANTS are in the agent config, and we always have those. If the catalogue drops away, the rows stay:
 * without counts, without verbs, with a line above that says what is missing. Filtering them out would claim
 * that the agent does not have those apps, and that is the only one of the three answers that is untrue.
 *
 * ── WHAT THE DESIGN DOES NOT GET ────────────────────────────────────
 * No "may send to screen" row. Agent-to-app navigation does not exist in this product, and a row that suggests
 * a capability that is not there is worse than a missing row.
 */

/** Waarschuwingstekst onder een rij — één regel, altijd in de waarschuwkleur. */
function RowWarning({ children, testId }: { children?: ReactNode; testId?: string }) {
    return <div data-testid={testId} className="text-[12px] text-[var(--warning)]">{children}</div>;
}

/**
 * The lending notice under a row (A2-2).
 *
 * The capsule says "As: the person asking" as soon as nothing has been stored, and until A2-2 the runtime
 * nevertheless lent the owner's connection there. That gate is closed now, but it is a change of behaviour for
 * existing agents, so what happened to THIS row is stated here. The two cases exclude each other: the opt-in
 * boundary (`curated`) separates them.
 *
 * The REMEDY is only there if it exists. An app that sends never gets "As: you", and naming a way out that the
 * picker refuses is the same promise-without-cover as the gap itself. That held for one branch and not for the
 * other: the uncurated sentence had the way out BAKED INTO the sentence, without the `canActAsOwner` gate. So on
 * every sending app (Gmail, Outlook, LinkedIn, SignRequest) the card named a menu item that does not exist and
 * that normalisation rolls back anyway.
 */
function LendingNotice({ t, row }: { t: TranslateFn; row: ToolCardRow }) {
    if (row.ownerLendingUnset) {
        return (
            <RowWarning testId="agent-tool-lending-unset">
                {t('agent_studio.can_use.act_as_lending_unset', 'You lent a connection for this app, but nothing is set here — so it no longer borrows it and everyone uses their own.')}
                {row.canActAsOwner && ` ${t('agent_studio.can_use.act_as_lending_unset_fix', 'Choose “As: you” to lend it again.')}`}
            </RowWarning>
        );
    }
    if (row.ownerLendsUncurated) {
        return (
            <RowWarning testId="agent-tool-lending-uncurated">
                {t('agent_studio.can_use.act_as_lending_uncurated', 'Nothing has been picked for this agent yet, so it still runs on your lent connection here. As soon as anything is picked, that stops.')}
                {row.canActAsOwner && ` ${t('agent_studio.can_use.act_as_lending_uncurated_fix', 'Choose “As: you” to keep lending it.')}`}
            </RowWarning>
        );
    }
    return null;
}

/**
 * Hoeveel werkwoorden een rij toont voordat hij "+3" zegt. Vier is wat er in
 * de tweede kolom past zonder af te kappen op een half woord.
 */
const MAX_VERBS = 4;

/**
 * The verbs of a row: "Search · Compose · Create draft".
 *
 * `actionLabelMap` (the builder ribbon) strips the app word from the name, so "gmail search" becomes "Search",
 * because the app is already in column one. Reusing that same function instead of cutting it again here is the
 * whole reason that module exists.
 */
function useVerbs(row: ToolCardRow, app: ToolApp | null) {
    return useMemo(() => {
        if (!app || !Array.isArray(app.actions) || !Array.isArray(row.grantedNames)) return null;
        const labels = actionLabelMap(app.actions.map(a => ({ tool: a.name, label: a.label })));
        return row.grantedNames.map(name => labels.get(name) || name).filter(Boolean);
    }, [app, row.grantedNames]);
}

/**
 * The "As:" capsule.
 *
 * An app without a user connection (websearch, built-in tools, platform services) gets a STATIC capsule with no
 * dropdown, and no `actAs` is stored. A choice that steers nothing is exactly the stored promise without
 * enforcement that toolPolicy.js forbids.
 */
function ActAsCapsule({ t, row, ro, onChange }: { t: TranslateFn; row: ToolCardRow; ro?: boolean; onChange?: (next: string) => void }) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);

    if (row.actAsKind === ACT_AS_KIND.PLATFORM) {
        return (
            <span
                data-testid="agent-tool-actas-static"
                title={t('agent_studio.can_use.act_as_platform_help', 'This app uses no personal connection.')}
                className="inline-flex items-center h-7 px-2.5 rounded-full text-[12px] border border-[var(--border-default)] text-[var(--text-tertiary)] whitespace-nowrap"
            >
                {t('agent_studio.can_use.act_as_platform', 'As: Bee Flow')}
            </span>
        );
    }

    // Unknown is not "Bee Flow". That would draw an app that DOES borrow credentials as a platform service.
    // It is also not a choice, because we do not know between what. So: the default that the runtime applies, plus an explanation.
    if (row.actAsKind === ACT_AS_KIND.UNKNOWN) {
        return (
            <span
                data-testid="agent-tool-actas-unknown"
                title={t('agent_studio.can_use.act_as_unknown_help', 'Could not check whose connection this app uses, so it runs as the person asking.')}
                className="inline-flex items-center h-7 px-2.5 rounded-full text-[12px] border border-[var(--border-default)] text-[var(--text-tertiary)] whitespace-nowrap"
            >
                {t('agent_studio.can_use.act_as_viewer', 'As: the person asking')}
            </span>
        );
    }

    const label = row.actAs === ACT_AS.OWNER
        ? t('agent_studio.can_use.act_as_owner', 'As: you')
        : t('agent_studio.can_use.act_as_viewer', 'As: the person asking');

    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                disabled={ro}
                onClick={() => setOpen(v => !v)}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid="agent-tool-actas"
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[12px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50 whitespace-nowrap max-w-full"
            >
                <span className="truncate">{label}</span>
                <ChevronDown size={12} aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={300}>
                <div className="p-2" role="menu" aria-label={t('agent_studio.can_use.act_as_menu', 'Choose whose connection this app uses')}>
                    <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={row.actAs !== ACT_AS.OWNER}
                        onClick={() => { onChange?.(ACT_AS.VIEWER); setOpen(false); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-[var(--bg-secondary)]"
                    >
                        <span className="block text-[13px] text-[var(--text-primary)]">
                            {t('agent_studio.can_use.act_as_viewer', 'As: the person asking')}
                        </span>
                        <span className="block text-[11px] text-[var(--text-tertiary)]">
                            {t('agent_studio.can_use.act_as_viewer_help', 'Everyone uses their own connection.')}
                        </span>
                    </button>
                    <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={row.actAs === ACT_AS.OWNER}
                        disabled={!row.canActAsOwner}
                        data-testid="agent-tool-actas-owner"
                        onClick={() => { onChange?.(ACT_AS.OWNER); setOpen(false); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-[var(--bg-secondary)] disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                        <span className="block text-[13px] text-[var(--text-primary)]">
                            {t('agent_studio.can_use.act_as_owner', 'As: you')}
                        </span>
                        <span className="block text-[11px] text-[var(--text-tertiary)]">
                            {row.canActAsOwner
                                ? t('agent_studio.can_use.act_as_owner_help', 'Everyone borrows your connection — never for actions that send.')
                                : t('agent_studio.can_use.act_as_owner_unavailable', 'You have not lent a connection for this app.')}
                        </span>
                    </button>
                </div>
            </AnchoredMenu>
        </>
    );
}

/** Eén app-rij. Grid `1fr 1fr 220px 32px`, zoals het artboard hem tekent. */
function ToolRow({ t, ro, row, app, onChangeConfirm, onChangeActAs, onOpenChooser }: ToolRowProps) {
    const verbs = useVerbs(row, app);
    const shownVerbs = verbs ? verbs.slice(0, MAX_VERBS) : null;
    const restVerbs = verbs ? verbs.length - (shownVerbs?.length || 0) : 0;

    return (
        <div
            data-testid="agent-tool-row"
            className="grid items-start gap-3 px-4 py-3 [grid-template-columns:1fr_1fr_220px_32px]"
        >
            <div className="min-w-0 flex items-start gap-2.5">
                {/* `getIntegrationIcon` returns an ELEMENT, not a component. Same usage as
                    shared/AppActionPicker. */}
                <span className="mt-0.5 w-4 h-4 flex-shrink-0 flex items-center justify-center" aria-hidden="true">
                    {getIntegrationIcon(row.appId)}
                </span>
                <span className="min-w-0">
                    <span className="block text-[13px] text-[var(--text-primary)] truncate">{row.label}</span>
                    <span className="block text-[12px] text-[var(--text-tertiary)]">
                        {row.totalActions === null
                            ? t('agent_studio.can_use.actions_unknown', 'actions unknown')
                            : nOf(
                                t, 'agent_studio.can_use.n_of_m_actions', row.totalActions,
                                '{granted} of {count} action', '{granted} of {count} actions',
                                { granted: row.grantedCount },
                            )}
                    </span>
                    {row.available === false && (
                        <RowWarning>
                            {/* Different facts, different sentences. But only if the MEETING points to one of
                                them. `browse_web` sits behind a docker probe AND behind the org entitlement, so
                                "this installation does not have it" would be an assertion that does not follow
                                from anything there. With more than one possible cause, the card names both
                                instead of choosing one. */}
                            {row.availabilityKinds && row.availabilityKinds.length > 1
                                ? t('agent_studio.can_use.app_unavailable_mixed', 'Not available here — this installation may not have it, or your account may not use it. The agent gets nothing from this app.')
                                : row.availabilityKind === 'installation'
                                    ? t('agent_studio.can_use.app_unavailable_installation', 'Not available on this installation — the agent gets nothing from this app.')
                                    : row.availabilityKind === 'permission'
                                        ? t('agent_studio.can_use.app_unavailable_permission', 'Your account may not use this app — the agent gets nothing from it.')
                                        : t('agent_studio.can_use.app_unavailable', 'Not connected for you — the agent gets nothing from this app.')}
                        </RowWarning>
                    )}
                    {row.narrowedBy && row.narrowedBy.length > 0 && (
                        <RowWarning testId="agent-tool-narrowed-by">
                            {/* Two rows about the same tools: the runtime lets EVERY app that supplies the name
                                take part in the decision, so the strictest wins. Without this sentence the owner
                                sees only a lower number, and not why. */}
                            {t('agent_studio.can_use.app_narrowed_by',
                                'Another app with the same tools limits this one further.')}
                        </RowWarning>
                    )}
                    {row.ownerRefused && (
                        <RowWarning>
                            {t('agent_studio.can_use.act_as_owner_refused', 'Saved as “you”, but there is no lent connection for this app — it runs as the person asking.')}
                        </RowWarning>
                    )}
                    <LendingNotice t={t} row={row} />
                </span>
            </div>

            <div className="min-w-0 text-[12px] text-[var(--text-tertiary)]">
                {shownVerbs === null
                    ? null
                    : shownVerbs.length === 0
                        ? t('agent_studio.can_use.app_no_actions', 'Nothing switched on')
                        : (
                            <>
                                {shownVerbs.join(' · ')}
                                {restVerbs > 0 && (
                                    <span className="ml-1">
                                        {t('agent_studio.can_use.more_actions', '+{count} more', { count: restVerbs })}
                                    </span>
                                )}
                            </>
                        )}
            </div>

            <div className="flex flex-col items-start gap-2 min-w-0">
                <ActAsCapsule t={t} row={row} ro={ro} onChange={(next) => onChangeActAs?.(row.appId, next)} />
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('agent_studio.can_use.confirm_group', 'When this app is used')}
                    value={row.confirm}
                    disabled={ro || row.confirmLocked}
                    onChange={(next) => onChangeConfirm?.(row.appId, next)}
                    options={[
                        { value: CONFIRM.DIRECT, label: t('agent_studio.can_use.confirm_direct', 'Direct') },
                        { value: CONFIRM.ASK, label: t('agent_studio.can_use.confirm_ask', 'Confirm first') },
                    ]}
                />
                {row.confirmLocked && (
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                        {row.sends === true
                            ? t('agent_studio.can_use.confirm_locked_sends', 'This app can send, so a person always confirms first.')
                            : t('agent_studio.can_use.confirm_locked_unknown', 'Could not read what these actions do, so a person confirms first.')}
                    </span>
                )}
            </div>

            <button
                type="button"
                data-testid="agent-tool-open"
                onClick={() => onOpenChooser?.(chooserRequest(CHOOSER_SECTION.APPS, { appId: row.appId }))}
                aria-label={t('agent_studio.can_use.open_app_actions', 'Choose actions for this app')}
                title={t('agent_studio.can_use.open_app_actions', 'Choose actions for this app')}
                className="flex items-center justify-center w-8 h-8 rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition flex-shrink-0"
            >
                <ArrowUpRight size={16} aria-hidden="true" />
            </button>
        </div>
    );
}

/**
 * The band "Automations as tool": automations that the agent itself may start.
 *
 * The parameter pills come from `trigger.parametersSchema`, the same schema from which `automationToTool`
 * renders the tool signature. What is shown here is therefore literally what the model has to fill in, not a
 * paraphrase of it.
 */
function AutomationRow({ t, row }: { t: TranslateFn; row: AutomationCardRow }) {
    return (
        <div data-testid="agent-automation-row" className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true">
                <Workflow size={14} />
            </span>
            <div className="min-w-0 flex-1">
                <div className={`text-[13px] truncate ${row.readable ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] italic'}`}>
                    {row.name || t('agent_studio.can_use.automation_unnamed', 'Automation')}
                </div>
                <div className="text-[12px] text-[var(--text-tertiary)] flex items-center gap-1.5 flex-wrap mt-0.5">
                    <span>
                        {row.confirm === CONFIRM.ASK
                            ? t('agent_studio.can_use.confirm_ask', 'Confirm first')
                            : t('agent_studio.can_use.confirm_direct', 'Direct')}
                    </span>
                    {row.readable && (
                        <>
                            <span aria-hidden="true">·</span>
                            {row.params.length === 0 ? (
                                <span>{t('agent_studio.can_use.automation_no_params', 'asks for nothing')}</span>
                            ) : (
                                <>
                                    <span>{t('agent_studio.can_use.automation_asks_for', 'asks for')}</span>
                                    {row.params.map(p => (
                                        <span
                                            key={p.name}
                                            data-testid="agent-automation-param"
                                            title={p.required ? t('agent_studio.can_use.param_required', 'required') : undefined}
                                            className="inline-flex items-center px-1.5 py-px rounded-md border border-[var(--border-default)] text-[11px] text-[var(--text-secondary)]"
                                        >
                                            {p.name}
                                            {p.required && <span aria-hidden="true" className="ml-0.5 text-[var(--error)]">*</span>}
                                        </span>
                                    ))}
                                </>
                            )}
                        </>
                    )}
                </div>
                {row.readable === false && (
                    <RowWarning>
                        {t('agent_studio.can_use.automation_row_unreadable', 'Granted, but this automation could not be read — so what it does is unknown.')}
                    </RowWarning>
                )}
                {row.callable === false && (
                    <RowWarning>
                        {t('agent_studio.can_use.automation_not_callable', 'This automation has no agent trigger, so the agent is never offered it.')}
                    </RowWarning>
                )}
                {row.callable !== false && row.linked === false && (
                    <RowWarning>
                        {t('agent_studio.can_use.automation_not_linked', 'This automation is not linked to this agent, so the agent is never offered it. Link the agent in the automation\'s trigger panel ("Who can call this").')}
                    </RowWarning>
                )}
            </div>
        </div>
    );
}

export default function ToolsCard({
    t, ro = false,
    rows = [],
    apps = null,
    catalogState = READ.OK,
    catalogDegraded = false,
    onRetryCatalog,
    lentState = READ.OK,
    onRetryLent,
    automationRows: autoRows = [],
    automationsState = READ.OK,
    onChangeConfirm, onChangeActAs, onOpenChooser,
}: ToolsCardProps) {
    const appById = useMemo(() => {
        const map = new Map<string, ToolApp>();
        for (const app of Array.isArray(apps) ? apps : []) if (app && app.id) map.set(app.id, app);
        return map;
    }, [apps]);

    // "This agent has no apps" is a CONFIG question. The rows come from `enabledIntegrations` and `config.tools`,
    // which we always have. So that sentence may stand there without waiting for the catalogue. And the other way
    // round: the warning should only appear if there is something that we could not describe.
    const nothingOn = rows.length === 0 && autoRows.length === 0;
    // The lending reading is only news for a row that uses a user connection. For an agent with platform tools
    // only, the warning would be about something that is not there.
    const anyUserConnection = rows.some(r => r.actAsKind === ACT_AS_KIND.USER);

    return (
        <CanUseCard
            kind="app"
            testId="agent-tools-card"
            title={t('agent_studio.can_use.tools_title', 'Tools')}
            subtitle={t('agent_studio.can_use.tools_sub', 'What it may do in other apps')}
            action={!ro && (
                <LinkButton
                    testId="agent-tools-link"
                    label={t('agent_studio.can_use.link', 'Link')}
                    onClick={() => onOpenChooser?.(chooserRequest(CHOOSER_SECTION.APPS))}
                />
            )}
        >
            {catalogState === READ.ERROR && (
                <UnreadableNotice
                    testId="agent-tools-unreadable"
                    message={t('agent_studio.can_use.tools_unreadable', 'Could not load the app catalogue, so the action counts and what each action does are missing here.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetryCatalog}
                />
            )}
            {catalogState === READ.OK && catalogDegraded && (
                <UnreadableNotice
                    testId="agent-tools-degraded"
                    message={t('agent_studio.can_use.tools_degraded', 'Could not check which apps you are allowed to use, so nothing is claimed about that here.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetryCatalog}
                />
            )}
            {lentState === READ.ERROR && anyUserConnection && (
                <UnreadableNotice
                    testId="agent-tools-lending-unreadable"
                    message={t('agent_studio.can_use.lending_unreadable', 'Could not read which connections you lent to this agent, so “as you” is not offered.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetryLent}
                />
            )}

            {rows.map(row => (
                <ToolRow
                    key={row.appId}
                    t={t}
                    ro={ro}
                    row={row}
                    app={appById.get(row.appId) || null}
                    onChangeConfirm={onChangeConfirm}
                    onChangeActAs={onChangeActAs}
                    onOpenChooser={onOpenChooser}
                />
            ))}

            {autoRows.length > 0 && (
                <div className="px-4 pt-3 pb-1">
                    <span className={SECTION_LBL} data-testid="agent-automations-band">
                        {t('agent_studio.can_use.automations_band', 'Automations as a tool')}
                    </span>
                </div>
            )}
            {automationsState === READ.ERROR && autoRows.length > 0 && (
                <UnreadableNotice
                    testId="agent-automations-unreadable"
                    message={t('agent_studio.can_use.automations_unreadable', 'Could not load the automations, so their names and inputs are missing here.')}
                />
            )}
            {autoRows.map(row => <AutomationRow key={row.id} t={t} row={row} />)}

            {nothingOn && (
                <EmptyRow
                    testId="agent-tools-empty"
                    message={t('agent_studio.can_use.tools_empty', 'No apps switched on yet — this agent answers, it does not act.')}
                />
            )}
        </CanUseCard>
    );
}
