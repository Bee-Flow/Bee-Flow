// The compare's one-row toolbar: side by side / inline, only changes, previous
// and next change, the change summary, and — when the compare is between two
// versions of one document — which earlier version to compare with.
// Same look as the PDF compare's toolbar (../pdfCompare/Toolbar).

import { ChevronDown, ChevronUp, Columns2, Rows3, ListFilter } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AppDocumentVersion } from '@/api/queries/studioAppDocuments';
import useTranslation from '@/hooks/useTranslation';

export type CompareMode = 'side' | 'inline';

const BTN = 'inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded px-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-[var(--bg-tertiary)] aria-pressed:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--app-accent,#2563eb)]';
const ICON = 'h-4 w-4';

function ToolButton({ label, onClick, pressed, disabled, children }: { label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; children: ReactNode }) {
    return <button type="button" className={BTN} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</button>;
}
const Sep = () => <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border-default)]" aria-hidden="true" />;

export interface VersionChoice {
    versions: AppDocumentVersion[];
    selected: string | null;
    onSelect: (versionId: string) => void;
}

export interface CompareToolbarProps {
    mode: CompareMode;
    onMode: (m: CompareMode) => void;
    onlyChanges: boolean;
    onOnlyChanges: (v: boolean) => void;
    onStep: ((dir: 1 | -1) => void) | null;
    summary: string;
    changed: boolean;
    versions: VersionChoice | null;
}

/** "Sent to the board" for a named version, else when it was saved. */
function versionLabel(v: AppDocumentVersion, locale?: string): string {
    if (v.label) return v.label;
    const when = v.createdAt ? new Date(v.createdAt) : null;
    return when && !Number.isNaN(when.getTime()) ? when.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : v.versionId.slice(0, 8);
}

export default function CompareToolbar(p: CompareToolbarProps) {
    const { t } = useTranslation();
    return (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--border-default)] px-1.5 py-1" role="toolbar" aria-label={t('studio_app_documents.toolbar', 'Document comparison')}>
            <ToolButton label={t('studio_app_documents.mode_side', 'Side by side')} pressed={p.mode === 'side'} onClick={() => p.onMode('side')}><Columns2 className={ICON} aria-hidden="true" /></ToolButton>
            <ToolButton label={t('studio_app_documents.mode_inline', 'Inline')} pressed={p.mode === 'inline'} onClick={() => p.onMode('inline')}><Rows3 className={ICON} aria-hidden="true" /></ToolButton>
            <Sep />
            <ToolButton label={t('studio_app_documents.only_changes', 'Only changes')} pressed={p.onlyChanges} onClick={() => p.onOnlyChanges(!p.onlyChanges)}><ListFilter className={ICON} aria-hidden="true" /></ToolButton>
            <ToolButton label={t('studio_app_documents.prev_change', 'Previous change')} disabled={!p.onStep || !p.changed} onClick={() => p.onStep?.(-1)}><ChevronUp className={ICON} aria-hidden="true" /></ToolButton>
            <ToolButton label={t('studio_app_documents.next_change', 'Next change')} disabled={!p.onStep || !p.changed} onClick={() => p.onStep?.(1)}><ChevronDown className={ICON} aria-hidden="true" /></ToolButton>
            <span className={`min-w-0 truncate px-1 text-xs ${p.changed ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`} aria-live="polite" data-compare-summary="true">{p.summary}</span>
            {p.versions ? (
                <label className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-[var(--text-secondary)]">
                    {t('studio_app_documents.compare_with', 'Compare with')}
                    <select
                        className="h-7 max-w-[14rem] rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1 text-xs text-[var(--text-primary)]"
                        value={p.versions.selected || ''}
                        onChange={(e) => p.versions?.onSelect(e.target.value)}
                    >
                        {p.versions.versions.filter((v) => !v.current).map((v) => <option key={v.versionId} value={v.versionId}>{versionLabel(v)}</option>)}
                    </select>
                </label>
            ) : null}
        </div>
    );
}
