import { useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { PreviewFn } from '@/api/queries/automation/tablePreview';
import { useVariablePickerContext } from '@/components/automation/Builder/mapping/VariablePickerContext';
import AccordionSection from '../../AccordionSection';
import { hintTextClass, inputClass } from '../formPrimitives';
import StepField from './StepField';
import IterationSection from './IterationSection';
import { opHelp, type Translate } from './opHelp';
import { NumberInput } from './ops/inputs';
import type { OpContext } from './ops/opFormTypes';
import TableOpForm from './TableOpForm';
import TableOpList from './TableOpList';
import TablePreviewPane from './TablePreviewPane';
import TableSourceField, { nearestTableBinding } from './TableSourceField';
import { isBlankBinding, withDefaults, type Binding, type TableOp } from './tableOpModel';
import { useTableEditorData } from './useTableEditorData';

interface Draft {
    label?: string;
    source: Binding | null;
    ops: TableOp[];
    name: string;
    expiresInDays: number;
    forEach?: unknown;
}

interface Props {
    draft: Draft;
    set: (key: string, value: unknown) => void;
    groups?: unknown[];
    onFocusField?: unknown;
    previewSample?: unknown;
    errorSections?: Set<string>;
    /** The automation being edited: the preview asks the server about it. Without one there is no preview. */
    automationId?: string | null;
    /** Replaceable, so a test can answer instead of the server. */
    preview?: PreviewFn;
    /** Runs the steps before this one, when the editor can. */
    onRunPrevious?: (() => void) | null;
}

/**
 * "Edit table": pick the table, then list what to do with it, step by step,
 * with a preview of the first rows after every change. Every setting that
 * names a column is a picker over the columns that reach that step.
 */
export default function TableFields({ draft, set, groups, onFocusField, previewSample: sampleProp, errorSections, automationId, preview, onRunPrevious = null }: Props) {
    const { t } = useTranslation();
    const picker = useVariablePickerContext();
    const previewSample = sampleProp ?? picker.previewSample;
    const [openId, setOpenId] = useState<string | null>(null);
    const ops = (Array.isArray(draft.ops) ? draft.ops : []).map(withDefaults);
    const open = ops.findIndex(o => o.id === openId);
    const upTo = open >= 0 && open < ops.length - 1 ? ops[open] : null;
    const data = useTableEditorData({ automationId, source: draft.source, ops, upToOpId: upTo ? upTo.id : null, previewSample, preview });
    const help = opHelp(t as Translate);

    // A new step starts on the nearest table an earlier step makes.
    useEffect(() => {
        if (!isBlankBinding(draft.source)) return;
        const nearest = nearestTableBinding(picker.groups as never);
        if (nearest) set('source', nearest);
    }, [draft.source, picker.groups, set]);

    const ctxFor = (op: TableOp, index: number): OpContext => ({
        columns: data.columnsInto(index),
        described: data.described,
        issues: data.issues[index] || [],
        help,
        otherColumns: data.otherColumns(op),
        sampleRow: data.sourceRow,
        onFocusField,
        previewSample,
        groups,
    });
    const setOps = (next: TableOp[]) => set('ops', next);
    const stepFindings = data.findings.filter(f => !/^ops\[\d+\]/.test(f.path));

    return (
        <>
            <AccordionSection stepType="table" sectionKey="config" title={t('automations.node.table.typeLabel', 'Edit table')} defaultOpen forceOpen={!!errorSections?.has('config')}>
                <div className="flex flex-col gap-3">
                    <StepField label={t('automation_tables.fields.source', 'Table to work on')} help={t('automation_tables.fields.source_help', 'The table made by an earlier step, such as Read table. This step changes a copy; the original stays as it was.')} required>
                        <TableSourceField
                            value={draft.source} onChange={b => set('source', b)} onFocusField={onFocusField} previewSample={previewSample}
                            ariaLabel={t('automation_tables.fields.source', 'Table to work on')}
                        />
                    </StepField>
                    <div className="flex flex-col gap-1.5">
                        <div className="text-[12px] font-medium text-[var(--text-secondary)]">{t('automation_tables.fields.steps', 'What to do with it')}</div>
                        {ops.length === 0 && <p className={hintTextClass()}>{t('automation_tables.fields.no_steps', 'Add the first step. The steps run from top to bottom.')}</p>}
                        <TableOpList
                            ops={ops} onChange={setOps} openId={openId} onOpen={setOpenId} results={data.opResults} problems={data.problems} help={help}
                            renderForm={(op, index) => (
                                <TableOpForm op={op} ctx={ctxFor(op, index)} onChange={next => setOps(ops.map((o, i) => (i === index ? next : o)))} />
                            )}
                        />
                    </div>
                    <TablePreviewPane state={data.preview} hasSource={!!data.sourceRef} upTo={upTo ? help.ops[upTo.op].title : ''} findings={stepFindings} onRunPrevious={onRunPrevious} />
                </div>
            </AccordionSection>
            <AccordionSection stepType="table" sectionKey="output" title={t('automation_tables.fields.output', 'Result')} forceOpen={!!errorSections?.has('output')}>
                <StepField label={t('automation_tables.fields.name', 'Name of the result')} help={t('automation_tables.fields.name_help', 'Shown above the table in the run. Leave empty to use the name of this step.')}>
                    <input type="text" aria-label={t('automation_tables.fields.name', 'Name of the result')} value={draft.name || ''} onChange={e => set('name', e.target.value)} className={inputClass()} />
                </StepField>
                <StepField label={t('automation_tables.fields.keep', 'Keep the result for (days)')} help={t('automation_tables.fields.keep_help', 'After this many days the stored table is deleted. From 1 to 90.')}>
                    <NumberInput value={draft.expiresInDays ?? 7} min={1} max={90} onChange={n => set('expiresInDays', n ?? 7)} ariaLabel={t('automation_tables.fields.keep', 'Keep the result for (days)')} />
                </StepField>
            </AccordionSection>
            <IterationSection stepType="table" draft={draft as unknown as Record<string, unknown>} set={set} groups={groups} onFocusField={onFocusField} errorSections={errorSections} />
        </>
    );
}
