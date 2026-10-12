import { Plus, Trash2, X } from 'lucide-react';
import React, { useState } from 'react';
import type { ChangeEvent } from 'react';
// The kind words the variable tree shows for the same data one column
// over — the hand-written-output sheet names a field's kind with them so
// the two cannot drift into two vocabularies for one value.
import { KIND_WORD, kindOfValue } from './mapping/fieldKinds';
import {
    OUT_FIELD_KINDS, coerceToKind, draftRecords, draftValue, isMultilineText, isOutFieldKind,
    nextRowId, rowDraft, rowText, safeJsonText, typedValue,
} from './outputDrafts';
import type { OutputRecord, OutputRow, OutputShape } from './outputDrafts';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TranslateFn } from '../../../hooks/useTranslation';

export interface OutputFieldsEditorProps {
    shape: OutputShape;
    /** The sheet's JSON text — the draft is read out of it and written back to it. */
    text: string;
    onChange: (text: string) => void;
}

/**
 * The fields face: one block per record, one row per field.
 *
 * The draft lives HERE and the JSON text lives in the sheet above, which makes
 * the sync one-directional per interaction: a field edit writes the text, and
 * the text is re-read into a draft only when somebody ELSE wrote it — the raw
 * editor, "Use empty answers", reopening the sheet. Re-reading on the echo of
 * our own write is what `ours` prevents, and it is not a micro-optimisation:
 * `1.` serialises to `1`, and a draft rebuilt from that text would delete the
 * dot on the keystroke after it.
 */
function OutputFieldsEditor({ shape, text, onChange }: OutputFieldsEditorProps) {
    const { t } = useTranslation();
    const [records, setRecords] = useState<OutputRecord[]>(() => draftRecords(text));
    // The text this draft was built from. State, not a ref, and compared
    // DURING the render that brings a new text in — React's "adjusting state
    // when a prop changes". An effect would paint one frame of the old draft
    // over the new text first, and here that frame is a row list disagreeing
    // with the JSON right under it.
    const [seed, setSeed] = useState(text);
    if (text !== seed) {
        setSeed(text);
        setRecords(draftRecords(text));
    }
    const emit = (next: OutputRecord[]) => {
        const json = safeJsonText(draftValue(shape, next));
        setRecords(next);
        // Our own write comes back as a new `text` one render later. Recording
        // it as the seed is what stops that echo from rebuilding the draft the
        // author is typing in.
        setSeed(json);
        onChange(json);
    };
    const blankRecord = (): OutputRecord => ({ id: nextRowId(), rows: (records[0]?.rows || []).map(r => rowDraft(r.key, '')) });
    return (
        <div className="flex flex-col gap-1.5 px-3 py-2">
            {records.map((rec, i) => (
                <OutputRecordBlock
                    key={rec.id}
                    rec={rec}
                    index={shape === 'records' ? i : null}
                    // One value is one value: it has no name to type and no
                    // second field to add, so the row is the whole sheet.
                    canAddFields={shape !== 'value'}
                    t={t}
                    onRows={(rows) => emit(records.map((r, j) => (j === i ? { ...r, rows } : r)))}
                    onRemove={() => emit(records.filter((_, j) => j !== i))}
                />
            ))}
            {shape === 'records' && (
                <button
                    type="button"
                    data-testid="ndv-add-record"
                    onClick={() => emit([...records, blankRecord()])}
                    className="self-start inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    <Plus size={11} /> {t('common.add', 'Add')}
                </button>
            )}
        </div>
    );
}

/**
 * One record. `index` is null for the single-object case — there IS no record
 * there, only fields, and numbering the one thing on screen would invent a
 * list the output does not have.
 */
interface OutputRecordBlockProps {
    rec: OutputRecord;
    /** null for the single-object case: there is no record there, only fields. */
    index: number | null;
    canAddFields: boolean;
    t: TranslateFn;
    onRows: (rows: OutputRow[]) => void;
    onRemove: () => void;
}

function OutputRecordBlock({ rec, index, canAddFields, t, onRows, onRemove }: OutputRecordBlockProps) {
    return (
        <div className={index === null ? 'flex flex-col gap-1' : 'flex flex-col gap-1 rounded border border-[var(--border-default)] p-1.5'}>
            {index !== null && (
                <div className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                    {/* A numeral, not a word: this says WHICH record of the list
                        it is, and "#2" says that in every language the Builder
                        ships in — no key, nothing to leave untranslated. */}
                    <span data-testid="ndv-record-no">#{index + 1}</span>
                    <button
                        type="button"
                        onClick={onRemove}
                        title={t('common.remove', 'Remove')}
                        aria-label={t('common.remove', 'Remove')}
                        className="ml-auto p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] transition"
                    >
                        <Trash2 size={11} />
                    </button>
                </div>
            )}
            {rec.rows.map(row => (
                <OutputFieldRow
                    key={row.id}
                    row={row}
                    t={t}
                    onPatch={(patch) => onRows(rec.rows.map(r => (r.id === row.id ? { ...r, ...patch } : r)))}
                    onRemove={canAddFields ? () => onRows(rec.rows.filter(r => r.id !== row.id)) : null}
                />
            ))}
            {canAddFields && (
            <button
                type="button"
                data-testid="ndv-add-field"
                onClick={() => onRows([...rec.rows, { id: nextRowId(), key: '', kind: 'text', value: '', text: '' }])}
                className="self-start inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
            >
                {/* Borrowed key, on purpose: automations.ndv.extraction.add_field
                    is this same drawer saying this same two words over the data
                    extraction field list. Minting `automations.ndv.out_add_field`
                    would mean appending to both dictionaries plus a Dutch seed
                    migration, and those belong to one stage at a time
                    (I18N-CONVENTIES.md § serieel) — a second writer's rebase
                    drops the first one's keys. Same sentence, same drawer, one
                    entry. */}
                <Plus size={11} /> {t('automations.ndv.extraction.add_field', 'Add field')}
            </button>
            )}
        </div>
    );
}

const OUT_ROW_INPUT = 'min-w-0 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--text-tertiary)]';

interface OutputFieldRowProps {
    row: OutputRow;
    t: TranslateFn;
    onPatch: (patch: Partial<OutputRow>) => void;
    /** null on the single-value face — there is nothing to remove but the value. */
    onRemove?: (() => void) | null;
}

/** Name · value · kind · remove — the ParamsEditor row shape, one drawer over. */
function OutputFieldRow({ row, t, onPatch, onRemove }: OutputFieldRowProps) {
    // A multi-line row is tall; its name box and kind picker belong at the TOP
    // of it, beside the first line, not floating halfway down the paragraph.
    const tall = row.kind === 'text' && row.multiline;
    return (
        <div className={`flex gap-1 ${tall ? 'items-start' : 'items-center'}`} data-testid="ndv-output-field">
            {/* `key === null` is the single-value draft: there is no name to
                type, and an empty name box beside the one value would read as a
                field the author forgot to fill in. */}
            {row.key !== null && (
                <input
                    className={`${OUT_ROW_INPUT} w-[9rem] shrink-0`}
                    value={row.key}
                    spellCheck={false}
                    aria-label={t('common.name', 'Name')}
                    placeholder={t('common.name', 'Name')}
                    onChange={(e) => onPatch({ key: e.target.value })}
                />
            )}
            <OutputFieldValue row={row} t={t} onPatch={onPatch} />
            {row.kind === 'nested' ? (
                <span className="w-[4.5rem] shrink-0 text-[11px] text-[var(--text-tertiary)] truncate" data-testid="ndv-field-kind">
                    {t(KIND_WORD[kindOfValue(row.value)].key, KIND_WORD[kindOfValue(row.value)].en)}
                </span>
            ) : (
                <select
                    className={`${OUT_ROW_INPUT} w-[4.5rem] shrink-0`}
                    value={row.kind}
                    aria-label={t('common.type', 'Type')}
                    data-testid="ndv-field-kind"
                    onChange={(e) => {
                        const kind = e.target.value;
                        // The options ARE OUT_FIELD_KINDS; the guard is what
                        // lets the patch stay typed without asserting it.
                        if (!isOutFieldKind(kind)) return;
                        const value = coerceToKind(kind, row.value);
                        onPatch({ kind, value, text: rowText(value) });
                    }}
                >
                    {OUT_FIELD_KINDS.map(k => (
                        <option key={k} value={k}>{t(KIND_WORD[k].key, KIND_WORD[k].en)}</option>
                    ))}
                </select>
            )}
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    title={t('common.remove', 'Remove')}
                    aria-label={t('common.remove', 'Remove')}
                    className="shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] transition"
                >
                    <X size={11} />
                </button>
            )}
        </div>
    );
}

/** The value control for one row — one per editor kind, and none for nested. */
function OutputFieldValue({ row, t, onPatch }: Omit<OutputFieldRowProps, 'onRemove'>) {
    // Named after the FIELD, so a screen reader in a twelve-row sheet says
    // "subject value" instead of "Value" twelve times.
    const label = row.key
        ? t('automations.builder.value_of', '{field} value', { field: row.key })
        : t('automations.builder.value_word', 'Value');
    if (row.kind === 'nested') {
        // Shown, not offered: the author sees the value that is really in
        // there, and edits it in the raw editor below. Flattening a group into
        // this box would be a data loss one Save away.
        return (
            <span
                className="flex-1 min-w-0 truncate px-1.5 text-[11px] font-mono text-[var(--text-tertiary)]"
                data-testid="ndv-field-nested"
                title={safeJsonText(row.value)}
            >
                {safeJsonText(row.value).replace(/\s+/g, ' ')}
            </span>
        );
    }
    if (row.kind === 'yesno') {
        return (
            <select
                className={`${OUT_ROW_INPUT} flex-1`}
                aria-label={label}
                value={row.value === true ? 'true' : 'false'}
                onChange={(e) => onPatch({ value: e.target.value === 'true', text: e.target.value })}
            >
                <option value="true">{t('common.yes', 'Yes')}</option>
                <option value="false">{t('common.no', 'No')}</option>
            </select>
        );
    }
    // Same aria-label, same value, same one patch either way — the only
    // difference is the element, because one of the two keeps line breaks and
    // the other is specified to throw them away (see isMultilineText).
    const onText = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onPatch({
        text: e.target.value,
        value: typedValue(row.kind, e.target.value),
        multiline: row.multiline || isMultilineText(e.target.value),
    });
    if (row.kind === 'text' && row.multiline) {
        return (
            <textarea
                className={`${OUT_ROW_INPUT} flex-1 resize-y leading-relaxed`}
                aria-label={label}
                placeholder={t('automations.builder.type_a_value', 'Type a value…')}
                value={row.text}
                spellCheck={false}
                rows={Math.min(8, row.text.split('\n').length + 1)}
                onChange={onText}
            />
        );
    }
    return (
        <input
            className={`${OUT_ROW_INPUT} flex-1`}
            aria-label={label}
            placeholder={t('automations.builder.type_a_value', 'Type a value…')}
            value={row.text}
            spellCheck={false}
            onChange={onText}
        />
    );
}

export default OutputFieldsEditor;
