import type { ReactNode } from 'react';

interface SectionHeaderProps {
    title: ReactNode;
    description?: ReactNode;
    /** What to say about the last save, or the section's actions, on the right. */
    status?: ReactNode;
    className?: string;
}

/** Title and one-line description at the top of a settings section (AI configuration, server licence, ...). */
export default function SectionHeader({ title, description, status, className = '' }: SectionHeaderProps) {
    return (
        <header className={`flex items-start justify-between gap-3 ${className}`}>
            <div className="min-w-0">
                <h2 className="m-0 text-base font-semibold text-[var(--text-primary)]">{title}</h2>
                {description ? <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">{description}</p> : null}
            </div>
            {status ? <div className="shrink-0">{status}</div> : null}
        </header>
    );
}
