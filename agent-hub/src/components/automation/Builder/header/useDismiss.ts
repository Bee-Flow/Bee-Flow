import { useEffect, useRef, useState } from 'react';
import useOutsideDismiss from '@/hooks/useOutsideDismiss';

/**
 * Open state for a small header menu that closes on a mousedown outside it
 * or on Escape. Returns the ref to put on the menu's wrapper.
 */
export default function useDismiss<T extends HTMLElement = HTMLDivElement>() {
    const [open, setOpen] = useState(false);
    const ref = useRef<T | null>(null);
    useOutsideDismiss(ref, () => setOpen(false), { enabled: open, defer: false });
    return { open, setOpen, ref };
}
