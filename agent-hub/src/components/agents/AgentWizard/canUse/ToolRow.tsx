import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { CHOOSER_SECTION, chooserRequest } from './toolChooser';
import { ACT_AS, ACT_AS_KIND, CONFIRM } from './toolGrants.helpers';
import { getIntegrationIcon } from '@/config/integrationIcons';
import { nOf } from '@/components/admin/Studio/KnowledgeStudio/plural';
import { actionLabelMap } from '@/components/automation/Builder/flow/appLabels';
import AnchoredMenu from '@/components/shared/AnchoredMenu';
import SegmentedControl from '@/components/shared/SegmentedControl';
import type { ToolApp, ToolCardRow, ToolRowProps, TranslateFn } from './ToolsCard.types';

/** Waarschuwingstekst onder een rij — één regel, altijd in de waarschuwkleur. */
export function RowWarning({ children, testId }: { children?: ReactNode; testId?: string }) {
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
export function ToolRow({ t, ro, row, app, onChangeConfirm, onChangeActAs, onOpenChooser }: ToolRowProps) {
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
