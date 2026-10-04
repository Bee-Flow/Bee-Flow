import { useViewport } from '../../../../hooks/useViewport';
// Small building blocks the content tabs share, in the Studio look: the
// toolbar above a list, the two button recipes, the "could not load" strip and
// the loading fallback. Kept here so the four tabs cannot drift apart.

import { AlertTriangle, Search, X } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { StudioSectionHeader } from '../studioParts';

interface ButtonProps {
    icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    testId?: string;
}

/** The theme's filled button (accent background, accent foreground). */
export function PrimaryButton({ icon: Icon, children, onClick, disabled = false, testId }: ButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            data-testid={testId}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
            {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {children}
        </button>
    );
}

/** The outlined secondary button. */
export function SecondaryButton({ icon: Icon, children, onClick, disabled = false, testId }: ButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            data-testid={testId}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
            {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {children}
        </button>
    );
}

/** A small icon-only "take it out" button; the label is the accessible name. */
export function RemoveButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={disabled}
            className="grid place-items-center w-7 h-7 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 transition-colors"
        >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
    );
}

interface ToolbarProps {
    title: string;
    count?: number | null;
    search?: string;
    onSearch?: (value: string) => void;
    searchLabel?: string;
    actions?: React.ReactNode;
}

/** Title with its count, an optional search box, and the tab's actions. */
export function ContentToolbar({ title, count = null, search, onSearch, searchLabel, actions }: ToolbarProps) {
    const { isDesktop } = useViewport();
    return (
        <div>
            <StudioSectionHeader title={title}
                statusChip={count === null ? undefined : <span data-testid="content-count">{count}</span>}
                primary={isDesktop ? <div className="flex gap-2">{actions}</div> : undefined} />
            {(onSearch || (!isDesktop && actions)) && <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[var(--border-subtle)]">
                {onSearch && <label className="relative block flex-1 min-w-40 max-w-sm">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <input type="search" value={search || ''} onChange={e => onSearch(e.target.value)} aria-label={searchLabel} placeholder={searchLabel}
                        className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)]" />
                </label>}
                {!isDesktop && <div className="flex flex-wrap gap-2">{actions}</div>}
            </div>}
        </div>
    );
}

/** "Could not load" — deliberately not the empty state, with a way to retry. */
export function SectionError({ message, onRetry }: { message: string; onRetry?: () => void }) {
    const { t } = useTranslation();
    return (
        <div role="alert" className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span className="flex-1">{message}</span>
            {onRetry && (
                <button type="button" onClick={onRetry} className="text-xs font-medium text-[var(--accent-primary)] hover:underline">
                    {t('project_content.retry', 'Try again')}
                </button>
            )}
        </div>
    );
}

/** A quiet sentence for members who can read but not change the content. */
export function ReadOnlyNote({ children }: { children: React.ReactNode }) {
    return <p className="text-[12px] text-[var(--text-tertiary)]">{children}</p>;
}

/** The Suspense fallback of an item opened inside a tab. */
export function PaneLoading({ label }: { label: string }) {
    return (
        <div className="flex h-full items-center justify-center py-12" role="status" aria-label={label}>
            <span className="w-6 h-6 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin" aria-hidden="true" />
        </div>
    );
}

/** One titled panel of a tab that shows several things (the knowledge tab). */
export function SectionCard({ title, description, actions, children, testId }: {
    title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode; testId?: string;
}) {
    return (
        <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3.5" aria-label={title} data-testid={testId}>
            <div className="flex flex-wrap items-start gap-2 mb-3">
                <div className="flex-1 min-w-0">
                    <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
                    {description && <p className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">{description}</p>}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
            {children}
        </section>
    );
}

/** The scrolling column every list view sits in. */
export function ContentColumn({ children, testId }: { children: React.ReactNode; testId?: string }) {
    const [header, ...body] = React.Children.toArray(children);
    return (
        <div className="h-full flex flex-col min-h-0" data-testid={testId}>
            {header}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 space-y-4">{body}</div>
            </div>
        </div>
    );
}
