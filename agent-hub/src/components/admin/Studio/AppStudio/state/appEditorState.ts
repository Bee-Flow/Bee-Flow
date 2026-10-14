/**
 * The editor store's shape, written down for TypeScript readers.
 *
 * AppEditorContext.jsx owns the reducer and stays JavaScript; its context is
 * created with a `null` default, so TypeScript would read useAppEditor() as
 * returning nothing usable. useAppEditorState() is the same hook with the
 * state and the action vocabulary named — every member here mirrors
 * initialState()/reducer() in AppEditorContext.jsx.
 */
import type { Dispatch } from 'react';
import { useAppEditor } from './AppEditorContext';
import type { AppDefinition } from '../inspector/appDefinition';

export type EditorMode = 'edit' | 'preview';

export type AppEditorAction =
    | { type: 'set_definition'; definition: AppDefinition | null; version?: number | string | null }
    | { type: 'select_node'; nodeId: string | null }
    | { type: 'toggle_node'; nodeId: string }
    | { type: 'select_many'; ids: string[] }
    | { type: 'clear_selection' }
    | { type: 'set_screen'; screenId: string }
    | { type: 'set_mode'; mode: EditorMode }
    | { type: 'set_stream_lock'; streamLock: boolean }
    | { type: 'set_recent_ids'; ids: Iterable<string>; delays?: Map<string, number> | null }
    | { type: 'clear_recent_id'; nodeId: string }
    | { type: 'clear_recent_ids' }
    | { type: 'set_version'; version: number | string | null }
    | { type: 'set_preview_role'; role: string | null; user?: unknown };

export interface AppEditorValue {
    appId: string | null;
    definition: AppDefinition | null;
    version: number | string | null;
    screenId: string | null;
    selectedNodeIds: Set<string>;
    selectedNodeId: string | null;
    mode: EditorMode;
    streamLock: boolean;
    recentlyAddedIds: Set<string>;
    revealDelays: Map<string, number>;
    previewRole: string | null;
    previewUser: unknown;
    dispatch: Dispatch<AppEditorAction>;
}

/** useAppEditor(), typed. Throws outside <AppEditorProvider>, like the original. */
export function useAppEditorState(): AppEditorValue {
    return useAppEditor() as AppEditorValue;
}
