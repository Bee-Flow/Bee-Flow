import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BookOpen, ChevronDown, GripVertical, Plus, Table, Trash2, Workflow, X } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import { kindColorVar, kindTint } from '../../../shared/kindColors';
import { moveItem, newLocalId, refKindKey } from './skillModel';
import { readListStatus } from './useSkillPickerData';

/**
 * "Steps" — the ordered instructions of a skill, as cards you can reorder
 * (Skills artboard 1a, centre column; plan S2).
 *
 * ── WHY CARDS AND NOT A TEXTAREA ────────────────────────────────────
 * A skill's `workflow` was one free-text box with numbered lines in it. The
 * numbers were typed by hand, so they went wrong; nothing could point at a
 * step; and the Test tab (S3) had nothing to grade against. A step is now a
 * row with an id, which is what lets the test say "step 3 passed" and what
 * lets a step carry REFERENCES.
 *
 * ── THE REFERENCE PILLS ARE THE DATA, NOT A SYNTAX ──────────────────
 * The artboard draws a reference INSIDE the sentence ("fetch it via
 * [Look up quote status]"). S1 stores `refs` as a list beside the text with
 * no offsets into it, so an inline token would be a second, undeclared
 * syntax that the server would silently drop on the first mobile save. The
 * pills therefore FLOW after the sentence in the same wrapping line — the
 * artboard's reading order, honestly backed by the shape that is stored.
 * (Deviation, recorded in the handoff.)
 *
 * A ref of kind `table` is a real grant: at activation the table joins the
 * agent's `datatable_query` allowlist, read-only and for that conversation
 * only (S1 §5). It is not decoration, which is why it is a picker and not
 * a free-text field.
 *
 * ── AND THEREFORE: AN UNREAD LIST IS NOT AN EMPTY ONE ───────────────
 * Because a ref is a grant, "Nothing to reference yet." is a claim worth
 * getting right. `refOptions` is three arrays and three arrays cannot tell a
 * read that failed from an org with nothing in it, so `listStatus` — the same
 * `{ loaded, unavailable, reload }` object CanUseCard reads — comes in beside
 * it. Before the first answer the menu says it is still asking; after a failed
 * read it names the lists it could not read and offers Retry; a PARTIAL
 * failure keeps the groups that did arrive and says so, instead of quietly
 * dropping Automations and leaving Tables looking complete.
 *
 * ── DRAG, AND ALSO NOT DRAG ─────────────────────────────────────────
 * `@dnd-kit/sortable`, the AppStudio canvas's own recipe
 * (editor/EditorNodeWrapper.jsx): a PointerSensor with an 8px activation
 * distance so a click on the text is never a drag, plus dnd-kit's
 * KeyboardSensor so the order can be changed without a pointer at all. The
 * grip is the ONLY drag handle (`setActivatorNodeRef`); the whole card being
 * draggable would fight the textarea inside it.
 */
export default function SkillStepEditor({
    steps,
    onChange,
    readOnly = false,
    refOptions = null,
    // `{ loaded, unavailable, reload }` from useSkillPickerData. Absent means
    // the caller passed literal lists and has its answer already.
    listStatus = null,
    onOpenRef = null,
}) {
    const { t } = useTranslation();
    const rows = Array.isArray(steps) ? steps : [];
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const ids = useMemo(() => rows.map(s => s.id), [rows]);

    const onDragEnd = (event) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const from = ids.indexOf(active.id);
        const to = ids.indexOf(over.id);
        if (from < 0 || to < 0) return;
        onChange(moveItem(rows, from, to));
    };

    const patch = (id, next) => onChange(rows.map(s => (s.id === id ? { ...s, ...next } : s)));
    const remove = (id) => onChange(rows.filter(s => s.id !== id));
    const add = () => onChange([...rows, { id: newLocalId('step'), text: '', refs: [] }]);

    return (
        <section className="flex flex-col gap-2 min-w-0" data-testid="skill-steps">
            <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)] m-0">
                    {t('skills_studio.steps.title', 'Steps')}
                </h2>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('skills_studio.steps.hint', 'in this order · drag to rearrange')}
                </span>
            </div>

            {rows.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)] italic m-0">
                    {t('skills_studio.steps.empty', 'No steps yet. Write down what the agent should do, one step at a time.')}
                </p>
            )}

            {/* No `modifiers` prop: @dnd-kit/modifiers is not a dependency of
                this app and adding one for an axis lock is not worth a package.
                `verticalListSortingStrategy` already keeps the list vertical. */}
            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
            >
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                    <ol className="list-none p-0 m-0 flex flex-col gap-1.5">
                        {rows.map((step, i) => (
                            <StepCard
                                key={step.id}
                                step={step}
                                index={i}
                                readOnly={readOnly}
                                refOptions={refOptions}
                                listStatus={listStatus}
                                onOpenRef={onOpenRef}
                                onText={(text) => patch(step.id, { text })}
                                onRefs={(refs) => patch(step.id, { refs })}
                                onRemove={() => remove(step.id)}
                                t={t}
                            />
                        ))}
                    </ol>
                </SortableContext>
            </DndContext>

            {!readOnly && (
                <button
                    type="button"
                    onClick={add}
                    data-testid="skill-step-add"
                    className="self-start flex items-center gap-1.5 px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-secondary)] transition"
                >
                    <Plus size={13} aria-hidden="true" />
                    {t('skills_studio.steps.add', 'Add step')}
                </button>
            )}
        </section>
    );
}

function StepCard({ step, index, readOnly, refOptions, listStatus, onOpenRef, onText, onRefs, onRemove, t }) {
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
                    onChange={(e) => onText(e.target.value)}
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

const REF_ICON = { automation: Workflow, kb: BookOpen, table: Table };

/** The label a ref shows: the referenced thing's name, or its bare id. */
export function refLabel(ref, refOptions) {
    const bucket = refOptions?.[ref.kind];
    const hit = Array.isArray(bucket) ? bucket.find(o => String(o.id) === String(ref.id)) : null;
    return hit?.name || hit?.title || ref.id;
}

function RefPills({ refs, readOnly, refOptions, listStatus, onOpenRef, onRefs, t }) {
    const rows = Array.isArray(refs) ? refs : [];
    const [open, setOpen] = useState(false);
    const anchorRef = useRef(null);

    const addRef = (kind, id) => {
        setOpen(false);
        if (!id) return;
        if (rows.some(r => r.kind === kind && String(r.id) === String(id))) return;
        onRefs([...rows, { kind, id: String(id) }]);
    };
    const dropRef = (ref) => onRefs(rows.filter(r => !(r.kind === ref.kind && r.id === ref.id)));

    return (
        <>
            {rows.map((ref) => {
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

const REF_GROUPS = [
    { kind: 'automation', key: 'skills_studio.ref.automations', en: 'Automations' },
    { kind: 'kb', key: 'skills_studio.ref.kbs', en: 'Knowledge bases' },
    { kind: 'table', key: 'skills_studio.ref.tables', en: 'Tables' },
];

/** Which `unavailable` id each ref group is fed by. */
const REF_LIST_ID = Object.freeze({ automation: 'automations', kb: 'kbs', table: 'tables' });

function RefMenu({ open, onClose, anchorRef, refOptions, listStatus, taken, onPick, t }) {
    // A reference this step already carries is not offered a second time:
    // `addRef` would refuse the click, and a menu item that does nothing is
    // worse than an absent one.
    const has = (kind, id) => (taken || []).some(r => r.kind === kind && String(r.id) === String(id));
    const { loaded, unread, reload } = readListStatus(listStatus);
    const all = REF_GROUPS.map(g => ({
        ...g,
        items: (Array.isArray(refOptions?.[g.kind]) ? refOptions[g.kind] : []).filter(i => !has(g.kind, i.id)),
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
