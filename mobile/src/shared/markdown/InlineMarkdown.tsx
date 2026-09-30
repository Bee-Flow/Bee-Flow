/**
 * Markdown in one run of text — for a line that has to stay a line: a run's
 * summary in a list row, a step's description, an error under a heading.
 *
 * The full renderer (Markdown.tsx) lays blocks out one under the other, which
 * a two-line preview cannot hold. This keeps what reads inside a sentence —
 * bold, italics, strikethrough, code spans, links (which open), inline maths
 * — and flattens the rest: a heading reads as bold words, a list as "• item"
 * lines, a code block as a code span, a table as its cells, a picture as its
 * description. The result is ONE <Text>, so the caller's `numberOfLines`,
 * variant and tone apply to all of it, and a text without markdown renders
 * exactly as a plain <Text> would.
 */

import type { Token, Tokens } from 'marked';
import React, { useMemo, type ReactNode } from 'react';
import { Text as Span } from 'react-native';

import { Text, type TextProps } from '@/shared/ui';

import { useMarkdownEnvValue } from './env';
import { Markdown } from './Markdown';
import { decodeEntities } from './parse/entities';
import { lexBlock } from './parse/lexer';
import type { RenderCtx } from './render/ctx';
import { plainText, renderInline } from './render/inline';

function Nested({ value }: { value: string }) {
    return <Markdown value={value} streaming={false} />;
}

type Flatten = (token: Token, ctx: RenderCtx, key: string) => ReactNode;

const inlineOf = (token: Token, ctx: RenderCtx, key: string): ReactNode[] =>
    renderInline((token as { tokens?: Token[] }).tokens ?? [], ctx, key);

const BLOCK: Record<string, Flatten> = {
    paragraph: inlineOf,
    text: (token, ctx, key) =>
        (token as Tokens.Text).tokens ? inlineOf(token, ctx, key) : decodeEntities((token as Tokens.Text).text),
    // Nested spans are React Native's own Text: they inherit the line's size
    // and ink, where the kit's Text would reset them to its variant.
    heading: (token, ctx, key) => (
        <Span key={key} style={ctx.env.styles.strong}>
            {inlineOf(token, ctx, key)}
        </Span>
    ),
    list: (token, ctx, key) =>
        (token as Tokens.List).items.map((item, i) => [
            i > 0 ? '\n' : '',
            '• ',
            ...flattenBlocks(item.tokens, ctx, `${key}.${i}`, ' '),
        ]),
    code: (token, ctx, key) => (
        <Span key={key} style={ctx.env.styles.codespan}>
            {(token as Tokens.Code).text}
        </Span>
    ),
    blockquote: (token, ctx, key) => flattenBlocks((token as Tokens.Blockquote).tokens, ctx, key, ' '),
    table: (token) =>
        [(token as Tokens.Table).header, ...(token as Tokens.Table).rows]
            .map((row) => row.map((cell) => plainText(cell.tokens)).join(' · '))
            .join('\n'),
    space: () => null,
    hr: () => null,
};

function flattenBlocks(tokens: readonly Token[], ctx: RenderCtx, prefix: string, joiner: string): ReactNode[] {
    const out: ReactNode[] = [];
    tokens.forEach((token, index) => {
        const render = BLOCK[token.type];
        const node = render ? render(token, ctx, `${prefix}.${index}`) : decodeEntities(token.raw.trim());
        if (node === null || node === '' || (Array.isArray(node) && node.length === 0)) return;
        if (out.length > 0) out.push(joiner);
        out.push(node);
    });
    return out;
}

export interface InlineMarkdownProps extends Omit<TextProps, 'children'> {
    value: string;
}

export function InlineMarkdown({ value, ...text }: InlineMarkdownProps) {
    const env = useMarkdownEnvValue(Nested);
    const nodes = useMemo(() => {
        const ctx: RenderCtx = { env, live: false, block: 0, lists: { ul: 0, ol: 0 } };
        return flattenBlocks(lexBlock(value), ctx, 'm', '\n');
    }, [value, env]);
    return <Text {...text}>{nodes}</Text>;
}
