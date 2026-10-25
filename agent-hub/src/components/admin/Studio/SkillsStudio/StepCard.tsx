import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BookOpen, ChevronDown, GripVertical, Plus, Table, Trash2, Workflow, X, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import { kindColorVar, kindTint } from '../../../shared/kindColors';
import { refKindKey } from './skillModel';
import type { RefMenuProps, RefOption, RefOptions, RefPillsProps, StepCardProps, StepRef } from './SkillStepEditor.types';
import { readListStatus } from './useSkillPickerData';

export function StepCard({ step, index, readOnly, refOptions, listStatus, onOpenRef, onText, onRefs, onRemove, t }: StepCardProps) {
    const {
        attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
    } = useSortable({ id: step.id, disabled: readOnly });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
    };

    return (
        <li
            ref={setNodeRef}
            style={style}
            data-testid="skill-step"
            data-step-id={step.id}
            className="flex items-start gap-2.5 p-2.5 rounded-[10px] bg-[var(--bg-card)] border border-[var(--border-default)] shadow-sm"
        >
            <span
                aria-hidden="true"
                className="w-[22px] h-[22px] rounded-md grid place-items-center text-[11px] font-bold flex-shrink-0"
                style={{ background: kindTint('skill', 14), color: kindColorVar('skill') }}
            >
                {index + 1}
            </span>
            <div className="flex-1 min-w-0 flex flex-wrap items-start gap-1.5">
                <textarea
                    value={step.text}
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onText(e.target.value)}
                    readOnly={readOnly}
                    rows={1}
                    aria-label={t('skills_studio.steps.step_n', 'Step {n}', { n: index + 1 })}
                    placeholder={t('skills_studio.steps.placeholder', 'What happens in this step?')}
                    className="w-full min-w-0 resize-y bg-transparent outline-none text-[13px] leading-[18px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
                <RefPills
                    refs={step.refs}
                    readOnly={readOnly}
                    refOptions={refOptions}
                    listStatus={listStatus}
                    onOpenRef={onOpenRef}
                    onRefs={onRefs}
                    t={t}
                />
            </div>
            {!readOnly && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t('skills_studio.steps.remove', 'Remove step')}
                    title={t('skills_studio.steps.remove', 'Remove step')}
                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] transition flex-shrink-0"
                >
                    <Trash2 size={13} aria-hidden="true" />
                </button>
            )}
            {!readOnly && (
                <button
                    type="button"
                    ref={setActivatorNodeRef}
                    {...attributes}
                    {...listeners}
                    aria-label={t('skills_studio.steps.reorder', 'Reorder step {n}', { n: index + 1 })}
                    data-testid="skill-step-grip"
                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-grab flex-shrink-0"
                >
                    <GripVertical size={14} aria-hidden="true" />
                </button>
            )}
        </li>
    );
}

const REF_ICON: Record<string, LucideIcon> = { automation: Workflow, kb: BookOpen, table: Table };

/** The label a ref shows: the referenced thing's name, or its bare id. */
function refLabel(ref: StepRef, refOptions?: RefOptions | null) {
    const bucket = refOptions?.[ref.kind];
    const hit = Array.isArray(bucket) ? bucket.find((o: RefOption) => String(o.id) === String(ref.id)) : null;
    return hit?.name || hit?.title || ref.id;
}

function RefPills({ refs, readOnly, refOptions, listStatus, onOpenRef, onRefs, t }: RefPillsProps) {
    const rows = Array.isArray(refs) ? refs : [];
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);

    const addRef = (kind: string, id: string) => {
        setOpen(false);
        if (!id) return;
        if (rows.some((r: StepRef) => r.kind === kind && String(r.id) === String(id))) return;
        onRefs([...rows, { kind, id: String(id) }]);
    };
    const dropRef = (ref: StepRef) => onRefs(rows.filter((r: StepRef) => !(r.kind === ref.kind && r.id === ref.id)));

    return (
        <>
            {rows.map((ref: StepRef) => {
                const Icon = REF_ICON[ref.kind] || Workflow;
                const color = kindColorVar(refKindKey(ref.kind));
                return (
                    <span
                        key={`${ref.kind}:${ref.id}`}
                        data-testid="skill-step-ref"
                        data-ref-kind={ref.kind}
                        className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-semibold max-w-full"
                        style={{ background: kindTint(refKindKey(ref.kind), 14), color }}
                    >
                        <Icon size={11} aria-hidden="true" className="flex-shrink-0" />
                        {/* A BUTTON only when there is somewhere to go. Without
                            `onOpenRef` this was a control that swallowed the
                            click — and a dead control reads as a broken app,
                            not as an absent feature. Read-only viewers keep it:
                            opening the thing a step points at is looking, not
                            editing. */}
                        {onOpenRef ? (
                            <button
                                type="button"
                                onClick={() => onOpenRef(ref)}
                                className="truncate hover:underline"
                            >
                                {refLabel(ref, refOptions)}
                            </button>
                        ) : (
                            <span className="truncate">{refLabel(ref, refOptions)}</span>
                        )}
                        {!readOnly && (
                            <button
                                type="button"
                                onClick={() => dropRef(ref)}
                                aria-label={t('skills_studio.steps.ref_remove', 'Remove reference')}
                                className="p-0.5 rounded-full hover:bg-[var(--bg-tertiary)]"
                            >
                                <X size={10} aria-hidden="true" />
                            </button>
                        )}
                    </span>
                );
            })}
            {!readOnly && (
                <>
                    <button
                        type="button"
                        ref={anchorRef}
                        onClick={() => setOpen(o => !o)}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        data-testid="skill-step-ref-add"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border border-dashed border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        <Plus size={11} aria-hidden="true" />
                        {t('skills_studio.steps.ref_add', 'reference')}
                        <ChevronDown size={10} aria-hidden="true" className="opacity-60" />
                    </button>
                    <RefMenu
                        open={open}
                        onClose={() => setOpen(false)}
                        anchorRef={anchorRef}
                        refOptions={refOptions}
                        listStatus={listStatus}
                        taken={rows}
                        onPick={addRef}
                        t={t}
                    />
                </>
            )}
        </>
    );
}

const REF_GROUPS: { kind: string; key: string; en: string }[] = [
    { kind: 'automation', key: 'skills_studio.ref.automations', en: 'Automations' },
    { kind: 'kb', key: 'skills_studio.ref.kbs', en: 'Knowledge bases' },
    { kind: 'table', key: 'skills_studio.ref.tables', en: 'Tables' },
];

/** Which `unavailable` id each ref group is fed by. */
const REF_LIST_ID: Readonly<Record<string, string>> = Object.freeze({ automation: 'automations', kb: 'kbs', table: 'tables' });

function RefMenu({ open, onClose, anchorRef, refOptions, listStatus, taken, onPick, t }: RefMenuProps) {
    // A reference this step already carries is not offered a second time:
    // `addRef` would refuse the click, and a menu item that does nothing is
    // worse than an absent one.
    const has = (kind: string, id: string) => (taken || []).some((r: StepRef) => r.kind === kind && String(r.id) === String(id));
    const { loaded, unread, reload } = readListStatus(listStatus);
    const all = REF_GROUPS.map(g => ({
        ...g,
        items: (Array.isArray(refOptions?.[g.kind]) ? refOptions[g.kind] : []).filter((i: RefOption) => !has(g.kind, i.id)),
    }));
    const groups = all.filter(g => g.items.length > 0);
    // The lists this menu draws on that did NOT arrive, by their own group
    // name. Without this a partial failure was invisible: the Automations heading
    // simply disappeared (an empty group is filtered out above) while Tables
    // stayed, which reads as "this org has no automations".
    const missing = all.filter(g => unread.includes(REF_LIST_ID[g.kind])).map(g => t(g.key, g.en));
    return (
        <AnchoredMenu
            open={open}
            onClose={onClose}
            anchorRef={anchorRef}
            align="left"
            width={280}
            maxHeight={320}
            role="menu"
            aria-label={t('skills_studio.steps.ref_add', 'reference')}
            className="py-1"
        >
            {/* Exactly one of four, and the first three are the ones the
                fourth used to swallow. A ref is a GRANT (see the header), so
                telling somebody there is nothing to reference when nobody
                looked costs them a grant they needed. */}
            {!loaded && (
                <p className="px-3 py-2 text-xs text-[var(--text-tertiary)] m-0" data-testid="skill-ref-loading">
                    {t('skills_studio.ref.loading', 'Loading…')}
                </p>
            )}
            {loaded && missing.length > 0 && (
                <p
                    className="px-3 py-2 text-xs m-0 text-[var(--warning)] flex flex-wrap items-baseline gap-x-2"
                    data-testid="skill-ref-unread"
                    role="status"
                >
                    <span>
                        {t(
                            'skills_studio.ref.unread',
                            'Could not be read: {lists}. That is not “you have none”.',
                            { lists: missing.join(', ') },
                        )}
                    </span>
                    {reload && (
                        <button
                            type="button"
                            onClick={reload}
                            data-testid="skill-ref-retry"
                            className="underline decoration-dotted text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                        >
                            {t('skills_studio.canuse.retry', 'Try again')}
                        </button>
                    )}
                </p>
            )}
            {loaded && missing.length === 0 && groups.length === 0 && (
                <p className="px-3 py-2 text-xs text-[var(--text-tertiary)] m-0" data-testid="skill-ref-none">
                    {t('skills_studio.ref.none', 'Nothing to reference yet.')}
                </p>
            )}
            {groups.map((group) => (
                <div key={group.kind}>
                    <p className="px-3 pt-2 pb-1 m-0 text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">
                        {t(group.key, group.en)}
                    </p>
                    {group.items.map((item) => {
                        const Icon = REF_ICON[group.kind] || Workflow;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                role="menuitem"
                                onClick={() => onPick(group.kind, item.id)}
                                className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition"
                            >
                                <Icon size={13} aria-hidden="true" style={{ color: kindColorVar(refKindKey(group.kind)) }} />
                                <span className="min-w-0 flex-1 truncate">{item.name || item.title || item.id}</span>
                            </button>
                        );
                    })}
                </div>
            ))}
        </AnchoredMenu>
    );
}
