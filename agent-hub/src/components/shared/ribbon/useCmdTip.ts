import { useEffect, useRef, useState } from 'react';

/**
 * Open/close timing for one ribbon command's screen tip (see CmdTip.jsx).
 *
 * Hover waits {@link SHOW_DELAY_MS} so sweeping the pointer across a ribbon
 * doesn't flash a dozen tips on the way past; keyboard focus shows immediately,
 * because a user who tabbed here is asking.
 *
 * `dismiss` is handed back SEPARATELY from `hoverProps` rather than as an
 * `onClick` inside it: spreading a handler bundle containing onClick over a
 * button's own onClick silently swallowed every click. The caller composes.
 */
export const SHOW_DELAY_MS = 350;

export interface CmdTipHoverProps {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
}

export interface CmdTipState {
    open: boolean;
    hoverProps: CmdTipHoverProps;
    dismiss: ((e?: React.SyntheticEvent) => void) | null;
}

export default function useCmdTip(enabled = true): CmdTipState {
    const [open, setOpen] = useState<boolean>(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
    useEffect(() => clear, []);

    if (!enabled) return { open: false, hoverProps: {}, dismiss: null };

    return {
        open,
        hoverProps: {
            onMouseEnter: () => { clear(); timer.current = setTimeout(() => setOpen(true), SHOW_DELAY_MS); },
            onMouseLeave: () => { clear(); setOpen(false); },
            onFocus: () => { clear(); setOpen(true); },
            onBlur: () => { clear(); setOpen(false); },
        },
        // A click means the user has decided; leaving the tip up over the canvas
        // they just dropped a step onto is noise.
        dismiss: () => { clear(); setOpen(false); },
    };
}
