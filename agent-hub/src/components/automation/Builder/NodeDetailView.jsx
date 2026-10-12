import React, { useCallback, useMemo, useRef, useState } from 'react';
import ApprovalActionBar from './approvals/ApprovalActionBar';
import { buildStepLabelMap } from './flow/displayHelpers';
import { isRouteStep } from './flow/routeModel';
import { FormDensityContext, resolveMode } from './flow/settings/formDensity';
import FormModeToggle from './flow/settings/FormModeToggle';
import SettingsHost from './flow/settings/SettingsHost';
import InputDataPanel from './mapping/InputDataPanel';
import { VariablePickerProvider } from './mapping/VariablePickerContext';
import NdvColumnHeader from './ndv/NdvColumnHeader';
import NdvFooterInfo from './ndv/NdvFooterInfo';
import NdvHeader from './ndv/NdvHeader';
import { familyOf, familyWord, headerTitle, incomingSummary, lastRunPill, whatItDoes } from './ndv/ndvModel';
import NdvOutputColumn from './ndv/NdvOutputColumn';
import NdvQuickOutput from './ndv/NdvQuickOutput';
import NdvSideColumn from './ndv/NdvSideColumn';
import stepPlumbing from './ndv/stepPlumbing';
import useNdvLayout from './ndv/useNdvLayout';
import useOutputEditor from './ndv/useOutputEditor';
import useStepPatchSave from './ndv/useStepPatchSave';
import useHiddenSections from './useHiddenSections';
import useNdvNavigation from './useNdvNavigation';
import useNdvPanels from './useNdvPanels';
import useNodeDetailData from './useNodeDetailData';
import { useTranslation } from '../../../hooks/useTranslation';
import { walkPath } from '../../../utils/bindingHelpers';

/**
 * Node Detail View (NDV): the focused editor for a single step, at two
 * densities.
 *
 *   'quick' (a single click on a node): just the fields that make the step
 *      work, plus a one-line "what goes in, what comes out".
 *   'full'  (a double click, or "More options"): three numbered columns that
 *      read as one sentence (round 4): 1 Comes in · 2 What this step does ·
 *      3 Continues on, each with a one-line summary in its header.
 *
 * Both are the SAME component and the same save path, so switching between
 * them mid-edit cannot lose anything. The header, the column heads, the save
 * machine and the output editor live in ./ndv/; this file composes them.
 */
// The quick drawer grows with the screen: a fixed 300px left room for the
// name and the action card only, and the first setting fell below the fold on
// a laptop. Never shorter than before, never taller than half the canvas area.
const QUICK_H = 'clamp(300px, 42vh, 520px)';
const QUICK_H_STACKED = 'clamp(420px, 55vh, 680px)';

export default function NodeDetailView({
    step, runStep, runSteps = [], definition, rootDefinition = null, blocksCatalog = [], onSaveStep,
    // (base, from, to) => number|undefined. The shell's edit (BuildTab.onRenameBinding).
    onRenameBinding = null,
    // (stepId, step) => boolean|undefined. The shell's edit (BuildTab.onInsertStepBefore).
    onInsertStepBefore = null,
    onFollowRoute = null, // (routeId, stepIds) => void: BuildTab.onFollowRoute ("Use what this Condition keeps").
    validation, modelTiers = {}, onExecuteStep, onRetryFromStep,
    runInFlight = false, executingStep = false, onClose,
    // 'quick' | 'full': how BIG the window is. Owned by the shell.
    density = 'full',
    onDensityChange = null,
    // 'simple' | 'advanced' | null: how MUCH of the form exists (useFormModePreference).
    mode = null,
    onModeChange = null,
    // The persisted automation row (the webhook trigger's settings need it).
    automation = null,
    // Node actions shared with the canvas chrome (BFSF-319). Omitted on read-only surfaces.
    onDeleteStep = null,
    onDuplicateStep = null,
    // Real run/pinned outputs (mapping/realOutputs buildRealOutputMap).
    realOutputById = null,
    // Tool catalog from the owner (BuildTab); fetched here when absent.
    catalog: catalogProp = null,
    // Open another node of the same graph (BFSF-332). Omitted on read-only surfaces.
    onNavigate = null,
    // (stepId) => void: draw a loop's contents on the canvas instead.
    onExpandOnCanvas = null,
    // (stepId, 'loop' | 'datatable' | null) => void: the Continues-on column's
    // "what next?" buttons (BuildTab.onAddAfterStep). Omitted on read-only surfaces.
    onAddAfterStep = null,
}) {
    const { t } = useTranslation();
    const {
        catalog, isSecondaryTrigger, wiredCaseNames, stepEdges, groups, previewSample,
        stepTypeById, stepNumberById, usedPaths, stepIssues,
        describedSample, emptyFormAnswers, loopContext, inSummary, outSummary, routeFollow, wholeRun,
    } = useNodeDetailData({
        step, runStep, runSteps, definition, rootDefinition, validation,
        catalog: catalogProp, realOutputById, onFollowRoute,
    });
    const stepLabelById = useMemo(() => buildStepLabelMap(definition), [definition]);

    // Active field <-> Incoming tree wiring (click/drag a field to insert it).
    // `opts` rides along so an Alt-click can bypass the list chooser.
    const activeFieldRef = useRef(null);
    const [activeLabel, setActiveLabel] = useState(null);
    const onFocusField = (handle) => { activeFieldRef.current = handle; setActiveLabel(handle?.label || null); };
    const onInsertFromTree = (path, opts) => { activeFieldRef.current?.insert?.(path, opts); };

    const quick = density === 'quick';
    const goFull = useCallback(() => onDensityChange?.('full'), [onDensityChange]);
    const goQuick = useCallback(() => onDensityChange?.('quick'), [onDensityChange]);
    const effectiveMode = resolveMode({ mode, density });
    const { hiddenCount, densityValue } = useHiddenSections({ step, density, mode });

    const panels = useNdvPanels();
    const { quickOutputOpen, setQuickOutputOpen, drawerH, onHResizeDown, onHResizeMove, onHResizeUp } = panels;
    // Which side columns fit, and how wide, by the drawer's OWN width (ndv/ndvLayout.ts).
    const { drawerRef, layout, onSide, sideProps, showOutputForTest, quickStacked } = useNdvLayout({ panels, quick, goFull });

    const { position, canNavigate, goPrev, goNext } = useNdvNavigation({ definition, step, onNavigate, onClose });
    const { saving, saveError, saveStatus, lastSavedAt, persistStepPatch, retrySave } = useStepPatchSave({ definition, step, onSaveStep, t });

    const outputPinned = step?.pinnedOutput !== undefined && step?.pinnedOutput !== null;
    // Typed by the author, not captured from a run: the badge says so.
    const outputEdited = outputPinned && step?.pinnedSource === 'edited';
    const outEdit = useOutputEditor({
        t,
        runStepOutput: runStep?.output,
        pinnedOutput: step?.pinnedOutput,
        describedSample,
        emptyFormAnswers,
        outputPinned,
        outputEdited,
        canEditOutput: typeof onSaveStep === 'function' && !!definition,
        saving,
        persistStepPatch,
        onOpened: () => setQuickOutputOpen(true),
    });

    // A fix on the error card that means "change a setting" (other account,
    // pick another, open the setting) shows that setting: the one column 2
    // rings red from runStep.errorInfo.settingKey. False when nothing is
    // ringed, so the card explains in words instead.
    const settingsRef = useRef(null);
    const onFixError = useCallback(() => {
        const ringed = settingsRef.current?.querySelector?.('[data-problem="true"]');
        if (!ringed) return false;
        ringed.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        const target = ringed.querySelector('input, textarea, select, button, [contenteditable="true"], [tabindex]:not([tabindex="-1"])');
        target?.focus?.({ preventScroll: true });
        return true;
    }, []);

    if (!step) return null;
    if (typeof document === 'undefined') return null;

    // step.type is authoritative for "is a trigger" (primary, secondary, a flowlet's layer_input).
    const isTrigger = step.type === 'trigger';
    // Test step is offered on EVERY node, triggers included (BFSF-408, multi-trigger 2026-09).
    const canExecute = typeof onExecuteStep === 'function';
    const isPrimaryTrigger = isTrigger && !!definition?.trigger?.id && definition.trigger.id === step.id;
    // BFSF-408(a): the form trigger's preview submits as an inline test run.
    // The honeypot is anti-bot plumbing, not an answer.
    const onTestSubmit = (canExecute && isTrigger && step.kind === 'form')
        ? async ({ website_url: _honeypot, ...answers }) => { await onExecuteStep(step.id, { mode: 'only', triggerPayload: answers }); }
        : null;
    // Renaming a question's binding name, bound to THIS page's base (null when the shell cannot rewrite).
    const onRenameField = (typeof onRenameBinding === 'function' && (isTrigger ? step.kind === 'form' : step.type === 'form_page'))
        ? (from, to) => onRenameBinding(isTrigger ? 'trigger.output' : `steps.${step.id}.output`, from, to)
        : null;
    // Putting a step in FRONT of a Condition (routeHandoff.js); null everywhere else.
    const onInsertUpstreamStep = (typeof onInsertStepBefore === 'function' && !isTrigger && isRouteStep(step))
        ? (newStep) => onInsertStepBefore(step.id, newStep)
        : null;

    const { canPin, togglePin, pinTitle, menu } = stepPlumbing({
        step, runStep, quick, isTrigger, outputPinned, persistStepPatch, onDuplicateStep, onDeleteStep, onClose, t,
    });
    const onTest = canExecute ? () => { showOutputForTest(); onExecuteStep(step.id); } : null;
    // Retrying from a secondary trigger is not a thing (it has no replay).
    const retryFromHere = (typeof onRetryFromStep === 'function' && (!isTrigger || isPrimaryTrigger))
        ? onRetryFromStep : null;
    const testDisabled = runInFlight || executingStep;

    // The "In … → Out …" line in the form's footer (ndv/NdvFooterInfo.tsx).
    const footerInfo = (
        <NdvFooterInfo
            quick={quick}
            inSummary={inSummary}
            outSummary={outSummary}
            isTrigger={isTrigger}
            onGoFull={goFull}
            modeLink={onModeChange ? <FormModeToggle variant="link" mode={effectiveMode} onChange={onModeChange} hiddenCount={hiddenCount} /> : null}
            hiddenCount={hiddenCount}
        />
    );

    // Who reads this step's output next: the Continues-on footer.
    const downstream = (definition?.edges || [])
        .filter(e => e?.from === step?.id && e?.to)
        .map(e => stepLabelById?.get?.(e.to))
        .filter(Boolean);
    // "A manual start passes little" (artboard 4b): only when the start IS manual.
    const triggerStep = definition?.trigger || null;
    const manualStart = !isTrigger && !!triggerStep && (triggerStep.kind || 'manual') === 'manual'
        && groups.some(g => String(g.basePath || '').startsWith('trigger'));
    const title = headerTitle(step, catalog);

    // A bottom DRAWER, not a modal (design 1h): no portal, no backdrop, no
    // focus trap; the canvas stays usable. data-surface paints the background.
    return (
        <div
            data-surface="default"
            role="dialog"
            aria-label={t('automations.ndv.edit_step', 'Edit {name}', { name: title })}
            data-testid="ndv-drawer"
            data-density={quick ? 'quick' : 'full'}
            ref={drawerRef}
            // Capped so the canvas keeps a readable strip above it on a laptop.
            className="@container/ndv relative flex flex-col flex-shrink-0 border-t border-[var(--border-default)] overflow-hidden max-h-[min(calc(100%-260px),60%)]"
            style={{ height: quick ? (quickStacked ? QUICK_H_STACKED : QUICK_H) : drawerH, boxShadow: '0 -8px 24px rgba(0,0,0,.06)' }}
        >
            {!quick && (
                <div
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={t('automations.ndv.resize_editor', 'Resize the step editor')}
                    onPointerDown={onHResizeDown}
                    onPointerMove={onHResizeMove}
                    onPointerUp={onHResizeUp}
                    className="absolute top-0 left-0 right-0 h-1.5 cursor-row-resize z-20 hover:bg-[var(--bg-tertiary)] transition-colors"
                />
            )}
            <div className="flex-1 min-h-0 flex flex-col">
                <NdvHeader
                    step={step}
                    family={familyOf(step)}
                    kicker={familyWord(step, t)}
                    title={title}
                    position={position}
                    canNavigate={canNavigate}
                    goPrev={goPrev}
                    goNext={goNext}
                    pill={lastRunPill(runStep, outSummary, { pinned: outputPinned, edited: outputEdited }, t)}
                    save={{ state: saveStatus, lastSavedAt, onRetry: saveError ? retrySave : null }}
                    onRetryStep={(retryFromHere && runStep?.status === 'error')
                        ? () => retryFromHere(step.id) : null}
                    retryDisabled={runInFlight}
                    onTest={onTest}
                    testBusy={executingStep}
                    testDisabled={testDisabled}
                    menu={menu}
                    columns={{
                        quick, inputOpen: layout.showInput, outputOpen: layout.showOutput,
                        onInput: () => onSide('input'),
                        onOutput: () => onSide('output'),
                    }}
                    modeToggle={(quick && onModeChange && !isTrigger) ? <FormModeToggle mode={effectiveMode} onChange={onModeChange} size="sm" /> : null}
                    onExpand={quick ? goFull : null}
                    onShrink={!quick && onDensityChange ? goQuick : null}
                    onClose={onClose}
                />

                {runStep?.status === 'awaiting_approval' && runStep?.runId && (
                    <ApprovalActionBar
                        runId={runStep.runId}
                        stepId={step?.id}
                        // The run's rendered question first; the raw prompt is the fallback.
                        prompt={runStep?.output?.prompt || step?.prompt}
                        fields={Array.isArray(step?.approval?.fields) ? step.approval.fields : null}
                    />
                )}

                {/* Quick density: the settings and the output side by side when
                    the drawer is wide, stacked when it is not. */}
                <div className={`flex-1 min-h-0 flex ${quick ? `flex-col ${quickOutputOpen ? '@min-[1100px]/ndv:flex-row' : ''}` : ''}`}>
                    {!quick && layout.showInput && (
                        <NdvSideColumn {...sideProps('input')}>
                            <NdvColumnHeader
                                n={1}
                                testId="ndv-col-input"
                                title={t('automations.ndv.col_comes_in', 'Comes in')}
                                summary={incomingSummary(groups, previewSample, inSummary, walkPath, t)}
                            >
                                {activeLabel && <span className="text-[11px] text-[var(--text-secondary)] truncate max-w-[140px]">→ {activeLabel}</span>}
                                {inSummary?.label && (
                                    <span className="shrink-0 px-[7px] rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11px] font-semibold text-[var(--text-primary)]" data-testid="ndv-in-summary-pill">
                                        {inSummary.label}
                                    </span>
                                )}
                            </NdvColumnHeader>
                            <InputDataPanel
                                groups={groups}
                                previewSample={previewSample}
                                onPick={onInsertFromTree}
                                stepTypeById={stepTypeById}
                                stepNumberById={stepNumberById}
                                usedPaths={usedPaths}
                                loopIteration={loopContext?.iteration || null}
                                onAddStartQuestion={manualStart && typeof onNavigate === 'function' ? () => onNavigate(triggerStep.id) : null}
                                manualStart={manualStart}
                            />
                        </NdvSideColumn>
                    )}

                    <div ref={settingsRef} className={`min-w-0 min-h-0 flex flex-col ${quick && quickOutputOpen ? 'flex-[3_1_0%] @min-[1100px]/ndv:flex-[4_1_0%] @min-[1100px]/ndv:max-w-[920px]' : 'flex-1'}`}>
                        {!quick && (
                            <NdvColumnHeader
                                n={2}
                                active
                                testId="ndv-col-params"
                                title={t('automations.ndv.col_does', 'What this step does')}
                                summary={whatItDoes(step, catalog, t)}
                            >
                                {/* "runs 4× · one per bank" (artboard 2b): a step in a loop runs once per item. */}
                                {loopContext && (
                                    <span className="shrink-0 px-[7px] rounded-full text-[11px] font-semibold leading-[18px] bg-[color-mix(in_srgb,var(--type-loop)_16%,transparent)] text-[var(--type-loop)]" data-testid="ndv-runs-pill">
                                        {loopContext.itemNoun
                                            ? t('automations.ndv.runs_n_times_per_item', 'runs {n}× · once per {item}', { n: loopContext.runs, item: loopContext.itemNoun })
                                            : loopContext.listLabel
                                                ? t('automations.ndv.runs_n_times_per', 'runs {n}× · one per {list}', { n: loopContext.runs, list: loopContext.listLabel })
                                                : t('automations.ndv.runs_n_times', 'runs {n}×', { n: loopContext.runs })}
                                    </span>
                                )}
                                {onModeChange && !isTrigger && <FormModeToggle mode={effectiveMode} onChange={onModeChange} size="sm" />}
                            </NdvColumnHeader>
                        )}
                        <FormDensityContext.Provider value={densityValue}>
                            <VariablePickerProvider groups={groups} previewSample={previewSample} stepLabelById={stepLabelById} stepTypeById={stepTypeById} definition={definition}>
                                <SettingsHost
                                    key={step.id}
                                    footerLeft={footerInfo}
                                    compactFooter={quick}
                                    step={step}
                                    modelTiers={modelTiers}
                                    stepIssues={stepIssues}
                                    saving={saving}
                                    saveError={saveError}
                                    onPatch={persistStepPatch}
                                    onFocusField={onFocusField}
                                    previewSample={previewSample}
                                    catalog={catalog}
                                    groups={groups}
                                    rootDefinition={rootDefinition || definition}
                                    automation={automation}
                                    blocksCatalog={blocksCatalog}
                                    wiredCaseNames={wiredCaseNames}
                                    stepEdges={stepEdges}
                                    isSecondaryTrigger={isSecondaryTrigger}
                                    onTestSubmit={onTestSubmit}
                                    onRenameField={onRenameField}
                                    onInsertUpstreamStep={onInsertUpstreamStep}
                                    routeFollow={routeFollow} wholeRun={wholeRun}
                                    onExpandOnCanvas={onExpandOnCanvas}
                                    runStep={runStep}
                                />
                            </VariablePickerProvider>
                        </FormDensityContext.Provider>
                    </div>

                    {!quick && layout.showOutput && (
                        <NdvSideColumn {...sideProps('output')}>
                            <NdvOutputColumn
                                step={step}
                                runStep={runStep}
                                outSummary={outSummary}
                                isTrigger={isTrigger}
                                editButton={outEdit.button}
                                editorOpen={outEdit.open}
                                editor={outEdit.editor}
                                downstream={downstream}
                                definition={definition}
                                describedSample={describedSample}
                                automationId={automation?.id ?? null}
                                onAddAfterStep={onAddAfterStep}
                                onRetryFromStep={retryFromHere}
                                onFixError={onFixError}
                            />
                        </NdvSideColumn>
                    )}

                    {quick && (
                        <NdvQuickOutput
                            step={step}
                            runStep={runStep}
                            outSummary={outSummary}
                            open={quickOutputOpen}
                            onToggle={() => setQuickOutputOpen(o => !o)}
                            editButton={outEdit.button}
                            editor={outEdit.editor}
                            editorOpen={outEdit.open}
                            isTrigger={isTrigger}
                            pinned={outputPinned}
                            edited={outputEdited}
                            canPin={canPin}
                            pinTitle={pinTitle}
                            onTogglePin={togglePin}
                            onRetryFromStep={retryFromHere}
                            onFixError={onFixError}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

// Where the drawer's "In 2 records" and "runs 4×" claims come from. Exported
// from here because this is the module their contract is tested through.
export { resolveInSummary, resolveLoopContext } from './useNodeDetailData';
