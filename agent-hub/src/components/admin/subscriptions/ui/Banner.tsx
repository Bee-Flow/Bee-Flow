import type { ReactNode } from 'react';
import { Info, AlertTriangle, CheckCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ALERT_ERROR, ALERT_INFO, ALERT_SUCCESS, ALERT_WARNING } from '@/components/mcpLibrary/ui';

// A notice with an optional bold title over its text: the ALERT_* recipes with
// a title slot, which the recipes alone do not have. `teal` reads as info.
const TONES = {
    info:    { wrap: ALERT_INFO, icon: Info },
    success: { wrap: ALERT_SUCCESS, icon: CheckCircle },
    warning: { wrap: ALERT_WARNING, icon: AlertTriangle },
    danger:  { wrap: ALERT_ERROR, icon: AlertTriangle },
    teal:    { wrap: ALERT_INFO, icon: Info },
};

interface BannerProps {
    tone?: keyof typeof TONES;
    icon?: LucideIcon;
    title?: ReactNode;
    children?: ReactNode;
    className?: string;
}

export function Banner({ tone = 'info', icon: IconOverride, title, children, className = '' }: BannerProps) {
    const t = TONES[tone] || TONES.info;
    const Icon = IconOverride || t.icon;
    return (
        <div className={`${t.wrap} ${className}`}>
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
                {title && <div className="mb-0.5 font-semibold">{title}</div>}
                {children}
            </div>
        </div>
    );
}
