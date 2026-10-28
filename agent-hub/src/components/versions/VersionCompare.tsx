// Compare two states of a notebook or document: inline (one column, additions
// and removals marked in place) or side by side (before | after, aligned per
// block), with unchanged stretches folded away by default ("Only changes").
//
// Each side is a version id or 'current'. The versions are read through the
// shared version queries, so a compare opened twice costs nothing the second
// time; the diff itself runs in the browser (versionDiff.ts).

import React, { useMemo, useState } from 'react';
import { useVersionQuery, type VersionContent } from '../../api/queries/versions';
import useTranslation from '../../hooks/useTranslation';
import SegmentedControl from '../shared/SegmentedControl';
import { DiffBody, type CompareView } from './DiffBody';
import { diffVersions, isChange, type VersionDiff } from './versionDiff';
import { statsText, versionErrorText } from './versionText';

export type { CompareView };

export interface VersionCompareProps {
    baseUrl: string;
    /** The older side: a version id, or 'current'. */
    fromRef: string;
    /** The newer side: a version id, or 'current'. */
    toRef: string;
    /** Start folded to the changes (the default) or showing everything. */
    initialOnlyChanges?: boolean;
    initialView?: CompareView;
}

/** The diff of two loaded contents, or the reason there is none. */
function useDiff(from: VersionContent | undefined, to: VersionContent | undefined) {
    return useMemo(() => {
        if (!from || !to) return { diff: null, failed: false };
        try {
            return { diff: diffVersions(from, to), failed: false };
        } catch {
            return { diff: null, failed: true };
        }
    }, [from, to]);
}

/** Loading, failed, identical, or the diff itself. */
function CompareBody({ from, to, diff, failed, view, onlyChanges }: {
    from: ReturnType<typeof useVersionQuery>;
    to: ReturnType<typeof useVersionQuery>;
    diff: VersionDiff | null;
    failed: boolean;
    view: CompareView;
    onlyChanges: boolean;
}) {
    const { t } = useTranslation();
    if (from.isError || to.isError) {
        return (
            <div role="alert" className="space-y-2" data-testid="compare-load-failed">
                <p className="m-0 text-[12.5px] text-[var(--error-ink)]">{versionErrorText(t, from.error || to.error, t('versions.compare.load_failed', 'Could not load these versions.'))}</p>
                <button type="button" className="text-[12px] underline text-[var(--text-secondary)]" onClick={() => { from.refetch(); to.refetch(); }}>
                    {t('versions.retry', 'Try again')}
                </button>
            </div>
        );
    }
    if (from.isPending || to.isPending) {
        return <p role="status" className="m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('versions.compare.loading', 'Comparing…')}</p>;
    }
    if (failed || !diff) {
        return <p role="alert" className="m-0 text-[12.5px] text-[var(--text-secondary)]" data-testid="compare-failed">{t('versions.compare.failed', 'These two versions could not be compared. You can still restore either of them.')}</p>;
    }
    if (diff.truncated) {
        return <p role="status" className="m-0 py-4 text-center text-[12.5px] text-[var(--text-secondary)]" data-testid="compare-too-large">{t('versions.compare.too_large', 'These versions are too long to compare word by word. The counts above say how much changed.')}</p>;
    }
    if (!diff.blocks.some(isChange)) {
        return <p className="m-0 py-4 text-center text-[12.5px] text-[var(--text-tertiary)]" data-testid="compare-same">{t('versions.compare.same', 'No differences in the text.')}</p>;
    }
    return <DiffBody diff={diff} view={view} onlyChanges={onlyChanges} />;
}

export default function VersionCompare({ baseUrl, fromRef, toRef, initialOnlyChanges = true, initialView = 'inline' }: VersionCompareProps) {
    const { t } = useTranslation();
    const [view, setView] = useState<CompareView>(initialView);
    const [onlyChanges, setOnlyChanges] = useState(initialOnlyChanges);
    const from = useVersionQuery(baseUrl, fromRef);
    const to = useVersionQuery(baseUrl, toRef);
    const { diff, failed } = useDiff(from.data?.content, to.data?.content);
    const summary = diff ? statsText(t, diff.stats) : null;
    return (
        <section aria-label={t('versions.compare.label', 'Comparison')} className="space-y-3" data-testid="version-compare">
            <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                    size="sm"
                    value={view}
                    onChange={setView}
                    ariaLabel={t('versions.compare.view', 'How to show the differences')}
                    options={[
                        { value: 'inline', label: t('versions.compare.inline', 'Inline') },
                        { value: 'side', label: t('versions.compare.side', 'Side by side') },
                    ]}
                />
                <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] cursor-pointer">
                    <input
                        type="checkbox"
                        checked={onlyChanges}
                        onChange={(e) => setOnlyChanges(e.target.checked)}
                        className="accent-[var(--accent-primary)]"
                        data-testid="compare-only-changes"
                    />
                    {t('versions.compare.only_changes', 'Only changes')}
                </label>
                {summary && <span className="ml-auto text-[11.5px] tabular-nums text-[var(--text-tertiary)]" data-testid="compare-stats">{summary}</span>}
            </div>
            {view === 'side' && diff && (
                <div className="grid grid-cols-2 gap-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]" aria-hidden="true">
                    <span>{t('versions.compare.before', 'Before')}</span>
                    <span>{t('versions.compare.after', 'After')}</span>
                </div>
            )}
            <CompareBody from={from} to={to} diff={diff} failed={failed} view={view} onlyChanges={onlyChanges} />
        </section>
    );
}
