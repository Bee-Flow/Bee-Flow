import React from 'react';

/** One section card of the Settings tab: title, one line of help, the controls. */
export default function SettingsBlock({ id, title, description, children }: { id: string; title: string; description?: string; children: React.ReactNode }) {
    return (
        <section
            id={`settings-${id}`}
            className="scroll-mt-24 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 lg:p-5 space-y-3"
            data-testid={`block-${id}`}
        >
            <div>
                <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h3>
                {description && <p className="text-[13px] text-[var(--text-secondary)] mt-0.5">{description}</p>}
            </div>
            {children}
        </section>
    );
}
