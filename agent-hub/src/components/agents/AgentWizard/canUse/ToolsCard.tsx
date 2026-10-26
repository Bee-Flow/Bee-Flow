import { Workflow } from 'lucide-react';
import React, { useMemo } from 'react';
import CanUseCard, { EmptyRow, LinkButton, UnreadableNotice } from './CanUseCard';
import { READ } from './canUseFacts';
import { CHOOSER_SECTION, chooserRequest } from './toolChooser';
import { ACT_AS_KIND, CONFIRM } from './toolGrants.helpers';
import { SECTION_LBL } from '@/components/shell/sidebar/sidebarTokens';
import type { AutomationCardRow, ToolApp, ToolsCardProps, TranslateFn } from './ToolsCard.types';
import { RowWarning, ToolRow } from './ToolRow';
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
