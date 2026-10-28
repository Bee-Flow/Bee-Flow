import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { walkPath } from '@/utils/bindingHelpers';
import { useVariablePickerContext } from '@/components/automation/Builder/mapping/VariablePickerContext';
import AccordionSection from '../../AccordionSection';
import { hintTextClass, inputClass, rowInputClass } from '../formPrimitives';
import StepField from './StepField';
import { fileOptions } from './fileSources';
import { IterationRow, RetryRow } from './IterationSection';
import { Check, NumberInput, Radios } from './ops/inputs';
import TableSourceField from './TableSourceField';
import type { Binding } from './tableOpModel';

interface Draft {
    source: Binding | null;
    sheets: 'all' | 'first' | string[];
    headerRow: number;
    provenanceSheet: string;
    format: string;
    delimiter: string;
    skipHiddenSheets: boolean;
    expiresInDays: number;
    forEach?: unknown;
}

interface Props {
    draft: Draft;
    set: (key: string, value: unknown) => void;
    /** This step's id, to find the sheets its last run saw. */
    stepId?: string;
    groups?: unknown[];
    onFocusField?: unknown;
    previewSample?: unknown;
    errorSections?: Set<string>;
}

type SheetChoice = 'all' | 'first' | 'some';
const choiceOf = (sheets: Draft['sheets']): SheetChoice => (Array.isArray(sheets) ? 'some' : sheets === 'first' ? 'first' : 'all');

function SheetTags({ value, onChange, known }: { value: string[]; onChange: (v: string[]) => void; known: string[] }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const add = (name: string) => { const n = name.trim(); if (n && !value.includes(n)) onChange([...value, n]); setText(''); };
    const suggestions = known.filter(n => !value.includes(n));
    return (
        <div className="flex flex-col gap-1.5">
            {value.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label={t('automation_tables.read.sheet_list', 'Sheets to read')}>
                    {value.map(name => (
                        <li key={name} className="inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] py-0.5 pl-2 pr-1 text-xs text-[var(--text-primary)]">
                            {name}
                            <button type="button" onClick={() => onChange(value.filter(n => n !== name))} aria-label={t('automation_tables.read.remove_sheet', 'Remove {name}', { name })} className="rounded-full p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X size={11} /></button>
                        </li>
                    ))}
                </ul>
            )}
            <input
                type="text" value={text} onChange={e => setText(e.target.value)} onBlur={() => add(text)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(text); } }}
                aria-label={t('automation_tables.read.add_sheet', 'Add a sheet name')}
                placeholder={t('automation_tables.read.add_sheet_placeholder', 'Sheet name, then Enter')}
                className={rowInputClass('w-full')}
            />
            {suggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                    {t('automation_tables.read.seen', 'Seen in the last run:')}
                    {suggestions.map(n => <button key={n} type="button" onClick={() => add(n)} className="text-[var(--accent)] hover:underline">{n}</button>)}
                </div>
            )}
        </div>
    );
}

const FORMATS = ['auto', 'xlsx', 'xlsm', 'xls', 'ods', 'csv'] as const;
const DELIMITERS = ['auto', ',', ';', '\t', '|'] as const;

function AdvancedFields({ draft, set, groups, onFocusField, errorSections }: Pick<Props, 'draft' | 'set' | 'groups' | 'onFocusField' | 'errorSections'>) {
    const { t } = useTranslation();
    const provenance = draft.provenanceSheet === 'auto' || draft.provenanceSheet === 'none' ? draft.provenanceSheet : 'name';
    const delimiterLabel: Record<string, string> = {
        auto: t('automation_tables.read.delimiter_auto', 'Find out by itself'),
        ',': t('automation_tables.read.delimiter_comma', 'Comma'),
        ';': t('automation_tables.read.delimiter_semicolon', 'Semicolon'),
        '\t': t('automation_tables.read.delimiter_tab', 'Tab'),
        '|': t('automation_tables.read.delimiter_bar', 'Bar (|)'),
    };
    return (
        <AccordionSection stepType="read_table" sectionKey="advanced" title={t('automation_tables.read.advanced', 'Advanced')} forceOpen={!!errorSections?.has('advanced')} hasContent={!!draft.forEach}>
            <div className="flex flex-col gap-3">
                <StepField label={t('automation_tables.read.format', 'File type')} help={t('automation_tables.read.format_help', 'Leave on automatic to look at the file itself. Choose a type only if the file is not recognised.')}>
                    <select aria-label={t('automation_tables.read.format', 'File type')} value={draft.format || 'auto'} onChange={e => set('format', e.target.value)} className={inputClass()}>
                        {FORMATS.map(f => <option key={f} value={f}>{f === 'auto' ? t('automation_tables.read.format_auto', 'Find out by itself') : f.toUpperCase()}</option>)}
                    </select>
                </StepField>
                {(draft.format === 'auto' || draft.format === 'csv' || !draft.format) && (
                    <StepField label={t('automation_tables.read.delimiter', 'Separator in a CSV file')} help={t('automation_tables.read.delimiter_help', 'The character between the columns of a CSV file. Only used for CSV files.')}>
                        <select aria-label={t('automation_tables.read.delimiter', 'Separator in a CSV file')} value={draft.delimiter || 'auto'} onChange={e => set('delimiter', e.target.value)} className={inputClass()}>
                            {DELIMITERS.map(d => <option key={d} value={d}>{delimiterLabel[d]}</option>)}
                        </select>
                    </StepField>
                )}
                <div className="flex flex-col gap-1">
                    <Check checked={draft.skipHiddenSheets !== false} onChange={v => set('skipHiddenSheets', v)} label={t('automation_tables.read.skip_hidden', 'Skip hidden sheets')} />
                    <p className={hintTextClass()}>{t('automation_tables.read.skip_hidden_help', 'A sheet someone has hidden is usually not meant to be used. A sheet you choose by name is read even if it is hidden.')}</p>
                </div>
                <StepField label={t('automation_tables.read.provenance', 'Sheet with details about the file')} help={t('automation_tables.read.provenance_help', 'Some files have a sheet that says where the data comes from, such as About or Info. It is read as a list of facts, not as a table.')}>
                    <Radios
                        ariaLabel={t('automation_tables.read.provenance', 'Sheet with details about the file')} value={provenance}
                        onChange={next => set('provenanceSheet', next === 'name' ? (provenance === 'name' ? draft.provenanceSheet : 'Info') : next)}
                        options={[
                            { value: 'auto', label: t('automation_tables.read.provenance_auto', 'Find it automatically') },
                            { value: 'none', label: t('automation_tables.read.provenance_none', 'There is none') },
                            { value: 'name', label: t('automation_tables.read.provenance_name', 'The sheet with this name') },
                        ]}
                    />
                    {provenance === 'name' && (
                        <input type="text" value={draft.provenanceSheet} aria-label={t('automation_tables.read.provenance_sheet', 'Name of that sheet')} className={inputClass()} onChange={e => set('provenanceSheet', e.target.value)} />
                    )}
                </StepField>
                <StepField label={t('automation_tables.read.keep', 'Keep the tables for (days)')} help={t('automation_tables.read.keep_help', 'After this many days the stored tables are deleted. From 1 to 90.')}>
                    <NumberInput value={draft.expiresInDays ?? 7} min={1} max={90} onChange={n => set('expiresInDays', n ?? 7)} ariaLabel={t('automation_tables.read.keep', 'Keep the tables for (days)')} />
                </StepField>
                <IterationRow draft={draft as unknown as Record<string, unknown>} set={set} groups={groups} onFocusField={onFocusField} />
            </div>
        </AccordionSection>
    );
}

/**
 * "Read table": open an uploaded spreadsheet or CSV file as tables, one for
 * each sheet. Simple asks which file, which sheets and where the headings are;
 * the rest is under Advanced, each setting with a sentence on what it is for.
 */
export default function ReadTableFields({ draft, set, stepId, groups, onFocusField, previewSample: sampleProp, errorSections }: Props) {
    const { t } = useTranslation();
    const picker = useVariablePickerContext();
    const previewSample = sampleProp ?? picker.previewSample;
    const choice = choiceOf(draft.sheets);
    const seen = (() => {
        const sheets = stepId ? walkPath(`steps.${stepId}.output.sheets`, previewSample) : undefined;
        return Array.isArray(sheets) ? sheets.map(s => (s && typeof s === 'object' ? String((s as { name?: unknown }).name ?? '') : '')).filter(Boolean) : [];
    })();
    return (
        <>
            <AccordionSection stepType="read_table" sectionKey="config" title={t('automations.node.read_table.typeLabel', 'Read table')} defaultOpen forceOpen={!!errorSections?.has('config')}>
                <div className="flex flex-col gap-3">
                    <StepField label={t('automation_tables.read.source', 'File')} help={t('automation_tables.read.source_help', 'A spreadsheet or CSV file: a file someone uploads in a form, or a file an earlier step made.')} required>
                        <TableSourceField
                            value={draft.source} onChange={b => set('source', b)} onFocusField={onFocusField} previewSample={previewSample}
                            options={fileOptions((groups ?? picker.groups) as never)}
                            emptyText={t('automation_tables.read.source_none', 'No file is available yet. Add a form with a file question, or a step that makes a file, before this one.')}
                            placeholder={t('automation_tables.read.source_placeholder', 'trigger.output.<file question>')}
                            ariaLabel={t('automation_tables.read.source', 'File')}
                        />
                    </StepField>
                    <StepField label={t('automation_tables.read.sheets', 'Sheets')} help={t('automation_tables.read.sheets_help', 'A workbook can hold several sheets. Each sheet you read becomes its own table. A CSV file has just one.')}>
                        <Radios
                            ariaLabel={t('automation_tables.read.sheets', 'Sheets')} value={choice}
                            onChange={next => set('sheets', next === 'some' ? [] : next)}
                            options={[
                                { value: 'all', label: t('automation_tables.read.sheets_all', 'All sheets') },
                                { value: 'first', label: t('automation_tables.read.sheets_first', 'The first sheet') },
                                { value: 'some', label: t('automation_tables.read.sheets_some', 'Choose sheets') },
                            ]}
                        />
                        {choice === 'some' && <SheetTags value={Array.isArray(draft.sheets) ? draft.sheets : []} onChange={v => set('sheets', v)} known={seen} />}
                    </StepField>
                    <StepField label={t('automation_tables.read.header_row', 'Row with the column names')} help={t('automation_tables.read.header_row_help', 'Usually the first row. If the sheet starts with a title or a few blank lines, give the number of the row that holds the column names.')}>
                        <NumberInput value={draft.headerRow ?? 1} min={1} max={50} onChange={n => set('headerRow', n ?? 1)} ariaLabel={t('automation_tables.read.header_row', 'Row with the column names')} />
                    </StepField>
                </div>
            </AccordionSection>
            <AdvancedFields draft={draft} set={set} groups={groups} onFocusField={onFocusField} errorSections={errorSections} />
        </>
    );
}
