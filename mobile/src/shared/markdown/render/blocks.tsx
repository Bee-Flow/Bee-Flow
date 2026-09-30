/**
 * Block tokens to React Native: paragraphs, headings, code and the rich
 * fences, quotes, lists, tables, rules and display formulas. One entry per
 * token type; a type that is not listed (and raw HTML, which the web's
 * react-markdown drops too) renders nothing.
 */

import type { Token, Tokens } from 'marked';
import React, { type ReactNode } from 'react';
import { View } from 'react-native';

import type { RenderCtx } from './ctx';
import { Heading } from './Heading';
import { List } from './List';
import { renderParagraph } from './Paragraph';
import type { MathToken } from '../parse/math';
import { FenceBlock } from '../renderers/FenceBlock';
import { MathBlock } from '../renderers/math/MathBlock';
import { MarkdownTable } from '../renderers/table/MarkdownTable';

type BlockRenderer = (token: Token, ctx: RenderCtx, key: string, index: number) => ReactNode | ReactNode[];

const tokensOf = (token: Token): Token[] => (token as { tokens?: Token[] }).tokens ?? [];

const BLOCKS: Record<string, BlockRenderer> = {
    paragraph: (token, ctx, key) => renderParagraph(tokensOf(token), ctx, key),
    // A tight list item's words arrive as a `text` token holding the inline ones.
    text: (token, ctx, key) => renderParagraph(tokensOf(token).length ? tokensOf(token) : [token], ctx, key),
    heading: (token, ctx, key, index) => (
        <Heading
            key={key}
            anchorKey={key}
            order={ctx.block * 1000 + index}
            depth={(token as Tokens.Heading).depth}
            tokens={tokensOf(token)}
            ctx={ctx}
        />
    ),
    code: (token, ctx, key) => {
        const code = token as Tokens.Code;
        return <FenceBlock key={key} raw={code.raw} info={code.lang} text={code.text} live={ctx.live} />;
    },
    blockquote: (token, ctx, key) => (
        <View key={key} style={ctx.env.styles.blockquote}>
            {renderBlocks(tokensOf(token), { ...ctx, quoted: true }, key)}
        </View>
    ),
    list: (token, ctx, key) => <List key={key} token={token as Tokens.List} ctx={ctx} renderBlocks={renderBlocks} />,
    table: (token, ctx, key) => <MarkdownTable key={key} token={token as Tokens.Table} ctx={ctx} />,
    hr: (_token, ctx, key) => <View key={key} style={ctx.env.styles.hr} />,
    blockMath: (token, ctx, key) => {
        const math = token as MathToken;
        return <MathBlock key={key} tex={math.text} pending={ctx.live && math.closed === false} />;
    },
};

export function renderBlocks(tokens: readonly Token[], ctx: RenderCtx, prefix: string): ReactNode[] {
    return tokens.flatMap((token, index) => {
        const render = BLOCKS[token.type];
        return render ? render(token, ctx, `${prefix}.${index}`, index) : [];
    });
}
