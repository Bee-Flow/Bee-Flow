import { useCallback, useMemo } from 'react';
import { useVersionList, useVersionViewer, type VersionRow } from './history/useVersionHistory';
import { Chip, VersionListRow, VersionViewer } from './history/VersionParts';
import useConfirm from '../../components/shared/useConfirm';
import useTranslation from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';

export { formatLineDelta } from './history/VersionParts';

/**
 * The History tab: what happened to this page, and how to go back.
 *
 * ── WHY THIS IS A TAB AND NO LONGER A MODAL ─────────────────────────────────
 *
 * Until W4 this was an overlay on top of the tab you were on: the strip
 * pointed at "History" while something ELSE was really underneath, and
 * closing meant being put back on a remembered previous tab. That
 * construction only existed because the list was once a dialog. The history
 * is a SECTION of the page, like Data and Used by, and behaves like one: it
 * replaces the body, needs no focus trap, and Escape means nothing special.
 *
 * ── WHAT THIS SCREEN MAY CLAIM ──────────────────────────────────────────────
 *
 * UNKNOWN IS NOT ZERO AND NOT YOU. The server already holds that rule
 * (routes/webpages.js + core/webpages/versionFacts.js) and it must NOT be
 * polished away here:
 *
 *   - `actor: null` or `actor.name: null` → "Unknown". Never "You", never an
 *     empty place where a name belongs.
 *   - `lineDelta: null` → nothing is shown. "±0" would say nothing changed,
 *     and nobody made that statement.
 *   - `seq: null` → no "v0". Rows from before the column carry no number.
 *
 * ── RESTORING GOES THROUGH THE PAGE ─────────────────────────────────────────
 *
 * This tab does not restore by itself. `onRestore(versionId)` goes to
 * WebpageEditorPage, which knows the only path allowed to move the editor
 * state: the POST, then `acceptServerSnapshot(files)` (re-baseline before the
 * setters), then setHtml/setCss/setJs. A second copy of that path here would
 * fire the save discipline behind the editor's back.
 */
export default function WebpageHistoryTab({ webpageId, onRestore, onLoaded }: {
    webpageId: string;
    onRestore?: (versionId: string) => Promise<void>;
    onLoaded?: (count: number) => void;
}) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const list = useVersionList(webpageId, onLoaded);
    const { versions, coverage, load, mountedRef, setError } = list;
    const viewer = useVersionViewer(webpageId, t, mountedRef);
    const { setViewing } = viewer;

    const handleRestore = useCallback(async (version: VersionRow) => {
        if (!onRestore) return;
        const label = version.seq
            ? t('webpages.versions.confirm_restore_title_numbered', 'Restore v{seq}?', { seq: version.seq })
            : t('webpages.versions.confirm_restore_title', 'Restore this version?');
        // The promise has to be true. A snapshot only carries the three primary
        // files plus the page database; extra files stay at the NEW state.
        // "You can undo this" without that sentence turns a half-restored page
        // into a whole one.
        const description = coverage && coverage.extraFiles === false && coverage.coversProject === false
            ? t('webpages.versions.confirm_restore_partial',
                'Your current files are saved as a new version first. Only index.html, style.css, script.js and '
                + 'the page database are restored — every other file in this project stays as it is now.')
            : t('webpages.versions.confirm_restore',
                'Your current files are saved as a new version first, so you can undo this.');
        const ok = await confirm({ title: label, description, confirmLabel: t('webpages.versions.restore', 'Restore') });
        if (!ok) return;
        try {
            await onRestore(version.id);
            if (!mountedRef.current) return;
            setViewing(null);
            // Restoring adds a row of its own (the state from before the
            // action), so the list on screen is out of date at once.
            await load();
        } catch (err) {
            if (mountedRef.current) setError(errorMessage(err));
        }
    }, [confirm, coverage, load, onRestore, t, mountedRef, setError, setViewing]);

    const publishedLabel = useMemo(() => {
        if (!list.published) return null;
        return list.published.seq
            ? t('webpages.versions.published_chip', 'Published: v{seq}', { seq: list.published.seq })
            : t('webpages.versions.published_chip_unnumbered', 'Published: an earlier version');
    }, [list.published, t]);

    if (viewer.viewing) {
        return (
            <VersionViewer
                viewing={viewer.viewing} viewSlot={viewer.viewSlot} onSlot={viewer.setViewSlot}
                viewError={viewer.viewError} onBack={() => setViewing(null)}
            />
        );
    }

    const partial = !!coverage && coverage.coversProject === false;
    return (
        <div className="h-full overflow-auto custom-scrollbar px-6 py-5 [background:var(--bg-primary)]" data-testid="webpage-history">
            <div className="max-w-[720px] flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                        {t('webpages.versions.title', 'Version history')}
                    </h3>
                    {publishedLabel && <Chip tone="accent" testId="published-chip">{publishedLabel}</Chip>}
                </div>
                {list.error && <p className="text-xs text-[var(--text-secondary)]" role="alert">{list.error}</p>}
                {partial && (
                    <p className="text-[11px] text-[var(--text-tertiary)]" data-testid="history-coverage">
                        {t('webpages.versions.coverage_partial',
                            'Only index.html, style.css, script.js and the page database are snapshotted. Other files '
                            + 'in this project are not part of a version and are not restored.')}
                    </p>
                )}
                {list.loading && versions.length === 0 ? (
                    <p className="text-xs text-[var(--text-tertiary)]">{t('webpages.versions.loading', 'Loading…')}</p>
                ) : versions.length === 0 ? (
                    <p className="text-xs text-[var(--text-tertiary)]" data-testid="history-empty">
                        {partial
                            ? t('webpages.versions.empty_not_covered',
                                'Version history only covers index.html, style.css, script.js and the page database. '
                                + 'This project keeps its code in other files, so nothing is snapshotted here.')
                            : t('webpages.versions.empty', 'No versions yet. Auto-snapshots are created every 5 minutes when you edit.')}
                    </p>
                ) : (
                    <div className="flex flex-col gap-2">
                        {versions.map((v) => (
                            <VersionListRow
                                key={v.id} v={v}
                                onView={() => viewer.handleView(v)}
                                onRestore={onRestore ? () => handleRestore(v) : undefined}
                            />
                        ))}
                        {list.hasMore && (
                            <button
                                onClick={list.loadMore}
                                disabled={list.loadingMore}
                                className="w-full py-1.5 rounded-lg text-[11px] font-medium border disabled:opacity-50 border-[var(--border-subtle)] text-[var(--text-secondary)]"
                            >
                                {list.loadingMore ? t('webpages.versions.loading', 'Loading…') : t('webpages.versions.load_more', 'Load more')}
                            </button>
                        )}
                    </div>
                )}
            </div>
            {confirmDialog}
        </div>
    );
}
