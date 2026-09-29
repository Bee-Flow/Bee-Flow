// The parameters a code step declares, as a form: label, a short description
// as the hint, the default as the placeholder, a Required chip, and the same
// "take it from an earlier step" mapping every other step type has. Values
// write `step.inputs`. Inputs the code reads without describing them sit
// under "Other inputs", so nothing an older step carries is ever lost.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import type { CodeParam } from '../../../../../../api/queries/automation/codeStep';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import ToolInputFormJs from '../../../mapping/ToolInputForm';
import { hintTextClass, subLabelClass } from '../formPrimitives';
import { paramsToSchema, splitInputs, type InputsMap } from './codeParams';

// ToolInputForm is untyped JS; its props are checked there.
const ToolInputForm = ToolInputFormJs as unknown as ComponentType<Record<string, unknown>>;

interface CodeParamsFormProps {
    params: CodeParam[];
    inputs: InputsMap;
    onChange: (next: InputsMap) => void;
    /** Input names the code reads (from the analysis), for the undeclared ones. */
    inputsRead?: string[];
    onFocusField?: unknown;
    previewSample?: unknown;
}

function OtherInputs({ shown, onChange, onFocusField, previewSample }: {
    shown: InputsMap; onChange: (next: InputsMap) => void; onFocusField?: unknown; previewSample?: unknown;
}) {
    const { t } = useTranslation();
    const count = Object.keys(shown).length;
    const [open, setOpen] = useState(count > 0);
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <div className="pt-2 border-t border-[var(--border-subtle)] space-y-2">
            <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className={`${subLabelClass()} inline-flex items-center gap-1`}>
                <Chevron size={12} aria-hidden="true" />
                {count > 0 ? t('code_step.params.other_n', 'Other inputs ({count})', { count }) : t('code_step.params.other', 'Other inputs')}
            </button>
            {open && (
                <>
                    <p className={hintTextClass()}>{t('code_step.params.other_hint', 'Values the code uses without describing them. Named values you add here reach the code as inputs too.')}</p>
                    <ToolInputForm
                        inputs={shown}
                        onChange={onChange}
                        keepEmptyFields
                        namePlaceholder={t('code_step.params.input_name', 'input name')}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                </>
            )}
        </div>
    );
}

export default function CodeParamsForm({ params, inputs, onChange, inputsRead = [], onFocusField = null, previewSample = null }: CodeParamsFormProps) {
    const schema = useMemo(() => paramsToSchema(params), [params]);
    const { declared, others } = splitInputs(inputs, params);
    // A name the code reads but neither declares nor has a value for still
    // gets a row, empty, so the author can see it and fill it.
    const declaredNames = new Set(params.map(p => p.name));
    const shownOthers: InputsMap = { ...others };
    for (const name of inputsRead) {
        if (!declaredNames.has(name) && !(name in shownOthers)) shownOthers[name] = { kind: 'literal', value: '' };
    }
    return (
        <div className="space-y-3" data-testid="code-params-form">
            <ToolInputForm
                inputs={declared}
                inputSchema={schema}
                allowExtraFields={false}
                onChange={(next: InputsMap) => onChange({ ...others, ...next })}
                onFocusField={onFocusField}
                previewSample={previewSample}
            />
            <OtherInputs
                shown={shownOthers}
                onChange={(next) => onChange({ ...declared, ...next })}
                onFocusField={onFocusField}
                previewSample={previewSample}
            />
        </div>
    );
}
