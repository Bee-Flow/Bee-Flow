import { ROW_ACTIVE, ROW_IDLE } from '../../../components/shell/sidebar/sidebarTokens';
import { BarChart2, CreditCard, Link2, Shield, Sparkles } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';
import type { OrgSubItem as OrgSubItemData } from './settingsShellTypes';

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

export const ORG_PARENT_ITEM = {
    id: 'organisation', labelKey: 'settings.organisation',
    icon: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="15" height="15"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>,
};

/* ── Chevron icon ─────────────────────────────────────────────────────────── */
export const Chevron = ({ open }: { open: boolean }) => (
    <svg
        width="11" height="11" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true"
        className={`flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
    >
        <path d="M9 18l6-6-6-6" />
    </svg>
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

/* ── Org sub-menu item ───────────────────────────────────────────────────── */
interface OrgSubItemProps {
    section: OrgSubItemData;
    label: string;
    isActive: boolean;
    onClick: (id: string) => void;
    rightSlot?: ReactNode;
}

export const OrgSubItem = ({ section, label, isActive, onClick, rightSlot = null }: OrgSubItemProps) => {
    const Icon = section.icon;
    return (
        <button
            type="button"
            onClick={() => onClick(section.id)}
            className={`w-full flex items-center gap-2 h-7 pl-9 pr-3 rounded-md text-left transition-colors duration-100 ${isActive ? ROW_ACTIVE : ROW_IDLE}`}
            aria-current={isActive ? 'page' : undefined}
            title={label}
            data-testid={`settings-nav-${section.id}`}
        >
            {/* The row's own accent only while active; `section.color` is a
                per-row value (a hex or a var()), so it stays a style. */}
            <Icon className="w-3 h-3 flex-shrink-0" style={{ color: isActive ? section.color : 'var(--text-muted)' }} />
            <span className={`min-w-0 flex-1 text-[12px] truncate ${isActive ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] font-normal'}`}>
                {label}
            </span>
            {/* A count pill ('Settings Nav.dc.html': Compliance carries its open
                items). */}
            {rightSlot && <span className="flex items-center">{rightSlot}</span>}
        </button>
    );
};
