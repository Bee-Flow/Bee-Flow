import { useState, type InputHTMLAttributes } from 'react';

interface TypedNumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'onBlur'> {
    /** The stored number. */
    value: number;
    /** What a typed 0 stores (the field's default), as it always did. */
    fallback: number;
    /** A number was typed. */
    onNumber: (n: number) => void;
}

/**
 * A number field that can be emptied and retyped.
 *
 * `onChange={e => save(Number(e.target.value) || fallback)}` on a controlled
 * field stores the fallback the moment the box is empty, and the box snaps
 * back to it: "25" could only be reached by typing over a selection. Here the
 * typed text wins while the field is being edited; an empty or nonsense text
 * stores nothing, and leaving the field shows the stored value again. No
 * clamping of its own: the field stores what it stored before.
 * (Sibling of actionEditors/KeepDaysInput, which also clamps and rounds.)
 */
export default function TypedNumberInput({ value, fallback, onNumber, ...rest }: TypedNumberInputProps) {
    const [typed, setTyped] = useState<string | null>(null);
    return (
        <input
            {...rest}
            type="number"
            value={typed ?? value}
            onChange={(e) => {
                const raw = e.target.value;
                setTyped(raw);
                const n = Number(raw);
                if (raw.trim() !== '' && Number.isFinite(n)) onNumber(n || fallback);
            }}
            onBlur={() => setTyped(null)}
        />
    );
}
