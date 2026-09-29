// Dismiss-on-outside-interaction hook — replaces the recurring
//   useEffect(() => { const onDown = (e) => {...}; const onKey = (e) => {...};
//   document.addEventListener('mousedown', onDown); ... }, [open])
// pattern that's open-coded across the chat settings popovers
// (ElevenLabs/VideoGen/NanoBanana/MusicGen), the sitemap editor's
// EdgePopover/SettingsFlyout, and several admin dropdowns.
//
// Usage:
//   const ref = useRef(null);
//   useOutsideDismiss(ref, () => setOpen(false), { enabled: open });
//   {open && <div ref={ref}>…</div>}
//
// The mousedown listener is attached on a deferred tick so the click that
// opened the panel never immediately dismisses it. Escape is handled too
// (disable with `escape: false`).

import { useEffect, useEffectEvent, type RefObject } from 'react';

export interface OutsideDismissOptions {
    enabled?: boolean;
    escape?: boolean;
}

export default function useOutsideDismiss<T extends HTMLElement>(
    ref: RefObject<T | null>,
    onDismiss: () => void,
    { enabled = true, escape = true }: OutsideDismissOptions = {},
): void {
    // Callers pass inline closures; an Effect Event reads the latest one
    // without re-subscribing per render (which would defeat the deferred attach).
    const dismiss = useEffectEvent(() => onDismiss());
    useEffect(() => {
        if (!enabled) return undefined;

        const onMouseDown = (e: MouseEvent) => {
            const target = e.target;
            if (ref.current && target instanceof Node && !ref.current.contains(target)) dismiss();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (escape && e.key === 'Escape') dismiss();
        };

        // Defer so the opening click doesn't instantly close the panel.
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', onMouseDown);
            document.addEventListener('keydown', onKeyDown);
        }, 0);

        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [enabled, escape, ref]);
}
