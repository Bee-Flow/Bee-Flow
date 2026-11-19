import { Plus, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { walkPath } from '@/utils/bindingHelpers';
import { useVariablePickerContext } from '@/components/automation/Builder/mapping/VariablePickerContext';
import AccordionSection from '../../AccordionSection';
import { inputClass, rowInputClass } from '../formPrimitives';
import StepField from './StepField';
import { NumberInput, Radios } from './ops/inputs';
import TableSourceField from './TableSourceField';
import { pathOf, type Binding } from './tableOpModel';
import type { OutputColumn } from '../formState/writeTable';

interface Draft {
    source: Binding | null;
    format: 'xlsx' | 'csv';
    fileName: string;
    sheetName: string;
    columns: OutputColumn[];
    highlightColumn: string;
    delimiter: string;
    expiresInDays: number;
}

interface Props {
    draft: Draft;
    set: (key: string, value: unknown) => void;
    onFocusField?: unknown;
    previewSample?: unknown;
    errorSections?: Set<string>;
}

const DELIMITERS = [';', ',', '\t'] as const;

/** The column names of the source table as the last run (or the sample) saw them. */
function knownColumns(source: Binding | null, sample: unknown): string[] {
    const path = pathOf(source);
    const columns = path ? walkPath(`${path}.columns`, sample) : undefined;
    if (!Array.isArray(columns)) return [];
    return columns.map(c => (c && typeof c === 'object' ? String((c as { label?: unknown; key?: unknown }).label ?? (c as { key?: unknown }).key ?? '') : '')).filter(Boolean);
}

function ColumnList({ value, onChange, listId }: { value: OutputColumn[]; onChange: (v: OutputColumn[]) => void; listId: string }) {
    const { t } = useTranslation();
    const update = (i: number, patch: Partial<OutputColumn>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    return (
        <div className="flex flex-col gap-1.5">
            {value.map((c, i) => (
                <div key={i} className="flex items-center gap-1.5">
                    <input
                        type="text" list={listId} value={c.column} onChange={e => update(i, { column: e.target.value })}
                        aria-label={t('automation_write_table.column', 'Column {n}', { n: i + 1 })}
                        placeholder={t('automation_write_table.column_placeholder', 'Column of the table')}
                        className={rowInputClass('min-w-0 flex-1')}
                    />
                    <input
                        type="text" value={c.header ?? ''} onChange={e => update(i, { header: e.target.value || null })}
                        aria-label={t('automation_write_table.header', 'Heading of column {n}', { n: i + 1 })}
                        placeholder={t('automation_write_table.header_placeholder', 'Heading (optional)')}
                        className={rowInputClass('min-w-0 flex-1')}
                    />
                    <button
                        type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}
                        aria-label={t('automation_write_table.remove_column', 'Remove column {n}', { n: i + 1 })}
                        className="rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    ><X size={12} /></button>
                </div>
            ))}
            <button type="button" onClick={() => onChange([...value, { column: '', header: null }])} className="inline-flex items-center gap-1 self-start text-xs text-[var(--accent)] hover:underline">
                <Plus size={12} />{t('automation_write_table.add_column', 'Add a column')}
            </button>
        </div>
    );
}

/**
 * "Write table": a table of the run as an Excel or CSV file the next steps can
 * mail, upload or offer as a download. Simple asks which table, which file type
 * and its name; the columns, the rows to mark and how long the file is kept
 * are under Advanced.
 */
export default function WriteTableFields({ draft, set, onFocusField, previewSample: sampleProp, errorSections }: Props) {
    const { t } = useTranslation();
    const picker = useVariablePickerContext();
    const previewSample = sampleProp ?? picker.previewSample;
    const listId = useId();
    const known = knownColumns(draft.source, previewSample);
    const delimiterLabel: Record<string, string> = {
        ';': t('automation_write_table.delimiter_semicolon', 'Semicolon (Excel in Dutch and many other languages)'),
        ',': t('automation_write_table.delimiter_comma', 'Comma'),
        '\t': t('automation_write_table.delimiter_tab', 'Tab'),
    };
    return (
        <>
            <AccordionSection stepType="write_table" sectionKey="config" title={t('automations.node.write_table.typeLabel', 'Write table')} defaultOpen forceOpen={!!errorSections?.has('config')}>
                <div className="flex flex-col gap-3">
                    <StepField label={t('automation_write_table.source', 'Table to write')} help={t('automation_write_table.source_help', 'A table from an earlier step: a Read table or Edit table step, or a list of rows.')} required>
                        <TableSourceField
                            value={draft.source} onChange={b => set('source', b)} onFocusField={onFocusField} previewSample={previewSample}
                            ariaLabel={t('automation_write_table.source', 'Table to write')}
                        />
                    </StepField>
                    <StepField label={t('automation_write_table.format', 'File type')} help={t('automation_write_table.format_help', 'Excel keeps numbers as numbers and can mark rows. CSV is plain text that every program reads.')}>
                        <Radios
                            ariaLabel={t('automation_write_table.format', 'File type')} value={draft.format === 'csv' ? 'csv' : 'xlsx'}
                            onChange={next => set('format', next)}
                            options={[
                                { value: 'xlsx', label: t('automation_write_table.format_xlsx', 'Excel (.xlsx)') },
                                { value: 'csv', label: t('automation_write_table.format_csv', 'CSV (.csv)') },
                            ]}
                        />
                    </StepField>
                    <StepField label={t('automation_write_table.file_name', 'File name')} help={t('automation_write_table.file_name_help', 'Without the extension. It may hold values of earlier steps, such as a project number from the form. Empty: the name of this step.')}>
                        <input type="text" value={draft.fileName} onChange={e => set('fileName', e.target.value)} aria-label={t('automation_write_table.file_name', 'File name')} className={inputClass()} />
                    </StepField>
                </div>
            </AccordionSection>
            <AccordionSection stepType="write_table" sectionKey="advanced" title={t('automation_write_table.advanced', 'Advanced')} forceOpen={!!errorSections?.has('advanced')} hasContent={draft.columns.length > 0 || !!draft.highlightColumn}>
                <div className="flex flex-col gap-3">
                    <datalist id={listId}>{known.map(n => <option key={n} value={n} />)}</datalist>
                    <StepField label={t('automation_write_table.columns', 'Columns')} help={t('automation_write_table.columns_help', 'Which columns go into the file, in this order, each with the heading it gets. No columns: all of them, as they are.')}>
                        <ColumnList value={draft.columns} onChange={v => set('columns', v)} listId={listId} />
                    </StepField>
                    <StepField label={t('automation_write_table.highlight', 'Mark rows where this column is filled in')} help={t('automation_write_table.highlight_help', 'For example a column with remarks or flags: the rows to check get a colour in the Excel file. Empty: no row is marked.')}>
                        <input type="text" list={listId} value={draft.highlightColumn} onChange={e => set('highlightColumn', e.target.value)} aria-label={t('automation_write_table.highlight', 'Mark rows where this column is filled in')} className={inputClass()} />
                    </StepField>
                    {draft.format === 'xlsx' && (
                        <StepField label={t('automation_write_table.sheet_name', 'Sheet name')} help={t('automation_write_table.sheet_name_help', 'The name of the sheet in the Excel file. Empty: the name of this step.')}>
                            <input type="text" value={draft.sheetName} onChange={e => set('sheetName', e.target.value)} aria-label={t('automation_write_table.sheet_name', 'Sheet name')} className={inputClass()} />
                        </StepField>
                    )}
                    {draft.format === 'csv' && (
                        <StepField label={t('automation_write_table.delimiter', 'Separator between the columns')} help={t('automation_write_table.delimiter_help', 'Excel opens a CSV file with its own list separator: a semicolon in Dutch.')}>
                            <select aria-label={t('automation_write_table.delimiter', 'Separator between the columns')} value={draft.delimiter || ';'} onChange={e => set('delimiter', e.target.value)} className={inputClass()}>
                                {DELIMITERS.map(d => <option key={d} value={d}>{delimiterLabel[d]}</option>)}
                            </select>
                        </StepField>
                    )}
                    <StepField label={t('automation_write_table.keep', 'Keep the file for (days)')} help={t('automation_write_table.keep_help', 'After this many days the file is deleted. From 1 to 90.')}>
                        <NumberInput value={draft.expiresInDays ?? 7} min={1} max={90} onChange={n => set('expiresInDays', n ?? 7)} ariaLabel={t('automation_write_table.keep', 'Keep the file for (days)')} />
                    </StepField>
                </div>
            </AccordionSection>
        </>
    );
}
