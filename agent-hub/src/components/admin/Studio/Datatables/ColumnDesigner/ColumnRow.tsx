import { GripVertical, Lock, Plus, Trash2, Workflow, X } from 'lucide-react';
import React, { useState } from 'react';
import { ColumnKindIcon, kindWord } from '../ColumnKind';
import { columnLabel, keyFromName } from '../datatableDisplay';
import { TypeSelect } from '../NewDatatableDialog';
import Tooltip from '@/components/shared/Tooltip';
import { cellText } from '../../AppStudio/tables/rowValues';
import type { UsageSummaryProps, ColumnRowProps } from '../ColumnDesigner.types';
import { logger } from '@/utils/logger';
import { managedHint } from './ColumnDesigner.helpers';

// Ronde 2's 24|1fr|190|260|32: the grip alone, the name with its pill, the
// kind, a wider example (chips need it), the remove.
export const GRID = { display: 'grid', gridTemplateColumns: '24px minmax(0,1fr) 190px 260px 32px', gap: 12 };

const SUMMARY_MAX = 5;

function UsageSummary({ t, readers }: UsageSummaryProps) {
    const roleWord = (mode: string | undefined) => mode === 'readwrite' ? t('usage.role_readwrite', 'reads and writes')
        : mode === 'write' ? t('usage.role_write', 'writes') : t('usage.role_read', 'reads');
    return (
        <span className="flex flex-col gap-0.5 text-left">
            {readers.slice(0, SUMMARY_MAX).map((u, i) => (
                <span key={`${u.consumerId || u.automationId || ''}:${u.stepOrdinal || i}`}>
                    {u.consumerTitle || u.automationTitle || t('datatables.column_usage_unnamed', 'An automation')}
                    {u.stepOrdinal ? ` · ${t('datatables.column_usage_step', 'step {n}', { n: u.stepOrdinal })}` : ''}
                    {` · ${roleWord(u.mode)}`}
                </span>
            ))}
            {readers.length > SUMMARY_MAX && (
                <span>{t('datatables.column_usage_more', '+ {n} more', { n: readers.length - SUMMARY_MAX })}</span>
            )}
            <span className="font-normal opacity-75">{t('datatables.column_usage_open', 'Click to open Used by')}</span>
        </span>
    );
}

export function ColumnRow({
    t, field, canEdit, managedKind, locked, first, last, sample, readers,
    onChange, onMove, onRemove, ncColumn = null, onRemoveRetired = null, drag = null, onOpenUsage = null,
}: ColumnRowProps) {
    const needsOptions = field.type === 'select' || field.type === 'multiselect';
    const label = columnLabel(field) || t('datatables.column_generic', 'column');
    // A locked column is still visible, still sortable and still shows who
    // reads it — only its identity is fixed.
    const editable = canEdit && !locked;
    // Only a column that is NOT the person's own carries a hint: where it
    // comes from, or that it is fixed. An own column's row is its name.
    const hint = ncColumn ? ncColumn : locked ? managedHint(t, managedKind, field.key) : null;
    // `cellText` answers an em dash for an absent value; "still empty" is the
    // same fact in words, and the dash would read as a value of its own here.
    const shown = sample ? cellText(sample[field.key], field) : null;
    const example = shown && shown !== '—' ? shown : null;
    const [optionsOpen, setOptionsOpen] = useState(false);
    const options = Array.isArray(field.options) ? field.options : [];
    const writers = readers.filter(u => u.mode === 'write' || u.mode === 'readwrite');
    const marked = writers.length ? writers : readers;

    const onHandleKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === 'ArrowUp' && !first) { e.preventDefault(); onMove(-1); }
        else if (e.key === 'ArrowDown' && !last) { e.preventDefault(); onMove(1); }
    };

    return (
        <li style={{ borderBottom: last ? 'none' : '1px solid var(--border-default)' }}
            onDragOver={drag ? drag.over : undefined} onDrop={drag ? drag.drop : undefined}>
            <div className="grid items-center" style={{ ...GRID, padding: '9px 14px' }}>
                {drag ? (
                    <button
                        type="button"
                        draggable
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', label); } catch (err) { logger.debug('jsdom', err); } drag.start(); }}
                        onDragEnd={drag.end}
                        onKeyDown={onHandleKey}
                        className="grid place-items-center w-6 h-6 rounded cursor-grab active:cursor-grabbing focus-visible:outline focus-visible:outline-2 [color:var(--text-tertiary)] [outline-color:var(--accent-primary)]!"
                        aria-label={t('datatables.column_reorder', 'Reorder {name} — drag, or use the arrow keys', { name: label })}
                        title={t('datatables.column_reorder_hint', 'Drag to reorder · ↑ ↓')}
                        data-testid="column-grip"
                    >
                        <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                ) : (
                    <GripVertical className="w-3.5 h-3.5 justify-self-center [color:var(--text-tertiary)] [opacity:0.25]" aria-hidden="true" />
                )}

                <span className="min-w-0 flex items-center gap-2">
                    <input
                        value={field.name || ''}
                        disabled={!editable}
                        aria-label={t('datatables.column_name', 'Column name')}
                        onChange={(e) => {
                            // Derive the key from the name only while it is still
                            // empty: once a column exists its key is what the rows
                            // are stored under, and rewriting it from a rename
                            // would silently drop the column and add a new one.
                            const name = e.target.value;
                            onChange(field.key ? { name } : { name, key: keyFromName(name) });
                        }}
                        placeholder={t('datatables.column_name', 'Column name')}
                        className="min-w-0 flex-1 bg-transparent text-sm font-medium rounded px-1 -mx-1 border border-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-100 [color:var(--text-primary)]! [outline-color:var(--accent-primary)]!"
                    />
                    {marked.length > 0 && (
                        <Tooltip content={<UsageSummary t={t} readers={readers} />}>
                            <button type="button" onClick={onOpenUsage || undefined}
                                className="inline-flex items-center gap-1 text-[11px] shrink-0 whitespace-nowrap px-[7px] py-px rounded-full cursor-pointer bg-[var(--bg-secondary)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 outline-[var(--accent-primary)]"
                                aria-label={writers.length ? t('datatables.column_written_by', 'An automation writes to this column') : t('datatables.column_read_by', 'An automation reads this column')}
                                data-testid="column-usage">
                                <Workflow className="w-[11px] h-[11px]" aria-hidden="true" />
                                {marked.length === 1
                                    ? t('datatables.column_used_one_pill', '1 automation')
                                    : t('datatables.column_used_many_pill', '{n} automations', { n: marked.length })}
                            </button>
                        </Tooltip>
                    )}
                </span>

                {field.type === 'relation' ? (
                    <span className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs border [border-color:var(--border-default)] [color:var(--text-primary)]! [opacity:0.6]">
                        <ColumnKindIcon kind="relation" size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                        <span className="truncate">{kindWord(t, 'relation')}</span>
                    </span>
                ) : (
                    <TypeSelect
                        t={t}
                        value={field.type}
                        disabled={!editable}
                        onChange={(type) => onChange({ type })}
                        ariaLabel={t('datatables.column_type', 'Column type')}
                    />
                )}

                {needsOptions ? (
                    <span className="flex items-center gap-1 min-w-0 overflow-hidden" data-testid="column-options">
                        {options.slice(0, 6).map(o => (
                            <span key={o} className="text-[11px] whitespace-nowrap shrink-0 [padding:2px_7px] [border-radius:999px] [background:var(--bg-secondary)] [border:1px_solid_var(--border-default)] [color:var(--text-primary)]!">
                                {o}
                            </span>
                        ))}
                        {options.length > 6 && <span className="text-[11px] shrink-0 text-[var(--text-tertiary)]">+{options.length - 6}</span>}
                        {editable && (
                            <button type="button" onClick={() => setOptionsOpen(o => !o)} aria-expanded={optionsOpen}
                                className="grid place-items-center shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 w-[22px] h-[22px] [border:1px_dashed_var(--border-default)] [color:var(--text-tertiary)] [outline-color:var(--accent-primary)]!"
                                aria-label={t('datatables.column_options_edit', 'Edit the choices of {name}', { name: label })}
                                data-testid="column-options-edit">
                                {optionsOpen ? <X className="w-[11px] h-[11px]" aria-hidden="true" /> : <Plus className="w-[11px] h-[11px]" aria-hidden="true" />}
                            </button>
                        )}
                        {!options.length && !editable && <span className="text-xs text-[var(--text-tertiary)]">{t('datatables.column_no_example', 'still empty')}</span>}
                    </span>
                ) : (
                    <span className="text-xs truncate tabular-nums" style={{ color: example ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}
                        title={example || undefined}>
                        {example || t('datatables.column_no_example', 'still empty')}
                    </span>
                )}

                <span className="justify-self-end">
                    {onRemoveRetired ? (
                        <button type="button" onClick={onRemoveRetired} className="p-1 rounded focus-visible:outline focus-visible:outline-2 [color:var(--text-tertiary)] [outline-color:var(--accent-primary)]!"
                            aria-label={t('datatables.frm_remove_retired', 'Remove {name}', { name: label })}
                            title={t('datatables.frm_remove_retired', 'Remove {name}', { name: label })} data-testid="remove-retired">
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    ) : (canEdit || ncColumn) && (locked ? (
                        <span className="p-1 inline-flex" title={t('datatables.column_locked', 'Filled in automatically — this column cannot be removed, renamed or retyped.')}>
                            <Lock className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                            <span className="sr-only">{t('datatables.column_locked', 'Filled in automatically — this column cannot be removed, renamed or retyped.')}</span>
                        </span>
                    ) : (
                        <button type="button" onClick={onRemove} className="p-1 rounded focus-visible:outline focus-visible:outline-2 [color:var(--text-tertiary)] [outline-color:var(--accent-primary)]!"
                            aria-label={t('datatables.column_remove_named', 'Remove {name}', { name: label })}>
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    ))}
                </span>
            </div>

            {hint && (
                <div className="text-[11px] truncate [color:var(--text-tertiary)]! [padding:0_14px_8px_50px] [margin-top:-4px]">
                    {hint}
                </div>
            )}

            {needsOptions && (optionsOpen || (editable && options.length === 0)) && (
                <div className="pb-2.5 -mt-1 [padding:0_14px_10px_50px]!">
                    <input
                        value={(field.options || []).join(', ')}
                        disabled={!editable}
                        aria-label={t('datatables.column_options', 'Options for {name}', { name: label })}
                        onChange={(e) => onChange({ options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                        placeholder={t('datatables.column_options_ph', 'Option one, Option two, Option three')}
                        className="w-full px-2 py-1 rounded text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline-color:var(--accent-primary)]!"
                    />
                </div>
            )}
        </li>
    );
}
