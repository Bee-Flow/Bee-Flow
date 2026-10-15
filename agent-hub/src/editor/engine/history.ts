/**
 * history.js — snapshot undo/redo with typing coalescing.
 *
 * Because transforms use structural sharing, a "snapshot" is just a reference to
 * the previous { doc, selection } — cheap. Consecutive `type` transactions within
 * a short window coalesce so undo removes a run, not one character.
 */
import type { EditorState } from './state.js';

export interface History {
  done: EditorState[];
  undone: EditorState[];
  lastKind: string | null;
  lastTime: number;
}

export function createHistory(): History {
  return { done: [], undone: [], lastKind: null, lastTime: 0 };
}

const COALESCE_MS = 400;
const CAP = 250;

/** Record `prevState` before a transaction of `kind` applied at `time` (ms). */
export function record(history: History, prevState: EditorState, kind: string, time: number): void {
  const coalesce = kind === 'type' && history.lastKind === 'type' && time - history.lastTime < COALESCE_MS;
  if (!coalesce) {
    history.done.push(prevState);
    if (history.done.length > CAP) history.done.shift();
  }
  history.undone = [];
  history.lastKind = kind;
  history.lastTime = time;
}

export function canUndo(history: History): boolean { return history.done.length > 0; }
export function canRedo(history: History): boolean { return history.undone.length > 0; }

export function undo(history: History, current: EditorState): EditorState | null {
  if (!history.done.length) return null;
  const prev = history.done.pop();
  history.undone.push(current);
  history.lastKind = null;
  return prev as EditorState;
}

export function redo(history: History, current: EditorState): EditorState | null {
  if (!history.undone.length) return null;
  const next = history.undone.pop();
  history.done.push(current);
  history.lastKind = null;
  return next as EditorState;
}
