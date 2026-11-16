import React from 'react';
import { LANGUAGES } from '@/config/meetingNotesConfig';
import SharedToggle from '@/components/shared/Toggle';

/**
 * Small presentational atoms shared by the org-level (admin) and personal
 * (settings) Meeting Notes panels (Nextcloud Talk, Google Meet, Teams), which
 * re-declared them byte-for-byte. Keep purely presentational — the panels own
 * their own data.
 *
 * Colours come from the theme: the switch is the shared one (shared/Toggle), so
 * it looks like every other switch in the product. NC_BLUE is the Nextcloud
 * brand colour, kept for the Talk header icon only.
 */

export const NC_BLUE = '#0082C9';

export interface LangOption { code: string; label: string }

/**
 * The meeting-notes transcription languages, the same list the recorder and
 * the mobile app offer (config/meetingNotesConfig LANGUAGES), without the flag.
 */
export const LANGS: readonly LangOption[] = LANGUAGES.map(l => ({ code: l.code, label: l.label.slice(l.label.indexOf(' ') + 1) }));

/**
 * The options of a language select for a stored value. The server accepts more
 * than LANGS ('auto', a region code, any code the API was sent), and a
 * controlled select whose value matches no option shows the FIRST option
 * ('Dutch'). A code the list does not know is therefore kept and shown as
 * itself, like mobile's NotesLanguageGroup.
 */
export function languageOptions(current?: string | null): readonly LangOption[] {
    if (!current || LANGS.some(l => l.code === current)) return LANGS;
    return [{ code: current, label: current }, ...LANGS];
}

/**
 * On/off switch: an adapter over the shared Toggle (role="switch",
 * aria-checked) that keeps this file's `{ on, onClick }` API for the meeting
 * panels. Pass the row title as `ariaLabel`: the switch has no visible text of
 * its own.
 */
export const Toggle = ({ on, onClick, disabled, ariaLabel }: { on?: boolean; onClick?: () => void; disabled?: boolean; ariaLabel?: string }) => (
    <SharedToggle
        checked={!!on}
        onChange={() => onClick?.()}
        disabled={disabled}
        ariaLabel={ariaLabel}
        className="flex-shrink-0"
    />
);

/** A settings row: title and description, the control beside them (below them on a phone). */
export const Row = ({ title, desc, children }: { title?: React.ReactNode; desc?: React.ReactNode; children?: React.ReactNode }) => (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3.5 bg-[var(--bg-secondary)]">
        <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">{title}</p>
            <p className="text-[11px] text-[var(--text-muted)]">{desc}</p>
        </div>
        {children}
    </div>
);

/**
 * A compact select. It grows to its longest option ("Each member decides" must
 * not be cut off) and never past its row.
 */
export const Select = ({ value, onChange, disabled, options, ariaLabel }: {
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLSelectElement>;
    disabled?: boolean;
    options: Array<{ value: string; label: string }>;
    ariaLabel?: string;
}) => (
    <select
        value={value} onChange={onChange} disabled={disabled} aria-label={ariaLabel}
        className="w-auto min-w-[12rem] max-w-full px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
    >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
);
