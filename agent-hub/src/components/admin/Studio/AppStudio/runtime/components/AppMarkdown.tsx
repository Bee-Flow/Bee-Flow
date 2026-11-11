import renderInlineMarkdown from '../markdownInline';
import { CodeBlock, HEADING_CLS, part, type BlockLevel } from '../markdownParts';
import RichMarkdownBlocks from '../markdownRich';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import type { NodeProps } from './appNode.types';
import type { BindingInput } from '../resolveBinding.types';

/**
 * App Studio runtime — 'markdown'. Spec: server/appStudio/componentSpecs.js.
 *
 * A small BLOCK renderer on top of markdownInline's bold/italic/link subset:
 * headings (#–######), unordered/ordered lists, fenced code blocks and
 * paragraphs. Deliberately NOT the chat MarkdownRenderer (mermaid/katex/
 * highlight are heavyweight and app definitions must not smuggle images or
 * raw HTML) — everything here emits escaped React elements only. A block with
 * `rich` on takes the rich renderer instead (markdownRich.tsx).
 */

type MarkdownBlock =
    | { kind: 'code'; lang: string | null; code: string }
    | { kind: 'heading'; level: BlockLevel; text: string }
    | { kind: 'ul' | 'ol'; items: string[] }
    | { kind: 'p'; text: string };

/** Parse markdown text into a flat list of block tokens. */
export function parseBlocks(text: unknown): MarkdownBlock[] {
    const lines = String(text ?? '').split(/\r?\n/);
    const blocks: MarkdownBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i += 1; continue; }

        // fenced code block
        const fence = line.match(/^```(\w*)\s*$/);
        if (fence) {
            const code: string[] = [];
            i += 1;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
            i += 1; // skip closing fence (or EOF)
            blocks.push({ kind: 'code', lang: fence[1] || null, code: code.join('\n') });
            continue;
        }

        // heading
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            blocks.push({ kind: 'heading', level: heading[1].length as BlockLevel, text: heading[2] });
            i += 1;
            continue;
        }

        // unordered list
        if (/^\s*[-*]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
                i += 1;
            }
            blocks.push({ kind: 'ul', items });
            continue;
        }

        // ordered list
        if (/^\s*\d+[.)]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
                i += 1;
            }
            blocks.push({ kind: 'ol', items });
            continue;
        }

        // paragraph — greedy until a blank line or another block start
        const para = [line];
        i += 1;
        while (
            i < lines.length && lines[i].trim()
            && !/^(#{1,6})\s+/.test(lines[i]) && !/^```/.test(lines[i])
            && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])
        ) {
            para.push(lines[i]);
            i += 1;
        }
        blocks.push({ kind: 'p', text: para.join(' ') });
    }
    return blocks;
}



function Block({ block, partClasses = false }: { block: MarkdownBlock; partClasses?: boolean }) {
    switch (block.kind) {
        case 'heading': {
            const Tag = `h${block.level}` as const;
            return <Tag className={`${HEADING_CLS[block.level]}${part(partClasses, 'heading')}`}>{renderInlineMarkdown(block.text)}</Tag>;
        }
        case 'ul':
            return (
                <ul className={`list-disc pl-5 flex flex-col gap-1${part(partClasses, 'list')}`}>
                    {block.items.map((item: string, i: number) => <li key={i} className={partClasses ? 'bfa-markdown__item' : undefined}>{renderInlineMarkdown(item)}</li>)}
                </ul>
            );
        case 'ol':
            return (
                <ol className={`list-decimal pl-5 flex flex-col gap-1${part(partClasses, 'list')}`}>
                    {block.items.map((item: string, i: number) => <li key={i} className={partClasses ? 'bfa-markdown__item' : undefined}>{renderInlineMarkdown(item)}</li>)}
                </ol>
            );
        case 'code':
            return <CodeBlock code={block.code} partClasses={partClasses} />;
        case 'p':
        default:
            return <p className={partClasses ? 'bfa-markdown__paragraph' : undefined}>{renderInlineMarkdown(block.text)}</p>;
    }
}

/**
 * The block renderer for arbitrary markdown TEXT (not a node) — shared with the
 * AI chat component so model output renders through the same escaped, no-raw-HTML
 * subset the markdown component uses.
 */
export function MarkdownBlocks({ text, partClasses = false }: { text: unknown; partClasses?: boolean }) {
    const blocks = parseBlocks(text);
    return <>{blocks.map((block: MarkdownBlock, i: number) => <Block key={i} block={block} partClasses={partClasses} />)}</>;
}

export default function AppMarkdown({ node }: NodeProps<{ content?: string; contentFrom?: BindingInput; rich?: boolean }>) {
    const { actionState, dataState, scope } = useRuntime();
    const { content = '' } = node.props || {};
    // `contentFrom` wins when it has text — the same shape as `valueFrom` on the
    // inputs. This is what lets an action's output be DISPLAYED: before it, every
    // text component took a fixed string, so an AI summary had nowhere to go.
    const { value: bound } = resolveBinding(node.props?.contentFrom, { actionState, dataState, scope });
    const text = (typeof bound === 'string' && bound.trim()) ? bound : content;
    return (
        <div className="flex flex-col gap-2 text-sm bfa-markdown__root" data-app-markdown="true">
            {/* rich (since 3) is opt-in: tables, task lists, quotes, pictures of the app (markdownRich.tsx). */}
            {node.props?.rich === true ? <RichMarkdownBlocks text={text} partClasses /> : <MarkdownBlocks text={text} partClasses />}
        </div>
    );
}
