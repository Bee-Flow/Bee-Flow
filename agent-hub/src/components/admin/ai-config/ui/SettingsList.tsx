// The settings-list pattern of the AI configuration: one bordered surface with
// a row per setting (label and a one-line hint on the left, the control on the
// right), thin dividers between rows, and an inset area under a row for the
// settings that most people never touch.

import type { ReactNode } from 'react';

/** Class strings for the compact controls inside a row or an expanded area. */
export const FIELD_INPUT = 'w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-60';

/** The primary action of a group (Save ...). */
export const SAVE_BUTTON = 'inline-flex items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 py-1.5 text-[13px] font-medium text-[var(--accent-primary-fg)] transition-opacity hover:opacity-90 disabled:opacity-50';

/** A quiet bordered button for a row (Apply, Add ...). */
export const QUIET_BUTTON = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)] disabled:opacity-50';

interface SettingsGroupProps {
    title: ReactNode;
    description?: ReactNode;
    /** Right of the title: a button or a link. */
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}

/** A titled block of settings: header, then whatever the section puts below it (a SettingsList, a footer). */
export function SettingsGroup({ title, description, actions, children, className = '' }: SettingsGroupProps) {
    return (
        <section className={`flex max-w-4xl flex-col gap-3 ${className}`}>
            <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
                    {description ? <p className="m-0 mt-0.5 text-xs text-[var(--text-secondary)]">{description}</p> : null}
                </div>
                {actions ? <div className="shrink-0">{actions}</div> : null}
            </header>
            {children}
        </section>
    );
}

/** The one bordered surface the rows sit in. */
export function SettingsList({ children, className = '' }: { children: ReactNode; className?: string }) {
    return (
        <div className={`divide-y divide-[var(--border-default)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] ${className}`}>
            {children}
        </div>
    );
}

interface SettingRowProps {
    label: ReactNode;
    hint?: ReactNode;
    /** Small leading icon or glyph. */
    icon?: ReactNode;
    /** The control, right-aligned on wide screens, below the label on narrow ones. */
    children?: ReactNode;
    /** Inset area under the row (advanced fields). */
    expanded?: ReactNode;
    /** Make the label a form label for the control with this id. */
    htmlFor?: string;
    /** Replaces the icon, label and hint block (for a row whose label is itself editable). */
    lead?: ReactNode;
}

export function SettingRow({ label, hint, icon, children, expanded, htmlFor, lead }: SettingRowProps) {
    return (
        <div>
            <div className="flex flex-col gap-2 px-4 py-3 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center md:gap-4">
                {lead ? <div className="min-w-0">{lead}</div> : <div className="flex min-w-0 items-start gap-2.5">
                    {icon ? <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-secondary)]" aria-hidden="true">{icon}</span> : null}
                    <div className="min-w-0">
                        {htmlFor
                            ? <label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--text-primary)]">{label}</label>
                            : <h4 className="m-0 text-[13px] font-medium text-[var(--text-primary)]">{label}</h4>}
                        {hint ? <p className="m-0 mt-0.5 text-xs text-[var(--text-tertiary)]">{hint}</p> : null}
                    </div>
                </div>}
                {children ? <div className="min-w-0">{children}</div> : null}
            </div>
            {expanded ? <div className="bg-[var(--bg-secondary)] px-4 py-3">{expanded}</div> : null}
        </div>
    );
}

/** Two or three columns of compact fields for the expanded area of a row. */
export function FieldGrid({ children }: { children: ReactNode }) {
    return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

interface FieldProps {
    label: ReactNode;
    hint?: ReactNode;
    htmlFor?: string;
    children: ReactNode;
}

/** A compact label-over-control field with a small hint. */
export function Field({ label, hint, htmlFor, children }: FieldProps) {
    return (
        <div className="min-w-0">
            <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-[var(--text-primary)]">{label}</label>
            {children}
            {hint ? <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">{hint}</p> : null}
        </div>
    );
}

/** A slim inline hint with an optional action button, no box. */
export function InlineHint({ children, action }: { children: ReactNode; action?: ReactNode }) {
    return (
        <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
            <p className="m-0 min-w-0 flex-1">{children}</p>
            {action}
        </div>
    );
}

interface SettingBlockProps {
    label: ReactNode;
    hint?: ReactNode;
    htmlFor?: string;
    children: ReactNode;
}

/** A setting whose control needs the full width (a text area, a row of option cards). */
export function SettingBlock({ label, hint, htmlFor, children }: SettingBlockProps) {
    return (
        <div className="flex flex-col gap-2 px-4 py-3">
            <div>
                {htmlFor
                    ? <label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--text-primary)]">{label}</label>
                    : <h4 className="m-0 text-[13px] font-medium text-[var(--text-primary)]">{label}</h4>}
                {hint ? <p className="m-0 mt-0.5 text-xs text-[var(--text-tertiary)]">{hint}</p> : null}
            </div>
            {children}
        </div>
    );
}

/** One choice out of several, as a card: the radio-card look of a provider or method picker. */
export function OptionCard({ selected, onClick, title, description }: { selected: boolean; onClick: () => void; title: ReactNode; description?: ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={selected}
            className={`rounded-md border p-3 text-left transition-colors ${selected
                ? 'border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)]'
                : 'border-[var(--border-default)] bg-[var(--bg-primary)] hover:bg-[var(--bg-secondary)]'}`}
        >
            <span className={`flex items-center gap-2 text-[13px] font-medium ${selected ? 'text-[var(--success-ink)]' : 'text-[var(--text-primary)]'}`}>
                <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-2 ${selected ? 'border-[var(--success)] bg-[var(--success)]' : 'border-[var(--border-default)]'}`}>
                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
                {title}
            </span>
            {description ? <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-tertiary)]">{description}</span> : null}
        </button>
    );
}
