import { AppWindow, ChevronRight, ExternalLink } from 'lucide-react';
import React from 'react';
import { appRefDisplay, useAppRefLabel } from './flow/appRefLabel';
import useTranslation from '../../../hooks/useTranslation';
import { segmentForSection } from '../../admin/Studio/studioRoutes';

/**
 * "You got here from this button" — App › Screen › button, above the builder.
 *
 * Shown when the builder was opened with `?from=app:<app>:<screen>:<node>`, or
 * when the routine's own trigger carries the same back-pointer. It is the way
 * back: without it, following "Open" from an app action is a one-way trip.
 *
 * ── What it is NOT allowed to do ──────────────────────────────────────────
 * Three ids in a URL are not permission to say three names. The server decides
 * per viewer what may be told (server/appStudio/appRefLookup.js), and this
 * component renders only what came back:
 *
 *   · a name only when the server supplied one — otherwise the raw id, which
 *     is honest and useless to anyone who should not have it;
 *   · a LINK only when the server said `canOpen`. App Studio's editor is
 *     owner-only, so a link for anyone else would land on a refusal, and a
 *     link that 403s is worse than no link at all;
 *   · "this is gone" only when the server said which level is gone. A pointer
 *     that resolves to nothing is not "no trigger" — the routine still fires
 *     from an app action — so the strip says so instead of disappearing.
 *
 * While the answer is in flight it renders NOTHING rather than a skeleton of
 * ids that will be replaced a moment later by names.
 */
export default function AppRefBreadcrumb({ appRef }) {
    const { t } = useTranslation();
    const record = useAppRefLabel(appRef);
    if (!appRef) return null;
    // undefined = not arrived. Say nothing rather than flash ids.
    if (record === undefined) return null;

    const d = appRefDisplay(record, appRef);
    const appHref = d.canOpen && d.appId
        ? `/app/studio/${segmentForSection('apps')}/${encodeURIComponent(d.appId)}`
        : null;

    // Each crumb is present or absent on its own. A level the pointer no
    // longer reaches gets the word instead of a name — never an em-dash, and
    // never a silently dropped segment.
    const crumbs = [
        {
            key: 'app',
            text: d.gone === 'app' ? t('routine_editor.app_ref.app_gone', 'App no longer exists') : d.appText,
            muted: d.gone === 'app',
            title: d.appId,
            href: appHref,
        },
        {
            key: 'screen',
            text: d.gone === 'screen' ? t('routine_editor.app_ref.screen_gone', 'Screen no longer exists') : d.screenText,
            muted: d.gone === 'screen',
            title: d.screenId,
        },
        d.nodeId ? {
            key: 'node',
            text: d.gone === 'node' ? t('routine_editor.app_ref.node_gone', 'Button no longer exists') : d.nodeText,
            muted: d.gone === 'node',
            title: d.nodeId,
        } : null,
    ].filter((c) => c && (c.text || c.muted));

    // The one sentence under the trail, when there is something to explain.
    const note = d.gone === 'app'
        ? null // the crumb already says it; a second sentence would repeat it
        : d.restricted
            ? t('routine_editor.app_ref.restricted', 'This app belongs to someone else, so it cannot be named or opened from here.')
            : d.unknown
                ? t('routine_editor.app_ref.unknown', 'This could not be checked just now.')
                : null;

    return (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 text-[11px] min-w-0">
            <AppWindow className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            <nav
                aria-label={t('routine_editor.app_ref.nav_label', 'The button this routine was opened from')}
                className="flex items-center gap-1 min-w-0 overflow-hidden"
            >
                {crumbs.map((c, i) => (
                    <React.Fragment key={c.key}>
                        {i > 0 && <ChevronRight className="w-3 h-3 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />}
                        {c.href ? (
                            <a
                                href={c.href}
                                title={c.title || undefined}
                                className="inline-flex items-center gap-1 truncate text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline decoration-dotted underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] rounded"
                            >
                                <span className="truncate">{c.text}</span>
                                <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
                            </a>
                        ) : (
                            <span
                                title={c.title || undefined}
                                className={`truncate ${c.muted ? 'italic text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}
                            >
                                {c.text}
                            </span>
                        )}
                    </React.Fragment>
                ))}
            </nav>
            {note ? (
                <span className="shrink-0 text-[var(--text-tertiary)] truncate">{note}</span>
            ) : null}
        </div>
    );
}
