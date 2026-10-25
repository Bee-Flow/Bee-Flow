import { triggerTypeLabel } from './flow/triggerLabels';
import type { FlowDefinition } from './flow/types';
import type { BuilderHeaderProps } from './BuilderHeader';
import type { StepRow } from './header/StepCluster';

/** The header's status word and its badge colours. */
function headerStatus(isDraft: boolean, isActive: boolean) {
    const statusLabel = isDraft ? 'Draft' : (isActive ? 'Live' : 'Paused');
    const statusBadgeClass = isDraft
        ? 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
        : isActive
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    return { statusLabel, statusBadgeClass };
}

/**
 * The "Start from" choice in the header's run menu: every additional trigger
 * by name.
 */
export function secondaryTriggerOptions(def: FlowDefinition | null | undefined) {
    return (Array.isArray(def?.triggers) ? def.triggers : [])
        .filter(trigger => trigger && typeof trigger.id === 'string' && trigger.id)
        .map(trigger => ({ id: trigger.id, label: trigger.label || triggerTypeLabel(trigger), kind: trigger.kind || 'manual' }));
}

/** The persisted row as the header reads it: an automation or a Step. */
type HeaderRow = NonNullable<BuilderHeaderProps['automation']> & StepRow & {
    title?: string;
    triggerType?: string | null;
};

/** What the shell hands over for the header; the rest is derived here. */
export interface HeaderInputs extends Pick<BuilderHeaderProps,
    | 'busy' | 'onBack' | 'backLabel' | 'onOpenList' | 'onExportJson' | 'onActivate' | 'onDeactivate'
    | 'onDryRun' | 'onRunLive' | 'onDiagnose' | 'onRename' | 'mode' | 'orgGroups' | 'onPublishStep'
    | 'onSetStepSharing' | 'onSetStepExpose' | 'onSetStepIcon' | 'onSetStepCategory' | 'scope'
    | 'onExitScope' | 'onDeleteLayer' | 'diagnoseAnchorRef' | 'savingState' | 'onPublish'
    | 'breadcrumbSlot' | 'triggers' | 'tab'> {
    serverAutomation: HeaderRow | null | undefined;
    effectiveDef: FlowDefinition | null | undefined;
    isStep: boolean;
    readOnly: boolean;
    managedPart: unknown;
    assistantOpen: boolean;
    askAssistant: () => void;
    setTab: (tab: NonNullable<BuilderHeaderProps['tab']>) => void;
    draftHistory: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
}

/**
 * Header props bundled so the SAME header renders either at the shell level
 * (Settings / Run history / Version history) or inside BuildTab (the Editor
 * view, where it also hosts the add-step ribbon): one unified top bar in both
 * cases. The view's id stays `build`; only its label reads "Editor".
 */
export function buildHeaderProps(i: HeaderInputs): BuilderHeaderProps {
    const { serverAutomation, effectiveDef, isStep, readOnly, tab, setTab, draftHistory } = i;
    const isActive = !!serverAutomation?.isActive;
    const isDraft = !!serverAutomation?.isDraft;
    // Diagnose button only makes sense for app_event triggers: schedule
    // and manual triggers have nothing to probe externally.
    const isAppEventTrigger = effectiveDef?.trigger?.kind === 'app_event';
    const { statusLabel, statusBadgeClass } = headerStatus(isDraft, isActive);
    // Whether the Activate control is enabled. A DRAFT can be activated as soon
    // as it's structurally complete (a trigger + at least one step): the server
    // /activate route finalises (isDraft:false) AND validates the definition, so
    // it's the real gate. This decouples going-live from a successful chat
    // `builder_finalize` turn (which can be interrupted, e.g. by a connector
    // gateway timeout, leaving an otherwise-complete workflow stuck in Draft).
    const canActivate = !isStep
        && !!effectiveDef?.trigger
        && Array.isArray(effectiveDef?.steps) && effectiveDef.steps.length > 0;
    return {
        title: serverAutomation?.title || (isStep ? 'New Step' : 'New automation'),
        triggerKind: effectiveDef?.trigger?.kind || serverAutomation?.triggerType,
        isActive, isDraft, statusLabel, statusBadgeClass, canActivate,
        canDiagnose: isAppEventTrigger, busy: i.busy, onBack: i.onBack, backLabel: i.backLabel, onOpenList: i.onOpenList,
        onExportJson: isStep ? null : i.onExportJson, onActivate: i.onActivate, onDeactivate: i.onDeactivate,
        onDryRun: i.onDryRun, onRunLive: i.onRunLive, onDiagnose: i.onDiagnose, onRename: i.onRename, mode: i.mode,
        onAssistant: isStep || readOnly ? null : () => i.askAssistant(), assistantOpen: i.assistantOpen && !readOnly,
        // The "Start from" choice in the run menu: every additional trigger by
        // name, plus what to call the primary one.
        triggers: i.triggers,
        primaryTriggerLabel: effectiveDef?.trigger?.label || triggerTypeLabel(effectiveDef?.trigger),
        step: isStep ? serverAutomation : null, orgGroups: i.orgGroups, onPublishStep: i.onPublishStep,
        onSetStepSharing: i.onSetStepSharing, onSetStepExpose: i.onSetStepExpose, onSetStepIcon: i.onSetStepIcon,
        onSetStepCategory: i.onSetStepCategory, scope: i.scope, onExitScope: i.onExitScope,
        onDeleteLayer: i.onDeleteLayer, diagnoseAnchorRef: i.diagnoseAnchorRef, savingState: i.savingState, tab,
        onTabChange: setTab,
        // `managed` rides on the row the header derives its live state from.
        automation: isStep ? null : (readOnly && serverAutomation ? { ...serverAutomation, managed: i.managedPart || {} } : serverAutomation),
        onPublish: i.onPublish,
        // Undo/redo act on the CANVAS draft: pressing them from Settings or
        // Runs used to mutate a definition the user could not see. Jump to
        // the Editor first, so the change lands in view.
        onUndo: () => { if (tab !== 'build') setTab('build'); draftHistory.undo(); },
        onRedo: () => { if (tab !== 'build') setTab('build'); draftHistory.redo(); },
        canUndo: draftHistory.canUndo, canRedo: draftHistory.canRedo,
        // Rendered by the header itself, so the strip follows the bar into
        // BuildTab's ribbon instead of only existing on the other views.
        breadcrumbSlot: i.breadcrumbSlot,
    };
}
