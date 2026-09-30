/** Which rows of a list are open: a set of indices, toggled one at a time. */

import { useState } from 'react';

export function useToggleSet(): { has: (index: number) => boolean; toggle: (index: number) => void } {
    const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
    return {
        has: (index) => open.has(index),
        toggle: (index) =>
            setOpen((prev) => {
                const next = new Set(prev);
                if (!next.delete(index)) next.add(index);
                return next;
            }),
    };
}
