/**
 * The state of a text box that writes only when it is left or submitted — a
 * name, an output's name — never per keystroke, so a half-typed value never
 * reaches the draft or the autosave. The box keeps its own text while the
 * author types, adopts the value again whenever it changes from outside (undo,
 * the AI builder, a row removed above), and commits on unmount too
 * (useCommitOnUnmount says why).
 *
 * `judge` writes the typed text if it may and answers the error to show — null
 * when it wrote — and `revert` for a refusal that puts the stored value back.
 */

import { useState } from 'react';

import { useCommitOnUnmount } from './useCommitOnUnmount';

export interface CommitVerdict<E> {
    error: E | null;
    revert?: boolean;
}

export function useCommitText<E = string>(value: string, judge: (text: string) => CommitVerdict<E>) {
    const [text, setText] = useState(value);
    const [error, setError] = useState<E | null>(null);
    const [seen, setSeen] = useState(value);
    if (seen !== value) {
        setSeen(value);
        setText(value);
        setError(null);
    }
    const commit = () => {
        const out = judge(text);
        if (out.revert) setText(value);
        setError(out.error);
    };
    const change = (next: string) => {
        setText(next);
        setError(null);
    };
    useCommitOnUnmount(text !== value, commit);
    return { text, error, commit, change };
}
