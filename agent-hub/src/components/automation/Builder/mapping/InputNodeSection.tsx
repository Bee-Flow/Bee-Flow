import {
    ChevronDown, ChevronRight, Table2,
    Zap, Sparkles, Blocks, GitFork, Repeat, FileText, ClipboardList, ShieldCheck, Flag, Workflow,
    type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { startPathDrag } from './bindingDnd';
import { pathInUse } from './boundPaths';
import { planIncomingFields, technicalPreview } from './incomingFields';
import { useTranslation } from '../../../../hooks/useTranslation';
import { walkPath } from '../../../../utils/bindingHelpers';
import { summariseData } from '../flow/dataSummary';
import { familyVarClass } from '../ndv/familyVar';
import type { PickOpts } from '../output/mapAttrs';
import SourceNode from '../sources/SourceNode';
import type { TreeGroup, TreeNode } from '../sources/useSourceTree';

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

export type InputGroup = TreeGroup;

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
    onPick: (path: string, opts?: PickOpts) => void;
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

    // The current item of a step that runs once per item: its fields are
    // picks of ONE item (`take: 'each'`), and its path names the whole list.
    const each = group.currentItem?.take === 'each' ? group.currentItem : null;
    const value = each ? undefined : walkPath(group.basePath, previewSample);
    const data = value === undefined ? group.sample : value;
    // "201 records" beats the word "output": it says what is in there.
    const summary = (summariseData as (v: unknown) => { label?: string } | null)(data);
    const fields = group.fields || [];
    const isItem = !!group.currentItem || String(group.basePath || '').startsWith('loop.');
    const Icon = (family && FAMILY_ICON[family]) || Workflow;
    const isUsed = (p: string) => (usedPaths ? (pathInUse as (p: string, s: Set<string>) => boolean)(p, usedPaths) : false);
    // A search already narrowed the list: show every match, fold nothing.
    const plan = planIncomingFields(fields, isUsed, showAll || searching);
    const meta = [
        fields.length === 1 ? t('routines.mapping.one_field', '1 field') : t('routines.mapping.n_fields', '{n} fields', { n: fields.length }),
        ...(used > 0 ? [t('routines.mapping.in_use', '{n} in use', { n: used })] : []),
    ].join(' · ');
    const capped = !!(iteration?.truncated && (iteration.skipped || 0) > 0);
    const row = (f: TreeNode) => (
        <SourceNode key={f.path || f.key} node={f} onInsert={onPick} depth={0} previewSample={previewSample} usedPaths={usedPaths} human />
    );

    return (
        <div
            // shrink-0: a flex child with overflow-hidden may shrink to 0.
            className={`${familyVarClass(family)} rounded-[10px] overflow-hidden group/sec shrink-0 border bg-[var(--bg-card)] ${isItem ? 'border-[var(--type-loop)]' : 'border-[var(--border-default)]'}`}
            data-testid="input-group"
            data-family={family || undefined}
        >
            <div className={`@container/srchead flex items-center border-b border-[var(--border-default)] ${isItem ? 'bg-[color-mix(in_srgb,var(--type-loop)_8%,transparent)]' : ''}`}>
                <div
                    draggable
                    onDragStart={(e) => startPathDrag(e, group.basePath, each?.over ? { source: each.over, take: 'each' } : null)}
                    onClick={() => setOpen(o => !o)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
                    title={[summary?.label, each
                        ? t('mapping.source.drag_whole_item', 'Drag to use this whole item')
                        : t('routines.mapping.drag_whole_output', 'Drag to use the whole output ({path})', { path: group.basePath })].filter(Boolean).join(' · ')}
                    className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-[9px] text-xs cursor-grab active:cursor-grabbing select-none"
                >
                    {open ? <ChevronDown size={14} className="shrink-0 text-[var(--text-tertiary)]" /> : <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />}
                    <Icon size={14} className="shrink-0 text-[var(--fam)]" />
                    {number != null && <span className="text-[var(--text-primary)] font-semibold whitespace-nowrap">{t('routines.mapping.step_n', 'Step {n}', { n: number })} ·</span>}
                    <span className="min-w-0 text-[var(--text-primary)] font-semibold truncate">{group.label}</span>
                    {isItem && !group.currentItem && <span className="text-[var(--text-tertiary)] truncate">{t('routines.mapping.current_item', 'current item of the loop')}</span>}
                    {/* In a narrow panel the step's name gets the room: the counts step aside. */}
                    <span className="ml-auto shrink-0 hidden @[18rem]/srchead:inline text-[11px] text-[var(--text-tertiary)] whitespace-nowrap" data-testid="input-group-meta">{meta}</span>
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
                                ? t('routines.mapping.iteration_of_capped', '{n} of {total} · {skipped} not processed', { n: iteration.index, total: iteration.total, skipped: iteration.skipped })
                                : t('routines.mapping.iteration_of', '{n} of {total}', { n: iteration.index, total: iteration.total })}
                        </span>
                    )}
                </div>
                {/* The table maps columns of the whole list: not what the current item is. */}
                {!each && (
                    <button
                        type="button"
                        onClick={onOpenTable}
                        title={t('routines.mapping.open_table_title', 'Open {label} as a table — map a whole column or a single cell', { label: group.label })}
                        aria-label={t('routines.mapping.open_table', 'Open {label} as a table', { label: group.label })}
                        className="shrink-0 mr-1 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] opacity-0 group-hover/sec:opacity-100 focus:opacity-100 transition"
                    >
                        <Table2 size={12} />
                    </button>
                )}
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
                            {t('routines.mapping.n_more', '{n} more', { n: plan.more })}
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
                                <span className="shrink-0 whitespace-nowrap">{t('routines.mapping.technical_details', 'Technical details')}</span>
                                <span className="ml-auto min-w-0 truncate">
                                    {t('routines.mapping.technical_meta', '{n} fields · {names}', { n: plan.technical.length, names: technicalPreview(plan.technical) })}
                                </span>
                            </button>
                            {(techOpen || searching) && plan.technical.map(row)}
                        </div>
                    )}
                    {fields.length === 0 && (
                        <div className="px-4 py-1 text-[11px] text-[var(--text-tertiary)] italic">
                            {each
                                ? t('mapping.source.current_item_empty', 'No item seen in this list yet. Run the steps before this one to see what an item holds.')
                                // One key for the whole sentence, so any language can reorder it.
                                : t('routines.mapping.no_named_fields', 'No named fields — open {table} to map from the raw output.', { table: t('routines.mapping.table', 'Table') })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
