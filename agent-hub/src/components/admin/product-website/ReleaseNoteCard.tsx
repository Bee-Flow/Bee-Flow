// One entry of the release-notes review queue: version and status chips, the
// publish / unpublish / discard actions, the editable headline and lead, and
// the drafted items grouped by kind. ReleaseNotesPanel owns the data.

import { Check, Eye, EyeOff, Trash2 } from 'lucide-react';
import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { CARD, CHIP, CHIP_SUCCESS, CHIP_WARNING, INPUT, PRIMARY_BTN, QUIET_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';

interface ReleaseNoteItem {
    kind?: string;
    title?: string;
    body?: string;
}

/** One entry of GET /api/release-notes/admin. */
export interface ReleaseNoteEntry {
    id: string;
    version?: string | null;
    status?: string;
    services?: string | null;
    title?: string;
    lead?: string;
    items?: Array<ReleaseNoteItem | null>;
    publishedAt?: string | null;
}

const KIND_LABELS: Record<string, { key: string; en: string }> = {
    feature: { key: 'cms_site.blocks.release_notes.new', en: 'New' },
    improvement: { key: 'cms_site.blocks.release_notes.improved', en: 'Improved' },
    fix: { key: 'cms_site.blocks.release_notes.fixed', en: 'Fixed' },
};
const KIND_ORDER = ['feature', 'improvement', 'fix'];

interface ReleaseNoteCardProps {
    entry: ReleaseNoteEntry;
    busy: boolean;
    onAct: (id: string, path: string, method?: string) => void;
    /** Local edit while typing. */
    onEdit: (id: string, fields: Partial<Pick<ReleaseNoteEntry, 'title' | 'lead'>>) => void;
    /** Saved on blur. */
    onSave: (id: string, fields: Record<string, string>) => void;
}

function KindList({ entry }: { entry: ReleaseNoteEntry }) {
    const { t } = useTranslation();
    return (
        <>
            {KIND_ORDER.map(kind => {
                // The filter drops the null elements the wire may carry.
                const items = (entry.items || []).filter(i => i && i.kind === kind) as ReleaseNoteItem[];
                if (!items.length) return null;
                return (
                    <div key={kind}>
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                            {t(KIND_LABELS[kind].key, KIND_LABELS[kind].en)}
                        </div>
                        <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-xs text-[var(--text-secondary)]">
                            {items.map((it, i) => (
                                <li key={i}>
                                    <strong className="text-[var(--text-primary)]">{it.title}</strong>
                                    {it.title && it.body ? ' — ' : null}{it.body}
                                </li>
                            ))}
                        </ul>
                    </div>
                );
            })}
        </>
    );
}

export default function ReleaseNoteCard({ entry, busy, onAct, onEdit, onSave }: ReleaseNoteCardProps) {
    const { t } = useTranslation();
    const published = entry.status === 'published';
    const rolling = !entry.version;
    return (
        <article className={CARD} data-testid={`release-note-${entry.id}`}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`${CHIP} font-semibold text-[var(--text-primary)]`}>{entry.version || t('admin.release_unreleased', 'Unreleased')}</span>
                    <span className={published ? CHIP_SUCCESS : CHIP_WARNING}>
                        {published ? t('cms_blog.status.live', 'Published') : t('cms_blog.status.draft', 'Draft')}
                    </span>
                    {entry.services ? <span className="text-[11px] text-[var(--text-tertiary)]">{entry.services}</span> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {published ? (
                        <button type="button" disabled={busy} onClick={() => onAct(entry.id, '/unpublish')} className={SECONDARY_BTN}>
                            <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> {t('cms_site.site.releasenotes.unpublish', 'Unpublish')}
                        </button>
                    ) : (
                        <button type="button" disabled={busy} onClick={() => onAct(entry.id, '/publish')} className={PRIMARY_BTN}>
                            <Check className="h-3.5 w-3.5" aria-hidden="true" /> {t('cms_site.site.releasenotes.publish', 'Publish')}
                        </button>
                    )}
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => onAct(entry.id, '', 'DELETE')}
                        className={QUIET_BTN}
                        title={t('cms_site.site.releasenotes.discard', 'Discard')}
                        aria-label={t('cms_site.site.releasenotes.discard', 'Discard')}
                    >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>
            </div>

            {rolling && !published ? (
                <p className="m-0 text-[11.5px] leading-snug text-[var(--text-tertiary)]">
                    {t('cms_site.site.releasenotes.rolling_draft', 'This is the rolling draft — the next build will regenerate it, replacing any edits. Publish it to freeze the copy.')}
                </p>
            ) : null}

            <input
                className={INPUT}
                value={entry.title || ''}
                aria-label={t('cms_site.site.releasenotes.headline', 'Headline')}
                placeholder={t('cms_site.site.releasenotes.headline', 'Headline')}
                onChange={e => onEdit(entry.id, { title: e.target.value })}
                onBlur={e => onSave(entry.id, { title: e.target.value })}
            />
            <textarea
                className={INPUT}
                rows={2}
                value={entry.lead || ''}
                aria-label={t('cms_site.site.releasenotes.lead', 'One or two sentences for a customer')}
                placeholder={t('cms_site.site.releasenotes.lead', 'One or two sentences for a customer')}
                onChange={e => onEdit(entry.id, { lead: e.target.value })}
                onBlur={e => onSave(entry.id, { lead: e.target.value })}
            />

            <KindList entry={entry} />

            {published && entry.publishedAt ? (
                <div className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                    <Eye className="h-3 w-3" aria-hidden="true" /> {t('cms_site.site.releasenotes.live_since', 'Live since {date}', { date: new Date(entry.publishedAt).toLocaleDateString() })}
                </div>
            ) : null}
        </article>
    );
}
