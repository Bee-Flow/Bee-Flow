import {
    ChevronDown, ChevronRight, Table2,
    Zap, Sparkles, Blocks, GitFork, Repeat, FileText, ClipboardList, ShieldCheck, Flag, Workflow,
    type LucideIcon,
} from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { pathInUse } from './boundPaths';
import { planIncomingFields, technicalPreview } from './incomingFields';
import { FieldRow as FieldRowJs, startPathDrag } from './VariableTree';
import { useTranslation } from '../../../../hooks/useTranslation';
import { walkPath } from '../../../../utils/bindingHelpers';
import { summariseData } from '../flow/dataSummary';
import { familyVarClass } from '../ndv/familyVar';

/**
 * One source step in the Comes-in column (round 4, artboard 4a/4c): a
 * bordered block with the step's family icon, "Step 1 · New file in
 * /Invoices" and its field count. Inside, at most six fields with a human
 * name, the ones this step already uses on top with a "used" pill, then
 * "n more", and the system fields folded under "Technical details".
 */
const FAMILY_ICON: Record<string, LucideIcon> = {
    trigger: Zap, ai: Sparkles, app: Blocks, branch: GitFork, loop: Repeat,
    data: FileText, pause: ClipboardList, guard: ShieldCheck, end: Flag,
};

// Untyped JS row; its props are checked there.
const FieldRow = FieldRowJs as unknown as ComponentType<Record<string, unknown>>;

interface Field { key: string; path: string; sample?: unknown; children?: Field[] }
export interface InputGroup { id: string; label: string; kind?: string; basePath: string; sample?: unknown; fields?: Field[] }

export default function InputNodeSection({
    group, family, number, used, usedPaths, previewSample, onPick, defaultOpen, onOpenTable,
    iteration = null, searching = false,
}: {
    group: InputGroup;
    family: string | null;
    number: number | null;
    used: number;
    usedPaths: Set<string> | null;
    previewSample: unknown;
    onPick: (path: string, opts?: { raw?: boolean }) => void;
    defaultOpen: boolean;
    onOpenTable: () => void;
    iteration?: { index: number; total: number; truncated?: boolean; skipped?: number } | null;
    searching?: boolean;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(defaultOpen);
    // `defaultOpen` flips when a search starts or ends; a key would remount
    // and lose per-field expansion, so track it explicitly instead.
    const [lastDefault, setLastDefault] = useState(defaultOpen);
    if (lastDefault !== defaultOpen) { setLastDefault(defaultOpen); setOpen(defaultOpen); }
    const [showAll, setShowAll] = useState(false);
    const [techOpen, setTechOpen] = useState(false);

    const value = walkPath(group.basePath, previewSample);
    const data = value === undefined ? group.sample : value;
    // "201 records" beats the word "output": it says what is in there.
    const summary = (summariseData as (v: unknown) => { label?: string } | null)(data);
    const fields = group.fields || [];
    const isItem = String(group.basePath || '').startsWith('loop.');
    const Icon = (family && FAMILY_ICON[family]) || Workflow;
    const isUsed = (p: string) => (usedPaths ? (pathInUse as (p: string, s: Set<string>) => boolean)(p, usedPaths) : false);
    // A search already narrowed the list: show every match, fold nothing.
    const plan = planIncomingFields(fields, isUsed, showAll || searching);
    const meta = [
        fields.length === 1 ? t('automations.mapping.one_field', '1 field') : t('automations.mapping.n_fields', '{n} fields', { n: fields.length }),
        ...(used > 0 ? [t('automations.mapping.in_use', '{n} in use', { n: used })] : []),
    ].join(' · ');
    const capped = !!(iteration?.truncated && (iteration.skipped || 0) > 0);
    const row = (f: Field) => (
        <FieldRow key={f.path} field={f} onInsert={onPick} depth={0} previewSample={previewSample} inUse={usedPaths} human />
    );

    return (
        <div
            // shrink-0: a flex child with overflow-hidden may shrink to 0.
            className={`${familyVarClass(family)} rounded-[10px] overflow-hidden group/sec shrink-0 border bg-[var(--bg-card)] ${isItem ? 'border-[var(--type-loop)]' : 'border-[var(--border-default)]'}`}
            data-testid="input-group"
            data-family={family || undefined}
        >
            <div className={`flex items-center border-b border-[var(--border-default)] ${isItem ? 'bg-[color-mix(in_srgb,var(--type-loop)_8%,transparent)]' : ''}`}>
                <div
                    draggable
                    onDragStart={(e) => startPathDrag(e, group.basePath)}
                    onClick={() => setOpen(o => !o)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
                    title={[summary?.label, t('automations.mapping.drag_whole_output', 'Drag to use the whole output ({path})', { path: group.basePath })].filter(Boolean).join(' · ')}
                    className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-[9px] text-xs cursor-grab active:cursor-grabbing select-none"
                >
                    {open ? <ChevronDown size={14} className="shrink-0 text-[var(--text-tertiary)]" /> : <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />}
                    <Icon size={14} className="shrink-0 text-[var(--fam)]" />
                    {number != null && <span className="text-[var(--text-primary)] font-semibold whitespace-nowrap">{t('automations.mapping.step_n', 'Step {n}', { n: number })} ·</span>}
                    <span className="text-[var(--text-primary)] font-semibold truncate">{group.label}</span>
                    {isItem && <span className="text-[var(--text-tertiary)] truncate">{t('automations.mapping.current_item', 'current item of the loop')}</span>}
                    <span className="ml-auto text-[11px] text-[var(--text-tertiary)] whitespace-nowrap" data-testid="input-group-meta">{meta}</span>
                    {/* "1 of 4" (artboard 2b): the last run's loop row. When the
                        run hit its ceiling, the dropped tail is said in the same
                        sentence, in the warning colour. */}
                    {iteration && iteration.total > 0 && (
                        <span
                            className={`shrink-0 px-[7px] rounded-full text-[11px] font-semibold leading-[18px] ${capped
                                ? 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-[var(--warning-ink)]'
                                : 'bg-[color-mix(in_srgb,var(--type-loop)_16%,transparent)] text-[var(--type-loop)]'}`}
                            data-testid="input-loop-iteration"
                        >
                            {capped
                                ? t('automations.mapping.iteration_of_capped', '{n} of {total} · {skipped} not processed', { n: iteration.index, total: iteration.total, skipped: iteration.skipped })
                                : t('automations.mapping.iteration_of', '{n} of {total}', { n: iteration.index, total: iteration.total })}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onOpenTable}
                    title={t('automations.mapping.open_table_title', 'Open {label} as a table — map a whole column or a single cell', { label: group.label })}
                    aria-label={t('automations.mapping.open_table', 'Open {label} as a table', { label: group.label })}
                    className="shrink-0 mr-1 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] opacity-0 group-hover/sec:opacity-100 focus:opacity-100 transition"
                >
                    <Table2 size={12} />
                </button>
            </div>
            {open && (
                <div className="py-1">
                    {plan.shown.map(row)}
                    {plan.more > 0 && (
                        <button
                            type="button"
                            onClick={() => setShowAll(true)}
                            className="w-full text-left pl-8 pr-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            data-testid="input-more-fields"
                        >
                            {t('automations.mapping.n_more', '{n} more', { n: plan.more })}
                        </button>
                    )}
                    {plan.technical.length > 0 && (
                        <div className="border-t border-[var(--border-default)] mt-1">
                            <button
                                type="button"
                                onClick={() => setTechOpen(o => !o)}
                                aria-expanded={techOpen || searching}
                                className="w-full flex items-center gap-2 pl-8 pr-2.5 py-2 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                                data-testid="input-technical"
                            >
                                {techOpen || searching ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                {t('automations.mapping.technical_details', 'Technical details')}
                                <span className="ml-auto truncate">
                                    {t('automations.mapping.technical_meta', '{n} fields · {names}', { n: plan.technical.length, names: technicalPreview(plan.technical) })}
                                </span>
                            </button>
                            {(techOpen || searching) && plan.technical.map(row)}
                        </div>
                    )}
                    {fields.length === 0 && (
                        <div className="px-4 py-1 text-[11px] text-[var(--text-tertiary)] italic">
                            {/* One key for the whole sentence, so any language can reorder it. */}
                            {t('automations.mapping.no_named_fields', 'No named fields — open {table} to map from the raw output.', { table: t('automations.mapping.table', 'Table') })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
