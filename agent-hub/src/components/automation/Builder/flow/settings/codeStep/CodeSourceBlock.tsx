// The code itself in the drawer: the contract the sandbox hands it, the
// editor, the inputs table when the code declares no parameters, and what the
// step may reach. Folded behind "Edit code" when the step arrived with
// parameters, so the person filling them in is not looking at JavaScript.
//
// Rendered at the same place in the tree in every mode, so the editor keeps
// its cursor when the author's typing adds or removes a parameter.
import { ChevronDown, ChevronRight, Code2 } from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import ToolInputFormJs from '../../../mapping/ToolInputForm';
import { FormRow, SectionNote, hintTextClass } from '../formPrimitives';
import { buildPatch, extractFormState } from '../formState';
import CodeEditorField from './CodeEditorField';
import type { InputsMap } from './codeParams';
import FindingsBanner from './FindingsBanner';
import ReachPanel from './ReachPanel';
import { readCodeContract } from './readCodeContract';
import type { StepCodeAnalysis } from './useStepCodeAnalysis';

const ToolInputForm = ToolInputFormJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * Can a code step's `inputs` survive a save? The table is offered only when
 * the form's round trip carries them in BOTH directions: a draft key that
 * buildPatch does not forward is silently dropped by the autosave, and a
 * patch that forwards inputs the draft never read would wipe the step's real
 * ones on every unrelated save (C12/C16/C18). Asked with a CHANGED draft,
 * because buildPatch sends only what differs from the step.
 */
export function codeInputsRoundTrip(): boolean {
    const probe = { id: 'probe_code', type: 'code', code: '', inputs: { probe_key: { kind: 'literal', value: 'x' } } };
    try {
        const draft = extractFormState(probe) as { inputs?: Record<string, unknown> } | null;
        if (!draft?.inputs?.probe_key) return false;
        const edited = { ...draft, inputs: { probe_key: { kind: 'literal', value: 'y' } } };
        const patch = buildPatch(probe, edited) as { inputs?: Record<string, { value?: unknown }> } | null;
        return patch?.inputs?.probe_key?.value === 'y';
    } catch {
        return false;
    }
}

interface CodeSourceBlockProps {
    draft: { code?: string; inputs?: InputsMap; allowedTools?: string[] };
    set: (key: string, value: unknown) => void;
    state: StepCodeAnalysis;
    /** Folded behind "Edit code" (the step arrived with parameters). */
    foldable: boolean;
    /** The step opened with code and its first reading is on its way. */
    pending: boolean;
    showInputs: boolean;
    inputsEditable: boolean;
    onFocusField?: unknown;
    onOpenChecks: () => void;
}

function ContractNote() {
    const { t } = useTranslation();
    // The numbers are codeSandbox.js's defaults; a step may carry its own
    // `limits`, which the sandbox clamps to 10s CPU / 30s wall / 256MB / 20 calls.
    return (
        <SectionNote>
            {t('code_step.contract', 'Runs in a sandbox: write async function main(inputs, ctx) and return the result. ctx.log(…) writes to the run, ctx.http(url, opts) fetches over HTTPS only, and ctx.integrations.<tool>(args) calls a connected app this step has been granted. Budget per run: ~1s of processing, 5s of wall clock, 64 MB and 5 HTTP calls.')}
        </SectionNote>
    );
}

function FoldToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <button type="button" aria-expanded={open} onClick={onToggle} data-testid="code-edit-toggle" className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <Chevron size={13} aria-hidden="true" />
            <Code2 size={13} aria-hidden="true" />
            {open ? t('code_step.hide_code', 'Hide code') : t('code_step.edit_code', 'Edit code')}
        </button>
    );
}

export default function CodeSourceBlock({ draft, set, state, foldable, pending, showInputs, inputsEditable, onFocusField = null, onOpenChecks }: CodeSourceBlockProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const contract = useMemo(() => readCodeContract(draft.code || ''), [draft.code]);
    const shown = !foldable || open;
    if (pending) {
        // First answer on its way: say so instead of showing the code for a
        // moment to someone who is about to get a form.
        return <p className={`${hintTextClass()} italic`} data-testid="code-reading">{t('code_step.reading', 'Reading the code…')}</p>;
    }
    return (
        <div className="space-y-3">
            {foldable && <FoldToggle open={open} onToggle={() => setOpen(o => !o)} />}
            {!foldable && <FindingsBanner analysis={state.analysis} allowedTools={draft.allowedTools || []} onOpen={onOpenChecks} />}
            {shown && (
                <>
                    <ContractNote />
                    <FormRow label={t('code_step.editor.label', 'JavaScript code')} hint={null}>
                        <CodeEditorField value={draft.code || ''} onChange={(v) => set('code', v)} analysis={state.analysis} />
                    </FormRow>
                    {showInputs && (
                        <FormRow label={t('code_step.inputs.label', 'Inputs')} hint={t('code_step.inputs.hint', 'Named values handed to your code as inputs. Bind them to earlier steps the same way every other step type does.')}>
                            <ToolInputForm
                                inputs={draft.inputs || {}}
                                onChange={(next: InputsMap) => set('inputs', next)}
                                keepEmptyFields
                                namePlaceholder={t('code_step.params.input_name', 'input name')}
                                onFocusField={onFocusField}
                            />
                        </FormRow>
                    )}
                    <ReachPanel contract={contract} inputsEditable={inputsEditable} />
                </>
            )}
        </div>
    );
}
