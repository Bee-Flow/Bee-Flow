import React from 'react';
import Dropdown from './Dropdown';
import SaveBadge from './SaveBadge';
import { useTranslation } from '../../../../hooks/useTranslation';
import AppIcon from '../../../icons/AppIcon';

function formatRelative(iso, t) {
    if (!iso) return null;
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return null;
    const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (diffSec < 45)    return t('cms_site.site.shell.rel_now', 'just now');
    if (diffSec < 3600)  return t('cms_site.site.shell.rel_min', '{n}m ago', { n: Math.round(diffSec / 60) });
    if (diffSec < 86400) return t('cms_site.site.shell.rel_hour', '{n}h ago', { n: Math.round(diffSec / 3600) });
    return new Date(ts).toLocaleDateString();
}

// Derived, read-only status of the draft → published → live pipeline.
// `dirtySincePublish` is a soft client heuristic — copy stays soft.
function statusFor({ publishedAt, dirtySincePublish, isLive }, t) {
    if (!publishedAt) {
        return { label: t('cms_site.site.shell.st_draft', 'Draft — never published'), dot: 'var(--text-muted)' };
    }
    if (isLive) {
        return dirtySincePublish
            ? { label: t('cms_site.site.shell.st_live_dirty', 'Live · Unpublished changes'), dot: '#fbbf24' }
            : { label: t('cms_site.site.shell.st_live', 'Live · Published {when}', { when: formatRelative(publishedAt, t) }), dot: '#34d399' };
    }
    return dirtySincePublish
        ? { label: t('cms_site.site.shell.st_dirty', 'Unpublished changes'), dot: '#fbbf24' }
        : { label: t('cms_site.site.shell.st_published', 'Published {when}', { when: formatRelative(publishedAt, t) }), dot: 'var(--text-secondary)' };
}

function Stage({ label, active, done }) {
    return (
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border
            ${active
                ? 'border-[var(--accent-primary)] text-[var(--accent-primary)] bg-[var(--accent-primary)]/10'
                : done
                    ? 'border-[var(--border-default)] text-[var(--text-secondary)]'
                    : 'border-[var(--border-subtle)] text-[var(--text-muted)]'}`}
        >
            {label}
        </span>
    );
}

/**
 * TopBar publish control — status pill + Publish split button.
 *
 * The dropdown makes the draft → published snapshot → live pipeline legible
 * in one place: save state, last publish, the Live toggle with its real
 * consequence spelled out, and the open-live-site link. The Publish action
 * itself is the container's `handlePublish`, behavior-identical (drain →
 * abort-on-failed-save → POST); the disabled rules are unchanged.
 */
export default function PublishMenu({
    saveStatus,
    onRetrySave,
    publishing,
    publishedAt,
    dirtySincePublish,
    isLive,
    liveSiteName,        // name of the OTHER live site (null when none / this one)
    onPublish,
    onSetLive,           // (next:boolean) — container confirms + persists
}) {
    const { t } = useTranslation();
    const status = statusFor({ publishedAt, dirtySincePublish, isLive }, t);
    const publishDisabled = publishing || saveStatus === 'saving' || saveStatus === 'error';

    // Current pipeline stage for the mini state diagram.
    const stage = !publishedAt ? 'draft' : (isLive ? 'live' : 'published');

    return (
        <div className="flex items-center gap-2">
            <span className="hidden md:flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] whitespace-nowrap" title={t('cms_site.site.shell.pub_status_title', 'Draft / publish / live status')}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: status.dot }} />
                {status.label}
            </span>
            <div className="flex items-stretch rounded-md overflow-hidden border border-[var(--accent-primary)]">
                <button
                    type="button"
                    onClick={onPublish}
                    disabled={publishDisabled}
                    className="px-3 py-1.5 text-xs font-medium bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary)]/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('cms_site.site.shell.pub_title', 'Make the current draft the public snapshot (all languages included)')}
                >
                    {publishing ? t('cms_site.site.shell.publishing', 'Publishing…') : t('cms_site.site.shell.publish', 'Publish')}
                </button>
                <Dropdown
                    align="right"
                    width={300}
                    trigger={({ open }) => (
                        <button
                            type="button"
                            className="h-full px-1.5 bg-[var(--accent-primary)]/90 text-white hover:bg-[var(--accent-primary)] border-l border-white/20 flex items-center"
                            title={t('cms_site.site.shell.pub_menu_title', 'Publishing & live status')}
                        >
                            <AppIcon name={open ? 'ChevronUp' : 'ChevronDown'} className="w-3.5 h-3.5" />
                        </button>
                    )}
                >
                    {() => (
                        <div className="p-3 space-y-3">
                            {/* Save state */}
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t('cms_site.site.shell.draft', 'Draft')}</span>
                                {saveStatus === 'idle'
                                    ? <span className="text-xs text-[var(--text-secondary)]">{t('cms_site.site.shell.all_saved', 'All changes saved')}</span>
                                    : <SaveBadge status={saveStatus} onRetry={onRetrySave} />}
                            </div>

                            {/* Pipeline diagram */}
                            <div className="flex items-center gap-1 text-[var(--text-muted)]">
                                <Stage label={t('cms_site.site.shell.stage_draft', 'Draft (editor)')} active={stage === 'draft'} done={stage !== 'draft'} />
                                <AppIcon name="ArrowRight" className="w-3 h-3 shrink-0" />
                                <Stage label={t('cms_site.site.shell.stage_published', 'Published snapshot')} active={stage === 'published'} done={stage === 'live'} />
                                <AppIcon name="ArrowRight" className="w-3 h-3 shrink-0" />
                                <Stage label={t('cms_site.site.shell.stage_live', 'Live site')} active={stage === 'live'} done={false} />
                            </div>

                            <p className="text-[11px] text-[var(--text-muted)] leading-snug">
                                {publishedAt
                                    ? t('cms_site.site.shell.last_published', 'Last published {when}.', { when: formatRelative(publishedAt, t) })
                                    : t('cms_site.site.shell.not_published', 'Not published yet — drafts are only visible in the editor.')}
                                {' '}{t('cms_site.site.shell.publish_explain', 'Publishing makes your current draft the public snapshot (all languages included).')}
                            </p>

                            {/* Live section */}
                            <div className="border-t border-[var(--border-subtle)] pt-3">
                                <label className="flex items-center justify-between gap-3 cursor-pointer">
                                    <span className="text-sm text-[var(--text-primary)]">{t('cms_site.site.shell.live', 'Live')}</span>
                                    <span
                                        onClick={() => onSetLive(!isLive)}
                                        className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${isLive ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-default)]'}`}
                                        role="switch"
                                        aria-checked={isLive}
                                    >
                                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isLive ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                                    </span>
                                </label>
                                <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-snug">
                                    {isLive
                                        ? t('cms_site.site.shell.live_serves', 'This site serves {origin}/ for all visitors.', { origin: window.location.origin })
                                        : liveSiteName
                                            ? t('cms_site.site.shell.live_other', '"{name}" is live right now. Toggling Live moves the public site to this one.', { name: liveSiteName })
                                            : t('cms_site.site.shell.live_toggle', 'Toggle Live to bring this site online at the public URL.')}
                                </p>
                                {isLive && (
                                    <a
                                        href="/"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 mt-2 text-xs text-[var(--text-secondary)] hover:text-[var(--accent-primary)]"
                                    >
                                        {t('cms_site.site.shell.open_live', 'Open live site')}
                                        <AppIcon name="ExternalLink" className="w-3 h-3" />
                                    </a>
                                )}
                            </div>
                        </div>
                    )}
                </Dropdown>
            </div>
        </div>
    );
}
