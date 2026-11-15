import { isValidElement } from 'react';
import type { ComponentType, ReactNode } from 'react';

type IconComponent = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

interface SectionHeaderProps {
    title: ReactNode;
    description?: ReactNode;
    /** What to say about the last save, or the section's actions, on the right. */
    status?: ReactNode;
    /** Leading icon: a component (a lucide icon, the rail row's icon) or a ready element. Decorative. */
    icon?: IconComponent | ReactNode;
    className?: string;
}

function isIconComponent(icon: unknown): icon is IconComponent {
    // A lucide icon is a forwardRef OBJECT, a plain one a function; an element
    // (`<Shield />`) is also an object, so tell them apart by isValidElement.
    return typeof icon === 'function' || (typeof icon === 'object' && icon !== null && !isValidElement(icon) && '$$typeof' in icon);
}

function HeaderIcon({ icon }: { icon: IconComponent | ReactNode }) {
    const Icon = isIconComponent(icon) ? icon : null;
    return (
        <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-secondary)]">
            {Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : (icon as ReactNode)}
        </span>
    );
}

/** Title and one-line description at the top of a settings section (AI configuration, server licence, ...). */
export default function SectionHeader({ title, description, status, icon, className = '' }: SectionHeaderProps) {
    return (
        <header className={`flex flex-wrap items-start justify-between gap-3 ${className}`}>
            <div className="flex min-w-[12rem] flex-1 items-start gap-2.5">
                {icon != null && icon !== false ? <HeaderIcon icon={icon} /> : null}
                <div className="min-w-0 flex-1">
                    <h2 className="m-0 text-base font-semibold text-[var(--text-primary)]">{title}</h2>
                    {description ? <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">{description}</p> : null}
                </div>
            </div>
            {status ? <div className="max-w-full">{status}</div> : null}
        </header>
    );
}
