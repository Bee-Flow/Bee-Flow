import React, { useState, useRef, useEffect } from 'react';

// Memoized instructions textarea. The parent's `instructions` state lives in
// BuilderSplit (~127 hooks), so updating it on every keystroke causes the
// entire editor to rerender. This child holds its own local string and only
// commits to the parent on a 250ms debounce + on blur — keystrokes stay
// scoped to this component, BuilderSplit only sees settled values.
const InstructionsEditor = React.memo(React.forwardRef(function InstructionsEditor(
    { initialValue, placeholder, onCommit, onBlurEnd },
    forwardedRef,
) {
    const [value, setValue] = useState(initialValue || '');
    const onCommitRef = useRef(onCommit);
    useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);

    // Keep the local buffer aligned if the parent rewrites instructions
    // (e.g., wizard refine response or version restore). Don't blow away
    // in-flight keystrokes — only sync when the prop genuinely differs from
    // the last committed value.
    const lastInitialRef = useRef(initialValue);
    useEffect(() => {
        if (initialValue !== lastInitialRef.current) {
            lastInitialRef.current = initialValue;
            setValue(initialValue || '');
        }
    }, [initialValue]);

    // Single source of debouncing lives in the parent (queueSave 350 ms). A
    // second debounce here just produced out-of-order saves on rapid typing —
    // the parent's stale-buffer commit would race the editor's later one.
    // Forward every keystroke immediately; the parent coalesces.
    const handleChange = (e) => {
        const next = e.target.value;
        setValue(next);
        lastInitialRef.current = next;
        onCommitRef.current?.(next);
    };

    const handleBlur = () => {
        onBlurEnd?.();
    };

    return (
        <textarea
            ref={forwardedRef}
            value={value}
            onChange={handleChange}
            onBlur={handleBlur}
            rows={Math.max(12, (value.match(/\n/g) || []).length + 2)}
            placeholder={placeholder}
            className="w-full bg-[var(--bg-secondary)]/50 border border-transparent focus:border-[var(--border-default)] rounded-xl px-4 py-3 text-[15px] leading-7 text-[var(--text-primary)] outline-none resize-y"
        />
    );
}));

export default InstructionsEditor;
