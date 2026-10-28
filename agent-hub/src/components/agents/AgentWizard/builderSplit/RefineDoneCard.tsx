import { FlaskConical, Undo2 } from 'lucide-react';
import { nOf } from '@/components/admin/Studio/KnowledgeStudio/plural';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { RefineChange as MergedRefineChange } from '../state/refineMerge.types';

/** One field the refine touched, from `state/refineMerge.diffRefinedPlan`; read defensively. */
export type RefineChange = Partial<MergedRefineChange>;

export interface RefineDoneCardProps {
    t: TranslateFn;
    changes?: RefineChange[];
    undoVersionId?: string | null;
    undoState?: string;
    superseded?: boolean;
    onTest?: () => void;
    onUndo?: (versionId: string | null) => void;
}

/**
 * The "Done: …" turn of the refine rail (A2 step 5).
 *
 * After a refinement the rail showed the whole plan card again (name,
 * description, capabilities), while the editor next to it already shows those
 * same fields updated. What was missing was the one thing the user cannot see:
 * WHICH fields the refinement touched. That is `changes`, the diff from
 * `state/refineMerge.diffRefinedPlan`.
 *
 * Two rules sit in this file, and both are the kind that later gets reversed by
 * accident:
 *
 *   AN EMPTY DIFF IS A SENTENCE, NOT AN EMPTY LIST. A model that copies the
 *   existing text back yields zero changes. "Done" with nothing under it then
 *   reads as "something happened that I am not telling you about".
 *
 *   UNDO NEVER DISAPPEARS SILENTLY. The button is there even when it cannot act,
 *   because there is no pre_refine row or because a newer refinement has gone
 *   over it in the meantime, and then it says what is wrong. A button that quietly
 *   goes away makes the user think the refinement is final. A button that did act
 *   would restore a DIFFERENT moment than the one it sits under.
 *   Undo goes exactly ONE level deep: only the newest turn.
 */

/** De regel bij één wijziging — de vormkeuze is een SLEUTELkeuze, nooit een stringkeuze. */
function changeLabel(t: TranslateFn, change?: RefineChange) {
    const { field, direction, count } = change || {};
    if (!direction) {
        switch (field) {
            case 'systemPrompt': return t('agent_studio.refine.change_instructions', 'Rewrote the instructions');
            case 'name': return t('agent_studio.refine.change_name', 'Renamed the agent');
            case 'description': return t('agent_studio.refine.change_description', 'Updated the description');
            case 'avatar': return t('agent_studio.refine.change_avatar', 'Changed the avatar');
            case 'model': return t('agent_studio.refine.change_model', 'Changed the model');
            default: return null;
        }
    }
    if (field === 'apps') {
        return direction === 'added'
            ? nOf(t, 'agent_studio.refine.change_apps_added', count, 'Turned on {count} app', 'Turned on {count} apps')
            : nOf(t, 'agent_studio.refine.change_apps_removed', count, 'Turned off {count} app', 'Turned off {count} apps');
    }
    if (field === 'skills') {
        return direction === 'added'
            ? nOf(t, 'agent_studio.refine.change_skills_added', count, 'Attached {count} skill', 'Attached {count} skills')
            : nOf(t, 'agent_studio.refine.change_skills_removed', count, 'Detached {count} skill', 'Detached {count} skills');
    }
    if (field === 'knowledge') {
        return direction === 'added'
            ? nOf(t, 'agent_studio.refine.change_knowledge_added', count, 'Added {count} knowledge base', 'Added {count} knowledge bases')
            : nOf(t, 'agent_studio.refine.change_knowledge_removed', count, 'Removed {count} knowledge base', 'Removed {count} knowledge bases');
    }
    return null;
}

/**
 * The undo button in four states. Three of them are "no, and this is why";
 * only `idle` does something.
 */
function undoStateOf({ undoVersionId, undoState, superseded }: { undoVersionId?: string | null; undoState?: string; superseded?: boolean }) {
    if (undoState === 'undone') return 'undone';
    if (undoState === 'busy') return 'busy';
    if (!undoVersionId) return 'unavailable';
    if (superseded) return 'superseded';
    return 'idle';
}

export default function RefineDoneCard({
    t,
    changes = [],
    undoVersionId = null,
    undoState = 'idle',
    superseded = false,
    onTest,
    onUndo,
}: RefineDoneCardProps) {
    const lines = (Array.isArray(changes) ? changes : []).map(c => changeLabel(t, c)).filter(Boolean);
    const state = undoStateOf({ undoVersionId, undoState, superseded });
    const undoDisabled = state !== 'idle';
    const undoText = {
        idle: t('agent_studio.refine.undo', 'Undo'),
        busy: t('agent_studio.refine.undoing', 'Undoing…'),
        undone: t('agent_studio.refine.undone', 'Undone'),
        unavailable: t('agent_studio.refine.undo_unavailable', 'Undo unavailable — no restore point was saved'),
        superseded: t('agent_studio.refine.undo_superseded', 'Undo unavailable — a newer change came after this one'),
    }[state];

    return (
        <div
            data-testid="refine-done-card"
            className="rounded-2xl border px-4 py-3 [border-color:var(--border-default)] [background:var(--bg-card,transparent)]"
        >
            <div className="text-sm font-semibold text-[var(--text-primary)]">
                {t('agent_studio.refine.done_title', 'Done')}
            </div>

            {lines.length === 0 ? (
                // Zero changes is an outcome, not an empty list.
                <p className="mt-1 text-[13px] text-[var(--text-secondary)]" data-testid="refine-done-nothing">
                    {t('agent_studio.refine.done_nothing', 'Nothing changed — the agent already worked that way.')}
                </p>
            ) : (
                <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--text-secondary)]" data-testid="refine-done-changes">
                    {lines.map((line, i) => (
                        <li key={i} className="flex gap-2">
                            <span aria-hidden="true">·</span>
                            <span>{line}</span>
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={onTest}
                    data-testid="refine-done-test"
                    className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition border-[var(--border-default)] text-[var(--text-primary)]"
                >
                    <FlaskConical size={13} aria-hidden="true" />
                    {t('agent_studio.refine.test_cta', 'Test with a question')}
                </button>
                <button
                    type="button"
                    onClick={() => { if (!undoDisabled) onUndo?.(undoVersionId); }}
                    disabled={undoDisabled}
                    data-testid="refine-done-undo"
                    data-undo-state={state}
                    title={undoText}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 disabled:cursor-not-allowed border-[var(--border-default)] text-[var(--text-primary)]"
                >
                    <Undo2 size={13} aria-hidden="true" />
                    {undoText}
                </button>
            </div>

            {undoState === 'failed' && (
                <p className="mt-2 text-[12px] text-[var(--error)]" data-testid="refine-done-undo-failed">
                    {t('agent_studio.refine.undo_failed', 'Undo failed — the agent was left as it is.')}
                </p>
            )}
        </div>
    );
}
