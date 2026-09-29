import { useEffect, useRef, useState } from 'react';

/**
 * Open state for a small header menu that closes on a mousedown outside it
 * or on Escape. Returns the ref to put on the menu's wrapper.
 */
export default function useDismiss<T extends HTMLElement = HTMLDivElement>() {
    const [open, setOpen] = useState(false);
    const ref = useRef<T | null>(null);
    useEffect(() => {
        if (!open) return undefined;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);
    return { open, setOpen, ref };
}
