// "Open the large editor for step X", from anywhere in the builder.
//
// The large editor edits the settings form's own draft, so it has to be
// opened by the code step's editor, which owns that draft. The step drawer's
// header is two components away from it; a tiny signal keyed by step id
// reaches it without threading a callback through every layer in between.
import { useEffect, useRef } from 'react';

type Listener = (stepId: string) => void;
const listeners = new Set<Listener>();

export function requestLargeCodeEditor(stepId: string): void {
    for (const l of [...listeners]) l(stepId);
}

/** Call `open` whenever something asks for this step's large editor. */
export function useLargeEditorRequest(stepId: string | null | undefined, open: () => void): void {
    const openRef = useRef(open);
    useEffect(() => { openRef.current = open; });
    useEffect(() => {
        if (!stepId) return undefined;
        const l: Listener = (id) => { if (id === stepId) openRef.current(); };
        listeners.add(l);
        return () => { listeners.delete(l); };
    }, [stepId]);
}
