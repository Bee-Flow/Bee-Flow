import { useCallback, useState } from 'react';

/**
 * Lightweight controller for opening a portal-anchored VariablePicker
 * against a specific DOM element (typically the {} button on a binding
 * field). The anchor is captured at click-time, not tracked via ref, so
 * there's no stale-handle window when fields unmount.
 *
 * Returns:
 *   open          — boolean
 *   openPicker(el, { initialQuery, focusPath }) — show the picker anchored to `el`
 *   closePicker() — hide it
 *   pickerProps   — spread onto <VariablePicker {...pickerProps} ... />
 */
export default function useVariablePicker() {
    const [anchor, setAnchor] = useState(null);
    const [open, setOpen] = useState(false);
    // Seed for the picker's search box — set by inline autocomplete
    // (typing `{{su` opens the picker pre-filtered to "su"); the plain
    // {} button passes nothing, so the query resets to '' as before.
    const [initialQuery, setInitialQuery] = useState('');
    // The path a clicked pill stands for: the picker opens scoped to that
    // step ("the options I can pick in step 7").
    const [focusPath, setFocusPath] = useState('');

    const openPicker = useCallback((el, opts = {}) => {
        setAnchor(el || null);
        setInitialQuery(opts.initialQuery || '');
        setFocusPath(opts.focusPath || '');
        setOpen(true);
    }, []);

    const closePicker = useCallback(() => {
        setOpen(false);
        setInitialQuery('');
        setFocusPath('');
    }, []);

    return {
        open,
        openPicker,
        closePicker,
        pickerProps: { open, anchorEl: anchor, onClose: closePicker, initialQuery, focusPath },
    };
}
