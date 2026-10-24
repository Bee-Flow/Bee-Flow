import { ArrowLeft, Eye, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { formatRelativeTime } from '../../../utils/dateFormatters';
import { PRIMARY_SLOTS, SLOT_LANGUAGE } from '../webpageCodeFiles';
import WebpageEditor from '../WebpageEditor';
import type { PrimaryFile } from '../../../api/webpageEditorTypes';
import type { VersionRow as Version, ViewedVersion } from './useVersionHistory';

/**
 * Where a snapshot came from. The same four values as the `source` column
 * (stores/webpage/versions.VERSION_SOURCES) — inventing a fifth label would
 * be a second vocabulary.
 *
 * 'restore' is deliberately "Restore point" and not "Restore": next to a
 * button with that word, a chip "Restore" would read as something to press.
 */
const SOURCE_LABELS: Record<string, [string, string]> = {
    manual: ['webpages.versions.source_manual', 'Manual'],
    ai: ['webpages.versions.source_ai', 'AI'],
    published: ['webpages.versions.source_published', 'Publish'],
    restore: ['webpages.versions.source_restore', 'Restore point'],
};

/** `+12`, `−7`, `±0` — or nothing, when it was not measured. */
export function formatLineDelta(lineDelta: unknown): string | null {
    if (typeof lineDelta !== 'number' || !Number.isFinite(lineDelta)) return null;
    if (lineDelta === 0) return '±0';
    return lineDelta > 0 ? `+${lineDelta}` : `−${Math.abs(lineDelta)}`;
}

export function Chip({ children, tone = 'neutral', testId }: { children: ReactNode; tone?: 'neutral' | 'accent'; testId?: string }) {
    const accent = tone === 'accent';
    return (
        <span
            data-testid={testId}
            className="inline-flex items-center px-1.5 py-[1px] rounded text-[10px] font-medium shrink-0"
            style={accent
                ? { background: 'var(--accent-primary)', color: 'white' }
                : { background: 'var(--bg-secondary)', color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)' }}
        >
            {children}
        </span>
    );
}

/** Who made the version. The order is the rule: "is it you" first, then the name. */
function ActorLabel({ actor }: { actor: Version['actor'] }) {
    const { t } = useTranslation();
    // An account without a display name is still you.
    if (actor?.isYou) return <>{t('webpages.versions.actor_you', 'You')}</>;
    if (actor?.name) return <>{actor.name}</>;
    return <>{t('webpages.versions.actor_unknown', 'Unknown')}</>;
}

/** One row of the history list. */
export function VersionListRow({ v, onView, onRestore }: { v: Version; onView: () => void; onRestore?: () => void }) {
    const { t } = useTranslation();
    // A source this list does not know shows its OWN value, never another's
    // label. Falling back to "Manual" silently is not a missing label but a
    // FALSE one — on the very screen whose header says unknown is never a claim.
    const known = v.source ? SOURCE_LABELS[v.source] : undefined;
    const sourceLabel = known ? t(known[0], known[1]) : (v.source || '');
    const delta = formatLineDelta(v.lineDelta);
    return (
        <div data-testid="version-row" className="flex items-center gap-3 p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]">
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                    {/* No "v0" for a row without a number: then there is nothing. */}
                    {v.seq ? (
                        <span data-testid="version-seq" className="text-[11px] font-mono shrink-0 text-[var(--text-tertiary)]">
                            {`v${v.seq}`}
                        </span>
                    ) : null}
                    <span className="text-[12px] font-medium truncate text-[var(--text-primary)]">
                        {v.summary || t('webpages.versions.untitled', 'Snapshot')}
                    </span>
                    {sourceLabel ? <Chip testId="version-source">{sourceLabel}</Chip> : null}
                    {v.isPublished && (
                        <Chip tone="accent" testId="version-live">{t('webpages.versions.is_published', 'Published')}</Chip>
                    )}
                </div>
                <div className="text-[10px] flex items-center gap-1.5 flex-wrap text-[var(--text-tertiary)]">
                    <span data-testid="version-actor"><ActorLabel actor={v.actor} /></span>
                    <span aria-hidden="true">·</span>
                    <span>{formatRelativeTime(v.createdAt)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{`${((v.contentLength || 0) / 1024).toFixed(1)}KB`}</span>
                    {delta && (
                        <>
                            <span aria-hidden="true">·</span>
                            <span data-testid="version-line-delta" title={t('webpages.versions.line_delta_title', 'Net line change in this edit')}>
                                {delta}
                            </span>
                        </>
                    )}
                </div>
            </div>
            <button
                onClick={onView}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border border-[var(--border-subtle)] text-[var(--text-secondary)]"
            >
                <Eye className="w-3 h-3" aria-hidden="true" />
                {t('webpages.versions.view', 'View')}
            </button>
            {onRestore && (
                <button
                    onClick={onRestore}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium [background:var(--accent-primary)] [color:white]!"
                >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                    {t('webpages.versions.restore', 'Restore')}
                </button>
            )}
        </div>
    );
}

interface VersionViewerProps {
    viewing: ViewedVersion;
    viewSlot: PrimaryFile;
    onSlot: (slot: PrimaryFile) => void;
    viewError: string | null | undefined;
    onBack: () => void;
}

/** The read-only view of one version: its three primary files in a read-only editor. */
export function VersionViewer({ viewing, viewSlot, onSlot, viewError, onBack }: VersionViewerProps) {
    const { t } = useTranslation();
    const files = viewing.files;
    return (
        <div className="h-full flex flex-col bg-[var(--bg-primary)]" data-testid="webpage-version-view">
            <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--border-subtle)]">
                <button onClick={onBack} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded text-[var(--text-secondary)]">
                    <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('webpages.versions.back_to_list', 'Back to history')}
                </button>
                <span className="text-[12px] font-medium truncate text-[var(--text-primary)]">
                    {viewing.seq ? `v${viewing.seq} · ` : ''}{viewing.summary || t('webpages.versions.untitled', 'Snapshot')}
                </span>
                <Chip testId="version-view-readonly">{t('webpages.versions.read_only', 'Read-only')}</Chip>
                <div className="ml-auto flex items-center gap-1">
                    {PRIMARY_SLOTS.map(({ slot, name }) => (
                        <button
                            key={slot}
                            onClick={() => onSlot(slot as PrimaryFile)}
                            aria-pressed={viewSlot === slot}
                            className="px-2 py-1 rounded text-[11px]"
                            style={viewSlot === slot
                                ? { background: 'var(--bg-secondary)', color: 'var(--text-primary)' }
                                : { color: 'var(--text-tertiary)' }}
                        >
                            {name}
                        </button>
                    ))}
                </div>
            </div>
            <div className="flex-1 min-h-0">
                {viewError ? (
                    <p className="p-4 text-xs text-[var(--text-secondary)]" role="alert">{viewError}</p>
                ) : !files ? (
                    <p className="p-4 text-xs text-[var(--text-tertiary)]">{t('webpages.versions.loading', 'Loading…')}</p>
                ) : (
                    <WebpageEditor value={files[viewSlot] || ''} language={SLOT_LANGUAGE[viewSlot] || 'plaintext'} readOnly />
                )}
            </div>
        </div>
    );
}
