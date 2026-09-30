/**
 * The refine conversation as data, and the words for a refine's changes —
 * the web's RefineDoneCard (changeLabel, undoStateOf), pure.
 */

import { nOf } from '@/shared/lib/plural';

import type { RefineChange } from './refineMerge';

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

export type UndoState = 'idle' | 'busy' | 'undone' | 'failed';

export type RefineTurn =
    | { kind: 'user'; text: string }
    | { kind: 'done'; changes: RefineChange[]; undoVersionId: string | null; undo: UndoState }
    | { kind: 'error'; text: string };

/** One line per change; the singular/plural choice is a KEY choice. */
export function changeLabel(t: Translate, change: RefineChange): string | null {
    const { field, direction, count = 0 } = change;
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
    const added = direction === 'added';
    if (field === 'apps') {
        return added
            ? nOf(t, 'agent_studio.refine.change_apps_added', count, ['Turned on {count} app', 'Turned on {count} apps'])
            : nOf(t, 'agent_studio.refine.change_apps_removed', count, ['Turned off {count} app', 'Turned off {count} apps']);
    }
    if (field === 'skills') {
        return added
            ? nOf(t, 'agent_studio.refine.change_skills_added', count, ['Attached {count} skill', 'Attached {count} skills'])
            : nOf(t, 'agent_studio.refine.change_skills_removed', count, ['Detached {count} skill', 'Detached {count} skills']);
    }
    if (field === 'knowledge') {
        return added
            ? nOf(t, 'agent_studio.refine.change_knowledge_added', count, ['Added {count} knowledge base', 'Added {count} knowledge bases'])
            : nOf(t, 'agent_studio.refine.change_knowledge_removed', count, ['Removed {count} knowledge base', 'Removed {count} knowledge bases']);
    }
    return null;
}

export type UndoButtonState = 'idle' | 'busy' | 'undone' | 'unavailable' | 'superseded';

/** Undo goes ONE level deep: only the newest Done turn can, the rest say why not. */
export function undoStateOf(turn: { undoVersionId: string | null; undo: UndoState }, superseded: boolean): UndoButtonState {
    if (turn.undo === 'undone') return 'undone';
    if (turn.undo === 'busy') return 'busy';
    if (!turn.undoVersionId) return 'unavailable';
    if (superseded) return 'superseded';
    return 'idle';
}

export function undoLabel(t: Translate, state: UndoButtonState): string {
    switch (state) {
        case 'busy': return t('agent_studio.refine.undoing', 'Undoing…');
        case 'undone': return t('agent_studio.refine.undone', 'Undone');
        case 'unavailable': return t('agent_studio.refine.undo_unavailable', 'Undo unavailable — no restore point was saved');
        case 'superseded': return t('agent_studio.refine.undo_superseded', 'Undo unavailable — a newer change came after this one');
        default: return t('agent_studio.refine.undo', 'Undo');
    }
}

export function lastDoneIndex(turns: readonly RefineTurn[]): number {
    return turns.reduce((last, turn, i) => (turn.kind === 'done' ? i : last), -1);
}

/** Replace one turn's undo state, leaving every other turn as it was. */
export function withUndo(turns: readonly RefineTurn[], index: number, undo: UndoState): RefineTurn[] {
    return turns.map((turn, i) => (i === index && turn.kind === 'done' ? { ...turn, undo } : turn));
}
