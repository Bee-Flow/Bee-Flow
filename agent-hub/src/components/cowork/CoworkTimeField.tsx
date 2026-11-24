/**
 * A time of day as Cowork writes it everywhere else: "09:00" on the 24-hour clock, typed as text. The browser's own
 * time field follows the reader's locale and shows "09:00 AM" next to a page that says "Every Monday 09:00".
 *
 * Forgiving while typing ("9", "930", "9:30" and "9.30" all read as a time); what it hands on is always HH:MM. A text
 * that is no time is put back to the last good one when the field is left.
 */
import { useState } from 'react';
import { FIELD } from './coworkUi';

const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** What was typed as HH:MM, or null when it is no time of day. Plain string operations: this is text a person typed. */
export function parseTime(text: string): string | null {
    const clean = [...text.trim()].map((c) => (c === '.' ? ':' : c)).filter((c) => isDigit(c) || c === ':').join('');
    const at = clean.indexOf(':');
    // "930" is 9:30, "9" and "09" are the hour.
    const cut = at === -1 ? Math.max(clean.length - 2, 0) : at;
    const hours = at === -1 && clean.length <= 2 ? clean : clean.slice(0, cut);
    const minutes = at === -1 ? (clean.length <= 2 ? '' : clean.slice(cut)) : clean.slice(at + 1);
    if (hours === '' || hours.length > 2 || minutes.length > 2 || minutes.includes(':')) return null;
    const hh = Number(hours);
    const mm = minutes === '' ? 0 : Number(minutes);
    if (hh > 23 || mm > 59) return null;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

interface CoworkTimeFieldProps {
    id: string;
    /** HH:MM. */
    value: string;
    onChange: (time: string) => void;
}

export default function CoworkTimeField({ id, value, onChange }: CoworkTimeFieldProps) {
    // What is being typed; null while the field shows the value it was given.
    const [typed, setTyped] = useState<string | null>(null);
    const type = (text: string) => {
        setTyped(text);
        // Every text that reads as a time is handed on at once, so a save by Enter never sends the time before it.
        const time = parseTime(text);
        if (time && time !== value) onChange(time);
    };
    return (
        <input
            id={id} type="text" inputMode="numeric" autoComplete="off" maxLength={5} placeholder="09:00"
            className={`${FIELD} w-[5.5rem] tabular-nums`}
            value={typed ?? value} onChange={(e) => type(e.target.value)} onBlur={() => setTyped(null)}
        />
    );
}
