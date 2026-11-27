import { createContext, useCallback, useContext, useLayoutEffect, useRef, type RefObject } from 'react';

type Draft = {text: string; focused: boolean; question?: string};

/** One buffer per page. The loading form may unmount when either the chunk or the task data arrives. */
export function createPendingBeeDraft() {
    let draft: Draft = {text: '', focused: false};
    return {
        read: () => draft,
        update: (change: Partial<Draft>) => { draft = {...draft, ...change}; },
        takeQuestion: () => {
            const question = draft.question ?? '';
            draft = {...draft, question: undefined};
            return question;
        },
    };
}

export const PendingBeeDraft = createContext<ReturnType<typeof createPendingBeeDraft> | null>(null);

export function usePendingBeeDraft(setText: (value: string) => void, suppliedInput?: RefObject<HTMLTextAreaElement | null>) {
    const draft = useContext(PendingBeeDraft);
    const local = useRef<HTMLTextAreaElement>(null);
    const input = suppliedInput ?? local;
    useLayoutEffect(() => {
        if (!draft) return;
        const {text, focused} = draft.read();
        if (!text && !focused) return;
        draft.update({text: '', focused: false});
        setText(text);
        if (focused && document.activeElement === document.body) input.current?.focus({preventScroll: true});
    }, [draft, setText, input]);
    return input;
}

/** The task can answer a message sent before its route or data finished loading. */
export function useTakePendingQuestion() {
    const draft = useContext(PendingBeeDraft);
    return useCallback(() => draft?.takeQuestion() ?? '', [draft]);
}
