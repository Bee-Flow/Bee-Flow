// The code step's settings, in the drawer.
//
// Two people open this editor. The one who did not write the code sees what
// the step is for, a form for the parameters the code declares (JSDoc on
// `main`), a line that says what the step can reach, and the code folded
// behind "Edit code". The one who writes code gets the editor, the contract
// the sandbox hands it, and the large editor with the assistant, the checks
// and a test run. With no declared parameters the drawer is the author's
// view it always was.
//
// The server reads the code (POST /code/analyze, debounced): parameters,
// findings, capabilities. When it cannot (offline, an older server), this is
// the author's view and nothing is lost.
import { Maximize2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import AccordionSectionJs from '../../AccordionSection';
import { ForEachSection, RetrySection, retryIsSet } from '../collectionEditors';
import CapabilityLine from '../codeStep/CapabilityLine';
import CodeParamsForm from '../codeStep/CodeParamsForm';
import { upstreamFieldsFrom, type InputsMap } from '../codeStep/codeParams';
import CodeSourceBlock, { codeInputsRoundTrip } from '../codeStep/CodeSourceBlock';
import FindingsBanner from '../codeStep/FindingsBanner';
import { useLargeEditorRequest } from '../codeStep/largeEditorSignal';
import CodeLargeEditor, { type LargeEditorTab } from '../codeStep/CodeLargeEditor';
import { useStepCodeAnalysis, type StepCodeAnalysis } from '../codeStep/useStepCodeAnalysis';
import { hintTextClass } from '../formPrimitives';

export { readCodeContract } from '../codeStep/readCodeContract';

// The section is untyped JS; its props are checked there.
const AccordionSection = AccordionSectionJs as unknown as ComponentType<Record<string, unknown> & { children?: ReactNode }>;

type Obj = Record<string, unknown>;
export interface CodeDraft extends Obj {
    code?: string;
    inputs?: InputsMap;
    allowedHosts?: string[];
    allowedTools?: string[];
    forEach?: unknown;
}

export interface CodeFieldsProps {
    draft: CodeDraft;
    set: (key: string, value: unknown) => void;
    groups?: unknown[];
    onFocusField?: unknown;
    errorSections?: Set<string>;
    step?: { id?: string; code?: string; label?: string; allowedTools?: string[] } & Obj | null;
    automation?: { id?: string } & Obj | null;
    previewSample?: unknown;
    catalog?: unknown;
    runStep?: unknown;
}

function OpenLargeButton({ onOpen }: { onOpen: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onOpen}
            data-testid="code-open-large"
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-[var(--border-default)] text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
        >
            <Maximize2 size={11} aria-hidden="true" />
            {t('code_step.open_large', 'Open large editor')}
        </button>
    );
}

/**
 * Who is looking: the step OPENED with code that declares parameters (fold the
 * code away), or not (the author's view). Decided once, from the code the
 * step opened with, so an author typing a first @param keeps the editor.
 */
function useStartedWithParams(state: StepCodeAnalysis, initialCode: string): boolean | null {
    const [started, setStarted] = useState<boolean | null>(() => (initialCode.trim() ? null : false));
    const count = state.analysis ? state.analysis.params.length : null;
    useEffect(() => {
        if (started === null && count !== null) setStarted(count > 0);
    }, [started, count]);
    return started;
}

function ParamsBlock({ state, draft, allowedTools, set, onFocusField, previewSample, onOpen }: {
    state: StepCodeAnalysis; draft: CodeDraft; allowedTools: string[]; set: CodeFieldsProps['set']; onFocusField?: unknown; previewSample?: unknown; onOpen: () => void;
}) {
    const a = state.analysis;
    if (!a) return null;
    return (
        <div className="space-y-3">
            {a.description && <p className="text-[13px] leading-snug text-[var(--text-primary)]" data-testid="code-description">{a.description}</p>}
            <CapabilityLine caps={a.capabilities} allowedHosts={draft.allowedHosts || []} />
            <FindingsBanner analysis={a} allowedTools={allowedTools} onOpen={onOpen} />
            <CodeParamsForm
                params={a.params}
                inputs={draft.inputs || {}}
                inputsRead={a.capabilities.inputsRead}
                onChange={(next) => set('inputs', next)}
                onFocusField={onFocusField}
                previewSample={previewSample}
            />
        </div>
    );
}

export function CodeFields(props: CodeFieldsProps) {
    const { draft, set, groups = [], onFocusField = null, errorSections = new Set<string>(), step = null, automation = null, previewSample = null } = props;
    const { t } = useTranslation();
    // allowedTools lives on the saved step (the AI builder sets it; the form
    // does not edit it), allowedHosts in the draft (the Checks tab edits it).
    const allowedTools = useMemo(() => (Array.isArray(step?.allowedTools) ? step.allowedTools : []), [step?.allowedTools]);
    const upstreamFields = useMemo(() => upstreamFieldsFrom(groups), [groups]);
    const state = useStepCodeAnalysis({
        code: draft.code || '',
        allowedHosts: draft.allowedHosts || [],
        allowedTools,
        automationId: typeof automation?.id === 'string' ? automation.id : null,
        stepId: typeof step?.id === 'string' ? step.id : null,
    });
    const [initialCode] = useState(() => draft.code || '');
    const startedWithParams = useStartedWithParams(state, initialCode);
    // Cheap (two pure calls) and asked once per open node.
    const inputsEditable = useMemo(() => codeInputsRoundTrip(), []);
    const [large, setLarge] = useState<LargeEditorTab | null>(null);
    const openLarge = (tab: LargeEditorTab = 'assistant') => setLarge(tab);
    useLargeEditorRequest(typeof step?.id === 'string' ? step.id : null, () => openLarge());
    const hasParams = !!state.analysis?.params.length;

    return (
        <>
            <AccordionSection
                stepType="code" sectionKey="code" title={t('code_step.section.code', 'Code')} defaultOpen
                forceOpen={errorSections.has('code')}
                meta={<OpenLargeButton onOpen={() => openLarge()} />}
            >
                {hasParams && (
                    <ParamsBlock state={state} draft={draft} allowedTools={allowedTools} set={set} onFocusField={onFocusField} previewSample={previewSample} onOpen={() => openLarge('checks')} />
                )}
                <CodeSourceBlock
                    draft={{ ...draft, allowedTools }}
                    set={set}
                    state={state}
                    foldable={hasParams && startedWithParams === true}
                    pending={startedWithParams === null && state.reading}
                    showInputs={!hasParams && inputsEditable}
                    inputsEditable={inputsEditable}
                    onFocusField={onFocusField}
                    onOpenChecks={() => openLarge('checks')}
                />
                {state.failed && <p className={hintTextClass()}>{t('code_step.checks_unavailable', 'The safety checks could not run just now. The step still saves; the checks run again when the code changes.')}</p>}
            </AccordionSection>
            {/* Run-once-per-item: the runner and validator have always allowed it here. */}
            <AccordionSection stepType="code" sectionKey="advanced" title={t('code_step.section.advanced', 'Advanced')} defaultOpen={!!draft.forEach || retryIsSet(draft)} forceOpen={errorSections.has('advanced')} hasContent={!!draft.forEach || retryIsSet(draft)}>
                <ForEachSection draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
                <RetrySection draft={draft} set={set} />
            </AccordionSection>
            {large && (
                <CodeLargeEditor
                    initialTab={large}
                    onClose={() => setLarge(null)}
                    draft={draft}
                    set={set}
                    state={state}
                    stepLabel={typeof step?.label === 'string' ? step.label : ''}
                    automationId={typeof automation?.id === 'string' ? automation.id : null}
                    stepId={typeof step?.id === 'string' ? step.id : null}
                    allowedTools={allowedTools}
                    upstreamFields={upstreamFields}
                    onFocusField={onFocusField}
                />
            )}
        </>
    );
}
