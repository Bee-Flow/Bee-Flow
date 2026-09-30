/** Ticking rows for a bulk delete: on, off, and one row in or out. */

import { useCallback, useState } from 'react';

export function useRowSelection() {
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
    const toggle = useCallback(
        (id: string) =>
            setSelected((cur) => {
                const next = new Set(cur);
                if (!next.delete(id)) next.add(id);
                return next;
            }),
        [],
    );
    const stop = useCallback(() => {
        setSelecting(false);
        setSelected(new Set());
    }, []);
    return { selecting, selected, start: () => setSelecting(true), stop, toggle };
}
