// One block of a compared document, drawn in React from the editor's AST:
// headings, paragraphs, lists, quotes, code, tables, and a labelled chip for
// the atoms (images, charts, formulas, diagrams). No HTML string is ever
// injected, so a version's content cannot reach the page as markup.
//
// A changed block shows its words: kept words plain, added words marked as
// insertions, removed words struck through.

import React from 'react';
import useTranslation from '../../hooks/useTranslation';
import type { AstNode, DiffWord } from './versionDiff';

const INS = 'rounded-sm px-0.5 bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[var(--success-ink)] no-underline';
const DEL = 'rounded-sm px-0.5 bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)] line-through';

const HEADING_CLASS: Record<number, string> = {
    1: 'text-[20px] font-semibold',
    2: 'text-[17px] font-semibold',
    3: 'text-[15px] font-semibold',
};

/** The text classes of a textblock of this type (headings by level). */
export function blockTextClass(node: AstNode | null): string {
    if (!node) return '';
    if (node.type === 'heading') {
        const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
        return HEADING_CLASS[level] || 'text-[14px] font-semibold';
    }
    if (node.type === 'codeBlock') return 'font-mono text-[12px] whitespace-pre-wrap';
    return '';
}

function Marked({ node }: { node: AstNode }) {
    let out: React.ReactNode = node.text || '';
    for (const mark of node.marks || []) {
        if (mark.type === 'bold' || mark.type === 'strong') out = <strong>{out}</strong>;
        else if (mark.type === 'italic' || mark.type === 'em') out = <em>{out}</em>;
        else if (mark.type === 'code') out = <code className="font-mono text-[0.92em] px-0.5 rounded bg-[var(--bg-tertiary)]">{out}</code>;
        else if (mark.type === 'strike') out = <s>{out}</s>;
        else if (mark.type === 'underline' || mark.type === 'link') out = <span className="underline">{out}</span>;
    }
    return <>{out}</>;
}

function AtomChip({ node }: { node: AstNode }) {
    const { t } = useTranslation();
    const label: Record<string, string> = {
        image: t('versions.atom.image', 'Image'),
        chart: t('versions.atom.chart', 'Chart'),
        formula: t('versions.atom.formula', 'Formula'),
        mermaid: t('versions.atom.diagram', 'Diagram'),
        horizontalRule: t('versions.atom.divider', 'Divider'),
    };
    const alt = typeof node.attrs?.alt === 'string' && node.attrs.alt ? `: ${node.attrs.alt}` : '';
    return (
        <span className="inline-flex items-center rounded-md border border-[var(--border-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--text-tertiary)]">
            {(label[node.type] || t('versions.atom.other', 'Embedded item'))}{alt}
        </span>
    );
}

function Inline({ nodes }: { nodes: AstNode[] | undefined }) {
    return (
        <>
            {(nodes || []).map((n, i) => (n.type === 'text'
                ? <Marked key={i} node={n} />
                : (n.type === 'hardBreak' ? <br key={i} /> : <AtomChip key={i} node={n} />)))}
        </>
    );
}

type BlockRender = (node: AstNode, children: () => React.ReactNode) => React.ReactNode;

const listClass = 'm-0 pl-5';
const cellClass = 'border border-[var(--border-subtle)] px-1.5 py-0.5 align-top';

/** How each block type draws; a type missing here falls back to its children or a chip. */
const BLOCKS: Record<string, BlockRender> = {
    paragraph: (n) => <p className="m-0 min-h-[1.2em]"><Inline nodes={n.content} /></p>,
    heading: (n) => <p className={`m-0 ${blockTextClass(n)}`}><Inline nodes={n.content} /></p>,
    blockquote: (_n, kids) => <blockquote className="m-0 pl-3 border-l-2 border-[var(--border-default)] text-[var(--text-secondary)]">{kids()}</blockquote>,
    bulletList: (_n, kids) => <ul className={`${listClass} list-disc`}>{kids()}</ul>,
    taskList: (_n, kids) => <ul className={`${listClass} list-disc`}>{kids()}</ul>,
    orderedList: (_n, kids) => <ol className={`${listClass} list-decimal`}>{kids()}</ol>,
    listItem: (_n, kids) => <li>{kids()}</li>,
    taskItem: (n, kids) => <li className="list-none -ml-4"><span aria-hidden="true">{n.attrs?.checked ? '☑ ' : '☐ '}</span>{kids()}</li>,
    codeBlock: (n) => <pre className="m-0 p-2 rounded-md bg-[var(--bg-tertiary)] font-mono text-[12px] whitespace-pre-wrap">{(n.content || []).map((k) => k.text || '').join('')}</pre>,
    table: (_n, kids) => <table className="border-collapse text-[12px]"><tbody>{kids()}</tbody></table>,
    tableRow: (_n, kids) => <tr>{kids()}</tr>,
    tableCell: (_n, kids) => <td className={cellClass}>{kids()}</td>,
    tableHeader: (_n, kids) => <td className={cellClass}>{kids()}</td>,
    text: (n) => <Marked node={n} />,
};

/** A whole node, rendered by its type; unknown types fall back to their children or a chip. */
export function AstBlock({ node }: { node: AstNode }) {
    const kids = node.content || [];
    const children = () => kids.map((k, i) => <AstBlock key={i} node={k} />);
    const render = BLOCKS[node.type];
    if (render) return <>{render(node, children)}</>;
    if (!kids.length && !node.text) return <p className="m-0"><AtomChip node={node} /></p>;
    return <div>{children()}</div>;
}

/** Word tokens, spaced when the tokens carry no whitespace of their own. */
export function DiffWords({ words, show }: { words: DiffWord[]; show: 'both' | 'before' | 'after' }) {
    const { t } = useTranslation();
    const spaced = !words.some((w) => /\s/.test(w.text));
    const shown = words.filter((w) => w.op === 'equal' || show === 'both' || (show === 'before' ? w.op === 'delete' : w.op === 'insert'));
    return (
        <>
            {shown.map((w, i) => {
                const gap = spaced && i > 0 ? ' ' : '';
                if (w.op === 'insert') return <React.Fragment key={i}>{gap}<ins className={INS} title={t('versions.compare.added', 'Added')}>{w.text}</ins></React.Fragment>;
                if (w.op === 'delete') return <React.Fragment key={i}>{gap}<del className={DEL} title={t('versions.compare.removed', 'Removed')}>{w.text}</del></React.Fragment>;
                return <React.Fragment key={i}>{gap}{w.text}</React.Fragment>;
            })}
        </>
    );
}

export const INSERT_BLOCK_CLASS = 'border-l-2 border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_7%,transparent)]';
export const DELETE_BLOCK_CLASS = 'border-l-2 border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_6%,transparent)] line-through decoration-[var(--error-ink)]';
export const MODIFY_BLOCK_CLASS = 'border-l-2 border-[var(--warning)]';
