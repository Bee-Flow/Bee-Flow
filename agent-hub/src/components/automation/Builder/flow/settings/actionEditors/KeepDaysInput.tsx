import { useState } from 'react';

interface KeepDaysInputProps {
    /** The stored number of days. */
    days: number;
    /** A valid number was typed: it arrives rounded and inside [min, max]. */
    onDays: (days: number) => void;
    min?: number;
    max?: number;
    className?: string;
}

/**
 * "Keep for N days" — a number field that can be emptied and retyped.
 *
 * While the field is being edited the typed text wins. Clamping the stored
 * value on every keystroke made it unusable: emptying it gives
 * `Number('') === 0`, the clamp turned that into the minimum, and the field
 * snapped back to 1 — so "3" could only be reached by typing over a
 * selection. Same cure as the Wait step's duration (BFSF-345): an empty or
 * nonsense text stores nothing, and leaving the field shows the stored value
 * again.
 */
export default function KeepDaysInput({ days, onDays, min = 1, max = 90, className }: KeepDaysInputProps) {
    const [typed, setTyped] = useState<string | null>(null);
    return (
        <input
            type="number"
            min={min}
            max={max}
            value={typed ?? days}
            onChange={(e) => {
                const raw = e.target.value;
                setTyped(raw);
                const n = Number(raw);
                if (raw.trim() !== '' && Number.isFinite(n)) onDays(Math.min(max, Math.max(min, Math.round(n))));
            }}
            onBlur={() => setTyped(null)}
            className={className}
        />
    );
}
