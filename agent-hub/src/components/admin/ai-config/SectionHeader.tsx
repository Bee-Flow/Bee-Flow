import type { ReactNode } from 'react';

interface SectionHeaderProps {
    title: ReactNode;
    description?: ReactNode;
    /** What to say about the last save, on the right. */
    status?: ReactNode;
}

/** Title and one-line description at the top of an AI-configuration section, in the look of PaneHeader. */
export default function SectionHeader({ title, description, status }: SectionHeaderProps) {
    return (
        <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <h2 className="m-0 text-base font-semibold text-[var(--text-primary)]">{title}</h2>
                {description ? <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">{description}</p> : null}
            </div>
            {status}
        </header>
    );
}
