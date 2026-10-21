import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertCircle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import type { OpResult } from '../../../../../../api/queries/automation/tablePreview';
import { actionButtonClass } from '../formStyles';
import { opSummary } from './opSummary';
import type { OpHelp, Translate } from './opHelp';
import { OP_GROUPS, duplicateOp, moveOp, newOp, removeOp, replaceOp, type OpKind, type TableOp } from './tableOpModel';

const ICON_BUTTON = 'rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:hover:text-[var(--text-tertiary)]';

/** The menu that adds an operation: grouped by what it is for, each with one sentence on what it does. */
export function AddOpMenu({ help, onAdd, disabled }: { help: OpHelp; onAdd: (kind: OpKind) => void; disabled?: boolean }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <div className="flex flex-col gap-1.5">
            <button type="button" aria-expanded={open} disabled={disabled} onClick={() => setOpen(o => !o)} className={`${actionButtonClass()} self-start`}>
                <Plus size={12} /> {t('automation_tables.list.add', 'Add a step')}
            </button>
            {open && (
                <div role="menu" aria-label={t('automation_tables.list.add_menu', 'Choose what to do with the table')} className="flex flex-col gap-2 rounded border border-[var(--border-default)] bg-[var(--bg-card)] p-2">
                    {OP_GROUPS.map(group => (
                        <div key={group.key} role="group" aria-label={help.menuGroups[group.key]} className="flex flex-col gap-0.5">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{help.menuGroups[group.key]}</div>
                            {group.ops.map(kind => (
                                <button
                                    key={kind} type="button" role="menuitem"
                                    onClick={() => { onAdd(kind); setOpen(false); }}
                                    className="flex flex-col items-start rounded px-2 py-1 text-left hover:bg-[var(--bg-secondary)]"
                                >
                                    <span className="text-xs font-medium text-[var(--text-primary)]">{help.ops[kind].title}</span>
                                    <span className="text-[11px] text-[var(--text-secondary)]">{help.ops[kind].blurb}</span>
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

interface RowProps {
    op: TableOp;
    index: number;
    count: number;
    open: boolean;
    result: OpResult | undefined;
    problem: boolean;
    help: OpHelp;
    onOpen: () => void;
    onToggle: () => void;
    onMove: (to: number) => void;
    onDuplicate: () => void;
    onRemove: () => void;
    children: ReactNode;
}

function OpRow({ op, index, count, open, result, problem, help, onOpen, onToggle, onMove, onDuplicate, onRemove, children }: RowProps) {
    const { t } = useTranslation();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: op.id });
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
    const title = help.ops[op.op].title;
    const summary = opSummary(op, t as Translate);
    const flow = op.enabled && result && result.ok
        ? t('automation_tables.list.rows_flow', '{from} → {to} rows', { from: result.inputRows, to: result.outputRows })
        : '';
    return (
        <li ref={setNodeRef} style={style} data-testid={`op-row-${op.id}`} className={`rounded border ${problem ? 'border-[var(--error)]' : 'border-[var(--border-default)]'} bg-[var(--bg-card)] ${op.enabled ? '' : 'opacity-60'}`}>
            <div className="flex items-center gap-1 px-1.5 py-1">
                <button type="button" className={`${ICON_BUTTON} cursor-grab touch-none`} aria-label={t('automation_tables.list.drag', 'Drag to reorder: {name}', { name: title })} {...attributes} {...listeners}>
                    <GripVertical size={14} />
                </button>
                <button type="button" aria-expanded={open} onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    {open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{index + 1}. {title}</span>
                        {(summary || flow) && (
                            <span className="block truncate text-[11px] text-[var(--text-secondary)]">{[summary, flow].filter(Boolean).join(' · ')}</span>
                        )}
                    </span>
                    {problem && <AlertCircle size={14} className="shrink-0 text-[var(--error)]" role="img" aria-label={t('automation_tables.list.problem', 'This step has a problem')} data-testid="op-error" />}
                </button>
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-secondary)]">
                    <input type="checkbox" checked={op.enabled} onChange={onToggle} aria-label={t('automation_tables.list.enabled', 'Use this step: {name}', { name: title })} />
                    {op.enabled ? t('automation_tables.list.on', 'On') : t('automation_tables.list.off', 'Off')}
                </label>
                <button type="button" className={ICON_BUTTON} disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={t('automation_tables.list.up', 'Move up: {name}', { name: title })}><ArrowUp size={13} /></button>
                <button type="button" className={ICON_BUTTON} disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={t('automation_tables.list.down', 'Move down: {name}', { name: title })}><ArrowDown size={13} /></button>
                <button type="button" className={ICON_BUTTON} onClick={onDuplicate} aria-label={t('automation_tables.list.duplicate', 'Duplicate: {name}', { name: title })}><Copy size={13} /></button>
                <button type="button" className={`${ICON_BUTTON} hover:text-[var(--error)]`} onClick={onRemove} aria-label={t('automation_tables.list.remove', 'Remove: {name}', { name: title })}><Trash2 size={13} /></button>
            </div>
            {open && <div className="border-t border-[var(--border-default)] p-2">{children}</div>}
        </li>
    );
}

interface ListProps {
    ops: TableOp[];
    onChange: (next: TableOp[]) => void;
    openId: string | null;
    onOpen: (id: string | null) => void;
    results: readonly OpResult[];
    /** Operations (by id) the preview has a problem with. */
    problems: ReadonlySet<string>;
    help: OpHelp;
    renderForm: (op: TableOp, index: number) => ReactNode;
}

/**
 * The steps of an Edit table, in order: each row shows what the step is set to
 * do and how many rows go in and come out, and opens into its form. Reorder by
 * dragging or with the arrows; switch a step off to see the result without it.
 */
export default function TableOpList({ ops, onChange, openId, onOpen, results, problems, help, renderForm }: ListProps) {
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
    const onDragEnd = (e: DragEndEvent) => {
        if (!e.over || e.active.id === e.over.id) return;
        onChange(moveOp(ops, ops.findIndex(o => o.id === e.active.id), ops.findIndex(o => o.id === e.over?.id)));
    };
    const add = (kind: OpKind) => {
        const op = newOp(kind, ops);
        onChange([...ops, op]);
        onOpen(op.id);
    };
    return (
        <div className="flex flex-col gap-2">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={ops.map(o => o.id)} strategy={verticalListSortingStrategy}>
                    <ol className="flex flex-col gap-1.5">
                        {ops.map((op, index) => (
                            <OpRow
                                key={op.id} op={op} index={index} count={ops.length} open={openId === op.id}
                                result={results.find(r => r.opId === op.id)} problem={problems.has(op.id)} help={help}
                                onOpen={() => onOpen(openId === op.id ? null : op.id)}
                                onToggle={() => onChange(replaceOp(ops, index, { ...op, enabled: !op.enabled }))}
                                onMove={to => onChange(moveOp(ops, index, to))}
                                onDuplicate={() => onChange(duplicateOp(ops, index))}
                                onRemove={() => { onChange(removeOp(ops, index)); if (openId === op.id) onOpen(null); }}
                            >
                                {renderForm(op, index)}
                            </OpRow>
                        ))}
                    </ol>
                </SortableContext>
            </DndContext>
            <AddOpMenu help={help} onAdd={add} />
        </div>
    );
}
