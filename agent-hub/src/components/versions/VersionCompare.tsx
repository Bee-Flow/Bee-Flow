// Compare two states of a notebook or document: inline (one column, additions
// and removals marked in place) or side by side (before | after, aligned per
// block), with unchanged stretches folded away by default ("Only changes").
//
// Each side is a version id or 'current'. The versions are read through the
// shared version queries, so a compare opened twice costs nothing the second
// time; the diff itself runs in the browser (versionDiff.ts).

import { ChevronsUpDown } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useVersionQuery, type VersionContent } from '../../api/queries/versions';
import useTranslation from '../../hooks/useTranslation';
import SegmentedControl from '../shared/SegmentedControl';
import {
    AstBlock, blockTextClass, DiffWords, DELETE_BLOCK_CLASS, INSERT_BLOCK_CLASS, MODIFY_BLOCK_CLASS,
} from './DiffBlockView';
import { diffVersions, foldUnchanged, isChange, type AstNode, type DiffBlock, type FoldedEntry, type VersionDiff } from './versionDiff';
import { statsText, versionErrorText } from './versionText';

export type CompareView = 'inline' | 'side';

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

function Tag({ children }: { children: React.ReactNode }) {
    return <span className="ml-2 align-middle text-[10.5px] uppercase tracking-[0.04em] text-[var(--text-tertiary)]">{children}</span>;
}

/**
 * A block added or removed as a whole, inside <ins>/<del> so assistive
 * technology (and a copy of the page) keeps the meaning the colour carries.
 */
function WholeBlock({ kind, node, label }: { kind: 'insert' | 'delete'; node: AstNode; label: React.ReactNode }) {
    const Tag = kind === 'insert' ? 'ins' : 'del';
    return (
        <Tag className={`block px-2 py-0.5 ${kind === 'insert' ? `no-underline ${INSERT_BLOCK_CLASS}` : DELETE_BLOCK_CLASS}`} data-diff={kind}>
            {label}<AstBlock node={node} />
        </Tag>
    );
}

/** One block in the inline rendering. */
function InlineBlock({ block }: { block: DiffBlock }) {
    const { t } = useTranslation();
    const added = <span className="sr-only">{t('versions.compare.added', 'Added')}: </span>;
    const removed = <span className="sr-only">{t('versions.compare.removed', 'Removed')}: </span>;
    if (block.op === 'equal' && block.after) return <div className="px-2 py-0.5"><AstBlock node={block.after} /></div>;
    if (block.op === 'insert' && block.after) return <WholeBlock kind="insert" node={block.after} label={added} />;
    if (block.op === 'delete' && block.before) return <WholeBlock kind="delete" node={block.before} label={removed} />;
    if (block.op === 'modify') {
        if (block.formatOnly && block.after) {
            return <div className={`px-2 py-0.5 ${MODIFY_BLOCK_CLASS}`} data-diff="format"><AstBlock node={block.after} /><Tag>{t('versions.compare.format_only', 'Formatting changed')}</Tag></div>;
        }
        if (block.words) {
            return <div className={`px-2 py-0.5 ${MODIFY_BLOCK_CLASS}`} data-diff="modify"><p className={`m-0 ${blockTextClass(block.after || block.before)}`}><DiffWords words={block.words} show="both" /></p></div>;
        }
        return (
            <>
                {block.before && <WholeBlock kind="delete" node={block.before} label={removed} />}
                {block.after && <WholeBlock kind="insert" node={block.after} label={added} />}
            </>
        );
    }
    return null;
}

/** One block as a row of the side-by-side rendering. */
function SideRow({ block }: { block: DiffBlock }) {
    const cell = 'min-w-0 px-2 py-0.5';
    let left: React.ReactNode = null;
    let right: React.ReactNode = null;
    let leftClass = cell;
    let rightClass = cell;
    if (block.op === 'equal') {
        left = block.before && <AstBlock node={block.before} />;
        right = block.after && <AstBlock node={block.after} />;
    } else if (block.op === 'insert') {
        right = block.after && <AstBlock node={block.after} />;
        rightClass = `${cell} ${INSERT_BLOCK_CLASS}`;
    } else if (block.op === 'delete') {
        left = block.before && <AstBlock node={block.before} />;
        leftClass = `${cell} ${DELETE_BLOCK_CLASS}`;
    } else if (block.words && !block.formatOnly) {
        left = <p className={`m-0 ${blockTextClass(block.before)}`}><DiffWords words={block.words} show="before" /></p>;
        right = <p className={`m-0 ${blockTextClass(block.after)}`}><DiffWords words={block.words} show="after" /></p>;
        leftClass = `${cell} ${MODIFY_BLOCK_CLASS}`;
        rightClass = `${cell} ${MODIFY_BLOCK_CLASS}`;
    } else {
        left = block.before && <AstBlock node={block.before} />;
        right = block.after && <AstBlock node={block.after} />;
        leftClass = `${cell} ${MODIFY_BLOCK_CLASS}`;
        rightClass = `${cell} ${MODIFY_BLOCK_CLASS}`;
    }
    return (
        <div className="grid grid-cols-2 gap-3" data-diff={block.op}>
            <div className={leftClass}>{left}</div>
            <div className={rightClass}>{right}</div>
        </div>
    );
}

function GapButton({ count, onOpen }: { count: number; onOpen: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onOpen}
            className="w-full flex items-center justify-center gap-1.5 my-1 py-1 rounded-md text-[11.5px] text-[var(--text-tertiary)] bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            data-testid="compare-gap"
        >
            <ChevronsUpDown className="w-3.5 h-3.5" aria-hidden="true" />
            {t('versions.compare.unchanged', '{n} unchanged sections', { n: count })}
        </button>
    );
}

function DiffBody({ diff, view, onlyChanges }: { diff: VersionDiff; view: CompareView; onlyChanges: boolean }) {
    const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
    const entries: FoldedEntry[] = useMemo(() => {
        const folded = onlyChanges
            ? foldUnchanged(diff.blocks)
            : diff.blocks.map((block, index) => ({ kind: 'block' as const, index, block }));
        // A gap the reader opened shows its blocks in place.
        return folded.flatMap((e) => (e.kind === 'gap' && opened.has(e.from)
            ? diff.blocks.slice(e.from, e.to + 1).map((block, i) => ({ kind: 'block' as const, index: e.from + i, block }))
            : [e]));
    }, [diff, onlyChanges, opened]);
    const Row = view === 'side' ? SideRow : InlineBlock;
    return (
        <div className="text-[13px] leading-relaxed text-[var(--text-primary)] space-y-0.5" data-testid={`compare-${view}`}>
            {entries.map((e) => (e.kind === 'gap'
                ? <GapButton key={`gap-${e.from}`} count={e.count} onOpen={() => setOpened((s) => new Set([...s, e.from]))} />
                : <Row key={`b-${e.index}`} block={e.block} />))}
        </div>
    );
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
