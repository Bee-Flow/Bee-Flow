import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type UniqueIdentifier } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import React, { useMemo } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { moveItem, newLocalId } from './skillModel';
import type { SkillStepEditorProps, Step, StepRef } from './SkillStepEditor.types';
import { StepCard } from './StepCard';
export { refLabel } from './StepCard';
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
}: SkillStepEditorProps) {
    const { t } = useTranslation();
    const rows = useMemo(() => (Array.isArray(steps) ? steps : []), [steps]);
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const ids = useMemo<UniqueIdentifier[]>(() => rows.map(s => s.id), [rows]);

    const onDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const from = ids.indexOf(active.id);
        const to = ids.indexOf(over.id);
        if (from < 0 || to < 0) return;
        onChange(moveItem(rows, from, to));
    };

    const patch = (id: string, next: Partial<Step>) => onChange(rows.map(s => (s.id === id ? { ...s, ...next } : s)));
    const remove = (id: string) => onChange(rows.filter(s => s.id !== id));
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
                        {rows.map((step: Step, i: number) => (
                            <StepCard
                                key={step.id}
                                step={step}
                                index={i}
                                readOnly={readOnly}
                                refOptions={refOptions}
                                listStatus={listStatus}
                                onOpenRef={onOpenRef}
                                onText={(text: string) => patch(step.id, { text })}
                                onRefs={(refs: StepRef[]) => patch(step.id, { refs })}
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

