// The blocks of a compare, drawn: inline (one column, additions and removals
// marked in place) or side by side (before | after, aligned per block), with
// runs of unchanged blocks folded into a gap the reader can open. Shared by
// Version history (VersionCompare) and App Studio's document_compare.
//
// Every changed row carries `data-diff` with its op, which is what a "next
// change" button steps through.

import { ChevronsUpDown } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import useTranslation from '../../hooks/useTranslation';
import {
    AstBlock, blockTextClass, DiffWords, DELETE_BLOCK_CLASS, INSERT_BLOCK_CLASS, MODIFY_BLOCK_CLASS,
} from './DiffBlockView';
import { foldUnchanged, type AstNode, type DiffBlock, type FoldedEntry, type VersionDiff } from './versionDiff';

export type CompareView = 'inline' | 'side';

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

export function DiffBody({ diff, view, onlyChanges }: { diff: VersionDiff; view: CompareView; onlyChanges: boolean }) {
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
