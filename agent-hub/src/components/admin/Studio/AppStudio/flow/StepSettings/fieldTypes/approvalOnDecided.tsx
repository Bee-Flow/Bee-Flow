import { X } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import Toggle from '@/components/shared/Toggle';
import useAppTables, { fieldsForTable } from '@/components/admin/Studio/AppStudio/bi/useAppTables';
import { useEditorChrome } from '@/components/admin/Studio/AppStudio/editor/EditorChromeContext';
import BindingField from '@/components/admin/Studio/AppStudio/inspector/panels/BindingField';
import { INPUT_CLS } from '@/components/admin/Studio/AppStudio/inspector/panels/kit';
import { canonicalOnDecided, DECISION_OUTCOMES, MAX_HOOK_COLUMNS, type HookValue, type OnDecided } from '../stepFieldShapes';
import type { TableColumn } from '@/components/admin/Studio/AppStudio/inspector/aiFieldMatching';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

type Outcome = (typeof DECISION_OUTCOMES)[number];

const outcomeLabel = (o: Outcome, t: TranslateFn) => ({
    approved: t('studio_apps_step_fields.on_decided.approved', 'When approved'),
    rejected: t('studio_apps_step_fields.on_decided.rejected', 'When rejected'),
    expired: t('studio_apps_step_fields.on_decided.expired', 'When nobody decided in time'),
    cancelled: t('studio_apps_step_fields.on_decided.cancelled', 'When the request is withdrawn'),
})[o];

/**
 * A typed value back from its box. Text stays text (a template such as {{reason}} is text), but a
 * value that was a number or yes/no keeps its type while it still reads as one, so editing 5 to 6
 * does not quietly turn a number into a string.
 */
function parseLike(prev: HookValue, text: string): HookValue {
    if (typeof prev === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
    if (typeof prev === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
    return text;
}

/**
 * `approvalOnDecided`: the row the decision writes to, per outcome. Hidden as "AI-authored"
 * before. The row is a binding resolved when the request is made; each outcome maps a column to
 * a literal or a template resolved when the decision lands ({{answers.<question>}}, {{reason}},
 * {{decidedByName}}, {{decidedAt}}, {{context.<key>}}). A column is added by picking it, so no
 * row without a column is ever stored.
 */
function ApprovalOnDecidedControl({ value, onChange, definition, node, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const chrome = useEditorChrome();
    const { tables } = useAppTables(chrome?.appId ?? null);
    const hook = canonicalOnDecided(value);
    const commit = (next: OnDecided) => onChange(canonicalOnDecided(next));
    const columns = fieldsForTable(tables, hook?.tableId);
    const setOutcome = (o: Outcome, cols: Record<string, HookValue>) => commit({ ...hook, set: { ...hook?.set, [o]: cols } });
    return (
        <FormField
            label={t('studio_apps_step_fields.on_decided.label', 'When the decision lands')}
            hint={t('studio_apps_step_fields.on_decided.hint', 'Update one row with the outcome. Values may use {{answers.name}}, {{reason}}, {{decidedByName}}, {{decidedAt}} and {{context.key}}.')}
        >
            <div className="flex flex-col gap-2" data-step-control="approvalOnDecided">
                <Toggle
                    size="sm"
                    label={t('studio_apps_step_fields.on_decided.toggle', 'Update a row when someone decides')}
                    checked={!!hook}
                    onChange={(v) => onChange(v ? canonicalOnDecided({ tableId: tables[0]?.id }) : undefined)}
                    disabled={disabled || (!hook && !tables.length)}
                />
                {hook ? (
                    <>
                        <select
                            className={INPUT_CLS}
                            value={hook.tableId || ''}
                            onChange={(e) => commit({ ...hook, tableId: e.target.value })}
                            disabled={disabled}
                            aria-label={t('studio_apps_step_fields.on_decided.table', 'Table')}
                        >
                            <option value="">{t('studio_apps_step_fields.on_decided.pick_table', 'Pick a table…')}</option>
                            {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name || tb.key}</option>)}
                        </select>
                        <BindingField
                            label={t('studio_apps_step_fields.on_decided.record', 'Row')}
                            hint={t('studio_apps_step_fields.on_decided.record_hint', 'Which row changes, worked out when the request is made, for example the invoice the approval is about.')}
                            value={hook.recordId}
                            onChange={(b) => commit({ ...hook, recordId: b })}
                            definition={definition}
                            node={node}
                            disabled={disabled}
                        />
                        {DECISION_OUTCOMES.map((o) => (
                            <OutcomeColumns key={o} outcome={o} cols={hook.set?.[o] || {}} columns={columns} onChange={(cols) => setOutcome(o, cols)} disabled={disabled} t={t} />
                        ))}
                    </>
                ) : null}
            </div>
        </FormField>
    );
}

interface OutcomeColumnsProps {
    outcome: Outcome;
    cols: Record<string, HookValue>;
    columns: TableColumn[];
    onChange: (cols: Record<string, HookValue>) => void;
    disabled: boolean;
    t: TranslateFn;
}

function OutcomeColumns({ outcome, cols, columns, onChange, disabled, t }: OutcomeColumnsProps) {
    const keys = Object.keys(cols);
    const free = columns.filter((col) => col.type !== 'computed' && !keys.includes(col.key));
    const nameOf = (key: string) => columns.find((col) => col.key === key)?.name || key;
    const without = (key: string) => Object.fromEntries(Object.entries(cols).filter(([k]) => k !== key));
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2" data-outcome={outcome}>
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">{outcomeLabel(outcome, t)}</span>
            {keys.map((key) => (
                <div key={key} className="flex items-center gap-1.5">
                    <span className="w-28 shrink-0 truncate text-[11px] text-[var(--text-secondary)]" title={key}>{nameOf(key)}</span>
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={cols[key] === null ? '' : String(cols[key])}
                        onChange={(e) => onChange({ ...cols, [key]: parseLike(cols[key], e.target.value) })}
                        placeholder={cols[key] === null ? t('studio_apps_step_fields.on_decided.empty_value', '(cleared)') : '{{reason}}'}
                        disabled={disabled}
                        spellCheck={false}
                        aria-label={t('studio_apps_step_fields.on_decided.value_aria', '{column} {outcome}', { column: nameOf(key), outcome: outcomeLabel(outcome, t) })}
                    />
                    <button type="button" onClick={() => onChange(without(key))} disabled={disabled} aria-label={t('studio_apps_step_fields.on_decided.remove', 'Stop setting {column}', { column: nameOf(key) })} className="shrink-0 p-1 text-[var(--text-tertiary)] hover:text-[var(--error)]">
                        <X size={12} />
                    </button>
                </div>
            ))}
            {keys.length < MAX_HOOK_COLUMNS && free.length ? (
                <select
                    className={INPUT_CLS}
                    value=""
                    onChange={(e) => { if (e.target.value) onChange({ ...cols, [e.target.value]: '' }); }}
                    disabled={disabled}
                    aria-label={t('studio_apps_step_fields.on_decided.add_aria', 'Set a column {outcome}', { outcome: outcomeLabel(outcome, t) })}
                >
                    <option value="">{t('studio_apps_step_fields.on_decided.add', '+ Set a column…')}</option>
                    {free.map((col) => <option key={col.key} value={col.key}>{col.name || col.key}</option>)}
                </select>
            ) : null}
        </div>
    );
}

const entry: StepFieldTypeModule = { type: 'approvalOnDecided', Control: ApprovalOnDecidedControl };
export default entry;
