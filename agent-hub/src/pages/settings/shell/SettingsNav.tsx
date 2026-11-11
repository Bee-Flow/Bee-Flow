import { ROW_ACTIVE, ROW_IDLE } from '@/components/shell/sidebar/sidebarTokens';
import { BarChart2, CreditCard, Link2, Shield, Sparkles } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';

/** One top-level row of the settings nav (settingsNavItems.jsx hands these over). */
export interface NavRow {
    id: string;
    labelKey: string;
    icon: ReactNode;
}

/* The consumer (org-less cloud) account rows. Ids are settingsRoutes.js's
 * SETTINGS_ACCOUNT_ID_TO_URL keys. */
export const CONSUMER_NAV_ITEMS: NavRow[] = [
    { id: 'consumer_license', labelKey: 'settings.license_usage', icon: <CreditCard className="w-[15px] h-[15px]" /> },
    { id: 'consumer_privacy', labelKey: 'settings.privacy_shield', icon: <Shield className="w-[15px] h-[15px]" /> },
    { id: 'consumer_usage', labelKey: 'settings.usage_monitoring', icon: <BarChart2 className="w-[15px] h-[15px]" /> },
    { id: 'consumer_integrations', labelKey: 'settings.integrations', icon: <Link2 className="w-[15px] h-[15px]" /> },
    { id: 'consumer_beta', labelKey: 'settings.beta_features', icon: <Sparkles className="w-[15px] h-[15px]" /> },
];

/* A thin rule between groups of rows. */
export const NavDivider = ({ inset = false }: { inset?: boolean }) => (
    <div aria-hidden="true" className={`h-px bg-[var(--border-subtle)] ${inset ? 'mt-1 mb-1 ml-9 mr-3' : 'my-1.5 mx-2'}`} />
);

/* ── NavItem ─────────────────────────────────────────────────────────────── */
/* Row states come from the app sidebar's tokens (sidebarTokens.js): a tint of
 * the theme's own accent and text colour, so the active and hover rows stay
 * visible on the dark themes, where a black rgba tint did not. `title` shows
 * the whole label when the narrow sidebar truncates it. */
interface NavItemProps {
    id: string;
    label: string;
    icon: ReactNode;
    isActive: boolean;
    onClick: (id: string) => void;
    rightSlot?: ReactNode;
    ariaExpanded?: boolean;
    ariaControls?: string;
}

export const NavItem = ({ id, label, icon, isActive, onClick, rightSlot, ariaExpanded, ariaControls }: NavItemProps) => (
    <button
        type="button"
        onClick={() => onClick(id)}
        className={`w-full flex items-center gap-2.5 h-8 px-3 rounded-md text-left transition-colors duration-100 ${isActive ? ROW_ACTIVE : ROW_IDLE}`}
        aria-current={isActive ? 'page' : undefined}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        title={label}
        data-testid={`settings-nav-${id}`}
    >
        <span className={`flex flex-shrink-0 ${isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{icon}</span>
        <span className={`min-w-0 flex-1 text-[13px] truncate text-[var(--text-primary)] ${isActive ? 'font-semibold' : 'font-normal'}`}>
            {label}
        </span>
        {rightSlot}
    </button>
);
