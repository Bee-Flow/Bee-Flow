export interface SubTabOption {
    id: string;
    label: string;
}

export interface SubTabsProps {
    value: string;
    onChange: (id: string) => void;
    options: SubTabOption[];
    /** One line about the active view, shown to the right of the pills. */
    description?: string;
    'aria-label': string;
}

export function SubTabs({ value, onChange, options, description, 'aria-label': ariaLabel }: SubTabsProps) {
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="group" aria-label={ariaLabel} className="inline-flex gap-1 rounded-xl bg-[var(--bg-tertiary)] p-1">
                {options.map(o => {
                    const active = o.id === value;
                    return (
                        <button
                            key={o.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => onChange(o.id)}
                            className={`cursor-pointer rounded-lg border-0 px-3 py-1.5 text-[13px] transition-colors ${active
                                ? 'bg-[var(--bg-card)] font-semibold text-[var(--text-primary)] shadow-sm'
                                : 'bg-transparent font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                        >
                            {o.label}
                        </button>
                    );
                })}
            </div>
            {description && <p className="m-0 min-w-0 flex-1 text-[13px] text-[var(--text-muted)]">{description}</p>}
        </div>
    );
}
