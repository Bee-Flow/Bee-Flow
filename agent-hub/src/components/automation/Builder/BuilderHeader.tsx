import {
    ArrowLeft, Bot, Box, ClipboardList, Clock, FolderOpen, Layers, List, Mail, MousePointerClick,
    PanelLeftClose, PanelLeftOpen, Redo2, Sparkles, Stethoscope, Undo2, Webhook,
} from 'lucide-react';
import type { ComponentType, ReactNode, RefObject } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { setStudioMenuHidden, useStudioMenuHidden } from '../../../hooks/useStudioChrome';
import { useAutomationCounts } from '../../../api/queries/automation/meta';
import { IconPicker as IconPickerJsx } from './flow/stepIcons';
import type { BuilderTab } from './useBuilderTabUrl';
import LiveActions, { SavingPill, type SavingState } from './header/LiveActions';
import LiveStatusPill from './header/LiveStatusPill';
import { liveStateOf, type LiveRow } from './header/liveState';
import { CategoryField, StepActionCluster, type StepRow, type StepSharing } from './header/StepCluster';
import TestRunMenu, { type RunTriggerOption } from './header/TestRunMenu';
import TitleField, { type HeaderScope } from './header/TitleField';
import ViewSwitcher, { ViewMenu } from './header/ViewSwitcher';

type Fn = (() => void) | null | undefined;

// A .jsx component: its prop types are inferred from defaults (`placeholder = null`).
const IconPicker = IconPickerJsx as unknown as ComponentType<Record<string, unknown>>;

export interface BuilderHeaderProps {
    title?: string;
    triggerKind?: string | null;
    /** The persisted row (automation mode): live state, versions, counts. */
    automation?: (LiveRow & { id?: string | null; updatedAt?: string | null }) | null;
    /** Fallbacks for a caller that passes no row. */
    isActive?: boolean;
    isDraft?: boolean;
    canActivate?: boolean;
    canDiagnose?: boolean;
    busy?: boolean;
    onBack?: Fn;
    /** Where back goes when the builder is hosted elsewhere ("Back to playbook"). */
    backLabel?: string | null;
    /** Opens the routines / Steps list as a slide-over (BFSF-404). */
    onOpenList?: Fn;
    onActivate?: Fn;
    onDeactivate?: Fn;
    /** "Make vN live": POST /:id/publish. */
    onPublish?: Fn;
    onDryRun?: ((from: string | null) => void) | null;
    onRunLive?: ((from: string | null) => void) | null;
    triggers?: RunTriggerOption[];
    primaryTriggerLabel?: string;
    onDiagnose?: Fn;
    onRename?: ((next: string) => void) | null;
    scope?: HeaderScope | null;
    onExitScope?: Fn;
    onDeleteLayer?: Fn;
    diagnoseAnchorRef?: RefObject<HTMLButtonElement | null>;
    savingState?: SavingState;
    tab?: BuilderTab;
    onTabChange?: ((tab: BuilderTab) => void) | null;
    onUndo?: Fn;
    onRedo?: Fn;
    onAssistant?: Fn;
    assistantOpen?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    /** 'step' = a reusable Step (kind='block'): Publish replaces Activate / Test. */
    mode?: 'automation' | 'step';
    step?: StepRow | null;
    orgGroups?: unknown[];
    onPublishStep?: Fn;
    onSetStepSharing?: ((s: StepSharing) => void) | null;
    onSetStepExpose?: ((on: boolean) => void) | null;
    onSetStepIcon?: ((name: string) => void) | null;
    onSetStepCategory?: ((c: string) => void) | null;
    /** BuildTab renders this bar itself; kept for its call site. */
    flush?: boolean;
    tabsSlot?: ReactNode;
    /** Compact "what this automation does" next to the status (Editor only). */
    infoSlot?: ReactNode;
    /** The strip UNDER the bar (AppRefBreadcrumb / UsedByButtonsCapsule). */
    breadcrumbSlot?: ReactNode;
    /** Legacy: the shell's old status word; the pill derives its own now. */
    statusLabel?: string;
    statusBadgeClass?: string;
}

const ICON_BTN = 'w-[30px] h-[30px] rounded-lg grid place-items-center text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition disabled:opacity-40 disabled:hover:bg-transparent';

/**
 * The builder's top bar (handoff 5, artboard 5a): 52px, three columns.
 *   left    back · trigger tile · name (inline rename) · status in plain
 *           language ("Draft · never live", "Live · v3" + "editing v5 · 2
 *           changes not live yet", "Paused")
 *   middle  Editor · Settings · Runs n · Versions n
 *   right   undo/redo (Editor) or "Saved automatically" (Settings) · Test ·
 *           the one primary: Activate / Make vN live, Pause as the quiet
 *           secondary while live
 * Fit stages read the bar's OWN width (`@container/bar`), never the
 * viewport. Small bars get less, not smaller: the pending line only shows
 * from 1700px (it rides on the status pill's tooltip below that), the save
 * word and Pause beside a primary keep only their icon below 1400px, the
 * summary button goes below 1320px, Test keeps only its icon below 1180px and
 * the view segments fold into one menu below 1080px. The 24px column gap
 * keeps the name off the centred tabs at every width.
 *
 * Step mode (kind='block') keeps its icon picker, category and Publish
 * cluster. A flowlet scope turns the name into a breadcrumb; the status and
 * the actions stay whole-routine.
 */
export default function BuilderHeader(props: BuilderHeaderProps) {
    const {
        title = '', triggerKind, automation = null, isActive = false, isDraft = false, canActivate = true,
        canDiagnose = false, busy = false, onBack, backLabel = null, onOpenList, onActivate, onDeactivate, onPublish,
        onDryRun, onRunLive, triggers = [], primaryTriggerLabel = 'Primary trigger', onDiagnose, onRename,
        scope = null, onExitScope, onDeleteLayer, diagnoseAnchorRef, savingState = 'idle', tab = 'build', onTabChange,
        onUndo, onRedo, canUndo = false, canRedo = false, mode = 'automation', step = null, orgGroups = [],
        onPublishStep, onSetStepSharing, onSetStepExpose, onSetStepIcon, onSetStepCategory,
        tabsSlot = null, infoSlot = null, breadcrumbSlot = null, onAssistant, assistantOpen = false,
    } = props;
    const { t } = useTranslation();
    const isStepMode = mode === 'step';

    const row: LiveRow = automation || { isActive, isDraft };
    const countsId = !isStepMode && automation?.id ? automation.id : null;
    const stamp = `${automation?.version ?? ''}:${automation?.liveVersion ?? ''}:${automation?.isActive ? 1 : 0}:${automation?.updatedAt ?? ''}`;
    const { data: counts } = useAutomationCounts(countsId, stamp);
    const live = liveStateOf(row, counts?.pendingChanges ?? null);

    const TriggerIcon = scope ? Layers : pickTriggerIcon(triggerKind);
    const back = backLabel || t('routines.header.back', 'Back to Routines');
    const menuHidden = useStudioMenuHidden();
    const hideMenu = t('routines.header.hide_menu', 'Hide the Studio menu');
    const showMenu = t('routines.header.show_menu', 'Show the Studio menu');
    const browse = isStepMode ? t('routines.header.browse_steps', 'Browse Steps') : t('routines.header.browse', 'Browse automations');

    return (
        <div>
            <div className="@container/bar grid grid-cols-[1fr_auto_1fr] items-center gap-x-6 h-[52px] px-3.5 bg-[var(--bg-card)] border-b border-[var(--border-default)] text-[12px] text-[var(--text-primary)] min-w-0">
                <div className="flex items-center gap-2.5 min-w-0">
                    {/* A host with its own back button (the playbook run page)
                        passes no onBack, so the room never shows two arrows. */}
                    {onBack && (
                        <button type="button" onClick={() => onBack()} title={back} aria-label={back} className={`${ICON_BTN} flex-shrink-0`}>
                            <ArrowLeft size={16} />
                        </button>
                    )}
                    {onOpenList && (
                        <button type="button" onClick={() => onOpenList()} title={browse} aria-label={browse} className={`${ICON_BTN} flex-shrink-0`}>
                            <List size={16} />
                        </button>
                    )}
                    {onOpenList && (
                        <button type="button" onClick={() => setStudioMenuHidden(!menuHidden)} aria-pressed={menuHidden}
                            title={menuHidden ? showMenu : hideMenu} aria-label={menuHidden ? showMenu : hideMenu}
                            data-testid="studio-menu-toggle" className={`${ICON_BTN} flex-shrink-0`}>
                            {menuHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                        </button>
                    )}
                    {tabsSlot}
                    {isStepMode ? (
                        <IconPicker
                            value={step?.icon || ''}
                            onChange={(name: string) => onSetStepIcon?.(name)}
                            title={t('routines.header.step_icon_title', 'Choose a symbol for this Step')}
                            buttonClassName="w-7 h-7 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-default)] grid place-items-center flex-shrink-0 text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                            placeholder={<Box size={14} className="text-[var(--text-primary)]" />}
                        />
                    ) : (
                        <div data-testid="trigger-tile" className="w-7 h-7 rounded-lg grid place-items-center flex-shrink-0 bg-[color-mix(in_srgb,var(--type-trigger)_16%,transparent)] text-[var(--type-trigger)]">
                            <TriggerIcon size={14} />
                        </div>
                    )}
                    <TitleField title={title} scope={scope} onRename={onRename} onExitScope={onExitScope} onDeleteLayer={onDeleteLayer} />
                    {isStepMode ? (
                        <>
                            <CategoryField value={step?.category || ''} onCommit={onSetStepCategory} />
                            <span className="text-[11px] uppercase tracking-wide font-medium px-2 py-0.5 rounded-full flex-shrink-0 bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                                {step?.publishedVersion != null ? t('routines.header.step_published', 'Published') : t('routines.header.step_draft', 'Draft')}
                            </span>
                        </>
                    ) : (
                        <LiveStatusPill live={live} />
                    )}
                    {infoSlot && <div className="flex-shrink-0 @max-[1320px]/bar:hidden">{infoSlot}</div>}
                </div>

                <div className="flex justify-center min-w-0">
                    {onTabChange && (isStepMode
                        ? <ViewMenu tab={tab} onTabChange={onTabChange} />
                        : <ViewSwitcher tab={tab} onTabChange={onTabChange} counts={{ runs: counts?.runs7d ?? null, versions: counts?.versions ?? null }} />)}
                </div>

                <div className="flex items-center gap-2 justify-end min-w-0">
                    {tab === 'build' && onUndo && (
                        <div className="flex items-center gap-0.5">
                            <button type="button" onClick={() => onUndo()} disabled={!canUndo} className={ICON_BTN}
                                aria-label={t('routines.header.undo', 'Undo')}
                                // The canvas undo, not a saved version.
                                title={t('routines.header.undo_title', 'Undo your last canvas change (⌘Z). This is not a saved version.')}>
                                <Undo2 size={15} />
                            </button>
                            <button type="button" onClick={() => onRedo?.()} disabled={!canRedo} className={ICON_BTN}
                                aria-label={t('routines.header.redo', 'Redo')}
                                title={t('routines.header.redo_title', 'Redo your last undone canvas change (⌘⇧Z)')}>
                                <Redo2 size={15} />
                            </button>
                        </div>
                    )}
                    {!isStepMode && onAssistant && <button type="button" onClick={() => onAssistant()} aria-pressed={assistantOpen}
                        title={t('routines.assistant.open', 'Ask the assistant (⌘J)')} aria-label={t('routines.assistant.open', 'Ask the assistant (⌘J)')}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-2.5 py-1.5 text-[var(--type-ai)] hover:bg-[var(--bg-secondary)]">
                        <Sparkles size={13} /><span className="@max-[1400px]/bar:hidden">{t('routines.assistant.title', 'Assistant')}</span><kbd className="@max-[1600px]/bar:hidden text-[10px]">⌘ J</kbd>
                    </button>}
                    <SavingPill state={savingState} settled={tab === 'settings'} />
                    {isStepMode ? (
                        <StepActionCluster
                            busy={busy}
                            step={step}
                            orgGroups={orgGroups}
                            onPublishStep={onPublishStep}
                            onSetStepSharing={onSetStepSharing}
                            onSetStepExpose={onSetStepExpose}
                        />
                    ) : (
                        <>
                            {canDiagnose && (
                                <button
                                    ref={diagnoseAnchorRef}
                                    type="button"
                                    onClick={() => onDiagnose?.()}
                                    disabled={busy}
                                    aria-label={t('routines.header.diagnose', 'Diagnose')}
                                    title={t('routines.header.diagnose_title', 'Probe the trigger pipeline (subscription, credentials, Gmail, filter)')}
                                    className={ICON_BTN}
                                >
                                    <Stethoscope size={15} />
                                </button>
                            )}
                            <TestRunMenu busy={busy} onDryRun={onDryRun} onRunLive={onRunLive} triggers={triggers} primaryLabel={primaryTriggerLabel} />
                            <LiveActions
                                live={live}
                                busy={busy}
                                saving={savingState === 'saving'}
                                canActivate={canActivate}
                                versionsView={tab === 'versions'}
                                onActivate={onActivate}
                                onPublish={onPublish}
                                onDeactivate={onDeactivate}
                            />
                        </>
                    )}
                </div>
            </div>
            {breadcrumbSlot}
        </div>
    );
}

function pickTriggerIcon(kind?: string | null) {
    if (kind === 'schedule') return Clock;
    if (kind === 'webhook') return Webhook;
    if (kind === 'form') return ClipboardList;
    if (kind === 'manual') return MousePointerClick;
    if (kind === 'app_event') return Mail;
    if (kind === 'agent_call') return Bot;
    if (kind === 'file' || kind === 'files') return FolderOpen;
    return Sparkles;
}
