import type { ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import AssetImage from './assets/AssetImage';
import { isAssetRef } from './assets/assetUrl';
import renderInlineMarkdown, { type InlineOptions } from './markdownInline';
import { CodeBlock, HEADING_CLS, part, type BlockLevel } from './markdownParts';

/**
 * App Studio runtime: RICH markdown (a markdown block with `props.rich`, since 3).
 *
 * On top of what the plain renderer draws (headings, lists, fenced code, paragraphs, bold,
 * italic, links) this adds tables, task lists, block quotes and pictures, and mailto: links.
 * Same rule as the plain one: the output is React elements built from the parsed text, so it
 * is escaped by construction. There is no raw HTML and no dangerouslySetInnerHTML; a tag in
 * the text is shown as text. A link is an http, https or mailto anchor with rel="noopener
 * noreferrer"; a picture is ONLY `![alt](asset:<id>)`, an uploaded file of the app, drawn
 * through the same AssetImage the image component uses (any other source stays text).
 *
 * The plain parser in components/AppMarkdown.tsx is untouched: a block without `rich`
 * renders exactly the DOM it always did.
 */

type Align = 'left' | 'center' | 'right' | null;

interface ListItem {
    text: string;
    /** null = an ordinary item; true / false = a task item, checked or not. */
    task: boolean | null;
}

type RichBlock =
    | { kind: 'code'; code: string }
    | { kind: 'heading'; level: BlockLevel; text: string }
    | { kind: 'list'; ordered: boolean; items: ListItem[] }
    | { kind: 'quote'; blocks: RichBlock[] }
    | { kind: 'table'; align: Align[]; head: string[]; rows: string[][] }
    | { kind: 'p'; text: string };

type Read = { block: RichBlock; next: number };

/** Quotes nest this deep, no further: the rest of a deeper quote is plain text. */
const MAX_QUOTE_DEPTH = 4;

const BULLET = /^\s*[-*]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```(\w*)\s*$/;

const isQuoteLine = (line: string) => line.trimStart().startsWith('>');
const stripQuote = (line: string) => {
    const rest = line.trimStart().slice(1);
    return rest.startsWith(' ') ? rest.slice(1) : rest;
};

/** The cells of a table row: split on `|`, a `\|` stays in the cell, the outer pipes are optional. */
function splitRow(line: string): string[] {
    const cells: string[] = [];
    let cell = '';
    const text = line.trim();
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '\\' && text[i + 1] === '|') { cell += '|'; i += 1; continue; }
        if (ch === '|') { cells.push(cell); cell = ''; continue; }
        cell += ch;
    }
    cells.push(cell);
    if (text.startsWith('|')) cells.shift();
    if (text.endsWith('|') && !text.endsWith('\\|')) cells.pop();
    return cells.map((c) => c.trim());
}

/** `---`, `:--`, `--:` or `:-:` (at least one dash): the alignment of a column, or undefined when the cell is no delimiter. */
function alignOf(cell: string): Align | undefined {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':') && cell.length > 1;
    const dashes = cell.slice(left ? 1 : 0, right ? -1 : undefined);
    if (!dashes || [...dashes].some((c) => c !== '-')) return undefined;
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : null;
}

/** The alignments of a delimiter row, or null when the line is not one. */
function delimiterRow(line: string | undefined): Align[] | null {
    if (line === undefined || !line.includes('-')) return null;
    const cells = splitRow(line);
    const aligns = cells.map(alignOf);
    return aligns.length > 0 && aligns.every((a) => a !== undefined) ? (aligns as Align[]) : null;
}

/** A table starts at a line with a pipe that is followed by a delimiter row of the same width. */
function tableAt(lines: string[], i: number): { align: Align[] } | null {
    if (!lines[i].includes('|')) return null;
    const align = delimiterRow(lines[i + 1]);
    return align && align.length === splitRow(lines[i]).length ? { align } : null;
}

function startsBlock(lines: string[], i: number): boolean {
    const line = lines[i];
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored patterns with classes that do not overlap, on one line of text: linear
    return HEADING.test(line) || line.startsWith('```') || BULLET.test(line) || NUMBERED.test(line) || isQuoteLine(line) || tableAt(lines, i) !== null;
}

function taskOf(text: string): ListItem {
    const open = text.startsWith('[ ] ');
    const done = text.startsWith('[x] ') || text.startsWith('[X] ');
    return open || done ? { text: text.slice(4), task: done } : { text, task: null };
}

function readList(lines: string[], from: number, marker: RegExp): Read {
    const items: ListItem[] = [];
    let i = from;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- the marker is BULLET or NUMBERED: anchored, classes that do not overlap, on one line of text: linear
    while (i < lines.length && marker.test(lines[i])) {
        items.push(taskOf(lines[i].replace(marker, '')));
        i += 1;
    }
    return { block: { kind: 'list', ordered: marker === NUMBERED, items }, next: i };
}

function readTable(lines: string[], from: number, align: Align[]): Read {
    const head = splitRow(lines[from]);
    const rows: string[][] = [];
    let i = from + 2;
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = splitRow(lines[i]);
        // A short row is padded and a long one cut, so every row has as many cells as the head.
        rows.push(head.map((_, c) => row[c] ?? ''));
        i += 1;
    }
    return { block: { kind: 'table', align, head, rows }, next: i };
}

function readFence(lines: string[], from: number): Read {
    const code: string[] = [];
    let i = from + 1;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored fence with one trailing class, on one line of text: linear
    while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
    return { block: { kind: 'code', code: code.join('\n') }, next: i + 1 }; // past the closing fence, or the end of the text
}

function readQuote(lines: string[], from: number, depth: number): Read {
    const inner: string[] = [];
    let i = from;
    while (i < lines.length && isQuoteLine(lines[i])) { inner.push(stripQuote(lines[i])); i += 1; }
    return { block: { kind: 'quote', blocks: parseRichBlocks(inner.join('\n'), depth + 1) }, next: i };
}

/** A paragraph runs to the next blank line or the start of another block. */
function readParagraph(lines: string[], from: number): Read {
    const para = [lines[from]];
    let i = from + 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) { para.push(lines[i]); i += 1; }
    return { block: { kind: 'p', text: para.join(' ') }, next: i };
}

/** The block that starts at line `i` (a non-blank line) and the line after it. */
function readBlock(lines: string[], i: number, depth: number): Read {
    const line = lines[i];
    if (FENCE.test(line)) return readFence(lines, i);
    const heading = HEADING.exec(line);
    if (heading) return { block: { kind: 'heading', level: heading[1].length as BlockLevel, text: heading[2] }, next: i + 1 };
    if (isQuoteLine(line) && depth < MAX_QUOTE_DEPTH) return readQuote(lines, i, depth);
    const table = tableAt(lines, i);
    if (table) return readTable(lines, i, table.align);
    if (BULLET.test(line)) return readList(lines, i, BULLET);
    if (NUMBERED.test(line)) return readList(lines, i, NUMBERED);
    return readParagraph(lines, i);
}

/** Parse markdown text into block tokens (quotes hold blocks of their own). */
export function parseRichBlocks(text: unknown, depth = 0): RichBlock[] {
    const lines = String(text ?? '').split(/\r?\n/);
    const blocks: RichBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].trim()) { i += 1; continue; }
        const read = readBlock(lines, i, depth);
        blocks.push(read.block);
        i = read.next;
    }
    return blocks;
}

const ALIGN_CLS: Record<string, string> = { left: 'text-left', center: 'text-center', right: 'text-right' };

/** A picture of the app. Anything that is not `asset:<id>` is not a picture here. */
function pictureOf(ref: string, alt: string, key: string): ReactNode | null {
    if (!isAssetRef(ref)) return null;
    return (
        <AssetImage
            key={key}
            value={ref}
            alt={alt}
            className="inline-block max-w-full h-auto align-middle [border-radius:var(--app-radius)] bfa-markdown__image"
        />
    );
}

const INLINE: InlineOptions = { mailto: true, image: pictureOf };

const inline = (text: string) => renderInlineMarkdown(text, INLINE);

/** A task item's checkbox: read only, named for assistive technology. */
function TaskBox({ done }: { done: boolean }) {
    const { t } = useTranslation();
    return (
        <input
            type="checkbox"
            checked={done}
            readOnly
            disabled
            aria-label={done ? t('studio_apps_lk22.markdown.task_done', 'Done') : t('studio_apps_lk22.markdown.task_open', 'Not done')}
            className="mt-1 shrink-0"
        />
    );
}

function RichList({ block, partClasses }: { block: Extract<RichBlock, { kind: 'list' }>; partClasses: boolean }) {
    const Tag = block.ordered ? 'ol' : 'ul';
    const style = block.ordered ? 'list-decimal' : 'list-disc';
    return (
        <Tag className={`${style} pl-5 flex flex-col gap-1${part(partClasses, 'list')}`}>
            {block.items.map((item, i) => (item.task === null
                ? <li key={i} className={partClasses ? 'bfa-markdown__item' : undefined}>{inline(item.text)}</li>
                : (
                    <li key={i} className={`list-none -ml-5 flex items-start gap-2${part(partClasses, 'item')}${part(partClasses, 'task')}`}>
                        <TaskBox done={item.task} />
                        <span>{inline(item.text)}</span>
                    </li>
                )))}
        </Tag>
    );
}

function RichTable({ block, partClasses }: { block: Extract<RichBlock, { kind: 'table' }>; partClasses: boolean }) {
    const cell = (c: number) => ALIGN_CLS[block.align[c] ?? 'left'];
    return (
        <div className={`overflow-x-auto${part(partClasses, 'table')}`}>
            <table className="w-full border-collapse text-sm">
                <thead>
                    <tr>
                        {block.head.map((h, c) => (
                            <th
                                key={c}
                                scope="col"
                                className={`${cell(c)} font-semibold px-3 py-1.5 border-b [border-color:var(--border-default)] [background:var(--bg-secondary)]`}
                            >
                                {inline(h)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {block.rows.map((row, r) => (
                        <tr key={r}>
                            {row.map((v, c) => (
                                <td key={c} className={`${cell(c)} px-3 py-1.5 border-b [border-color:var(--border-subtle)]`}>{inline(v)}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function RichBlockView({ block, partClasses }: { block: RichBlock; partClasses: boolean }) {
    switch (block.kind) {
        case 'heading': {
            const Tag = `h${block.level}` as const;
            return <Tag className={`${HEADING_CLS[block.level]}${part(partClasses, 'heading')}`}>{inline(block.text)}</Tag>;
        }
        case 'code':
            return <CodeBlock code={block.code} partClasses={partClasses} />;
        case 'list':
            return <RichList block={block} partClasses={partClasses} />;
        case 'table':
            return <RichTable block={block} partClasses={partClasses} />;
        case 'quote':
            return (
                <blockquote className={`flex flex-col gap-2 pl-3 border-l-[3px] [border-color:var(--border-default)] text-[var(--text-secondary)]${part(partClasses, 'quote')}`}>
                    {block.blocks.map((inner, i) => <RichBlockView key={i} block={inner} partClasses={partClasses} />)}
                </blockquote>
            );
        case 'p':
        default:
            return <p className={partClasses ? 'bfa-markdown__paragraph' : undefined}>{inline(block.text)}</p>;
    }
}

/** The rich block renderer for a markdown TEXT. */
export default function RichMarkdownBlocks({ text, partClasses = false }: { text: unknown; partClasses?: boolean }) {
    return <>{parseRichBlocks(text).map((block, i) => <RichBlockView key={i} block={block} partClasses={partClasses} />)}</>;
}
