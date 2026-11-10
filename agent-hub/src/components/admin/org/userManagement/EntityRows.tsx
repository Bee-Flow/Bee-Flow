// The list look of the user-management sections (organisations, groups, roles,
// permissions): one bordered surface with a row per entity (a small icon tile,
// name and description, chips under it, quiet actions on the right).

import type { ReactNode } from 'react';
import { CHIP, PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import SectionHeader from '@/components/shared/SectionHeader';

/** Title, description and the add action of a section. */
export function EntitySectionHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
    return <SectionHeader title={title} description={description} status={action} className="mb-4" />;
}

/** The section's add button. */
export function AddButton({ onClick, icon, children }: { onClick: () => void; icon: ReactNode; children: ReactNode }) {
    return <button type="button" onClick={onClick} className={PRIMARY_BTN}>{icon}{children}</button>;
}

export function EntityList({ children }: { children: ReactNode }) {
    return <ul className="m-0 list-none divide-y divide-[var(--border-default)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-0">{children}</ul>;
}

interface EntityRowProps {
    icon: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    /** Extra lines under the description. */
    details?: ReactNode;
    /** Chips under the text (permissions, ...). */
    chips?: readonly string[];
    /** Right of the text: a count chip, the row's actions. */
    actions?: ReactNode;
}

export function EntityRow({ icon, title, description, details, chips, actions }: EntityRowProps) {
    return (
        <li className="flex items-start gap-3 px-4 py-3">
            <div aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{icon}</div>
            <div className="min-w-0 flex-1">
                <h4 className="m-0 text-[13px] font-medium text-[var(--text-primary)]">{title}</h4>
                {description ? <p className="m-0 mt-0.5 text-xs text-[var(--text-tertiary)]">{description}</p> : null}
                {details}
                {chips && chips.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        {chips.map(c => <span key={c} className={CHIP}>{c}</span>)}
                    </div>
                ) : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </li>
    );
}

const ACTION = 'inline-flex items-center justify-center rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors [&>svg]:h-4 [&>svg]:w-4';
const ACTION_IDLE = 'hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]';
const ACTION_DANGER = 'hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] hover:text-[var(--error-ink)]';

/** The building glyph used for organisations. */
export function OrgIcon({ className = 'h-4 w-4' }: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
            <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" /><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" /><path d="M10 6h4" /><path d="M10 10h4" /><path d="M10 14h4" /><path d="M10 18h4" />
        </svg>
    );
}

/** An icon-only row action, named for screen readers and as a tooltip. */
export function RowAction({ label, onClick, danger = false, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
    return (
        <button type="button" onClick={onClick} aria-label={label} title={label} className={`${ACTION} ${danger ? ACTION_DANGER : ACTION_IDLE}`}>
            {children}
        </button>
    );
}
