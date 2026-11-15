import type { HTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// The console's bordered surface and its header row (icon, title, subtitle,
// an action on the right): the surface of the shared Section and SettingsList
// (bg-primary, default border, rounded-lg), so a console card reads as the
// same kind of box as the settings cards around it, with the header row the
// shared Section has no icon slot for.

interface CardProps extends HTMLAttributes<HTMLDivElement> {
    padded?: boolean;
    hover?: boolean;
}

export function Card({ children, className = '', padded = true, hover = false, ...rest }: CardProps) {
    return (
        <div
            className={`rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] ${padded ? 'p-4' : ''} ${hover ? 'transition hover:border-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)]' : ''} ${className}`}
            {...rest}
        >
            {children}
        </div>
    );
}

interface CardHeaderProps {
    icon?: LucideIcon;
    title?: ReactNode;
    subtitle?: ReactNode;
    action?: ReactNode;
    className?: string;
}

export function CardHeader({ icon: Icon, title, subtitle, action, className = '' }: CardHeaderProps) {
    return (
        <div className={`mb-3 flex items-start justify-between gap-4 ${className}`}>
            <div className="flex min-w-0 items-center gap-2.5">
                {Icon && <Icon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />}
                <div className="min-w-0">
                    {title && <h3 className="m-0 truncate text-sm font-semibold text-[var(--text-primary)]">{title}</h3>}
                    {subtitle && <p className="m-0 mt-0.5 text-xs text-[var(--text-tertiary)]">{subtitle}</p>}
                </div>
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}
