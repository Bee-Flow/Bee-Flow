/**
 * Inline tokens as nested <Text>: a run of words, emphasis, code spans, links
 * and inline formulas inside one paragraph, heading, list item or table cell.
 *
 * A table from token type to renderer rather than a switch, so each rule is
 * one line and the dispatcher stays trivially simple. Anything marked emits
 * that is not listed renders its raw text: a new token type degrades to the
 * words the model wrote rather than to nothing.
 *
 * Raw HTML (`<b>`, `<span>`) is dropped, as the web's react-markdown drops it
 * without rehype-raw — except `<br>`, which models put in table cells to mean
 * exactly a line break.
 */

import type { Token, Tokens } from 'marked';
import React, { type ReactNode } from 'react';
import { Text } from 'react-native';

import type { RenderCtx } from './ctx';
import { decodeEntities } from '../parse/entities';
import type { MathToken } from '../parse/math';
import { InlineMath } from '../renderers/math/InlineMath';

type InlineRenderer = (token: Token, ctx: RenderCtx, key: string) => ReactNode;

const BR = /^<br\s*\/?>$/i;

function children(token: Token, ctx: RenderCtx, key: string): ReactNode {
    const inner = (token as { tokens?: Token[] }).tokens;
    return inner?.length ? renderInline(inner, ctx, key) : decodeEntities((token as { text?: string }).text ?? '');
}

const INLINE: Record<string, InlineRenderer> = {
    text: (token, ctx, key) => children(token, ctx, key),
    escape: (token) => (token as Tokens.Escape).text,
    strong: (token, ctx, key) => (
        <Text key={key} style={ctx.env.styles.strong}>
            {children(token, ctx, key)}
        </Text>
    ),
    em: (token, ctx, key) => (
        <Text key={key} style={ctx.env.styles.em}>
            {children(token, ctx, key)}
        </Text>
    ),
    del: (token, ctx, key) => (
        <Text key={key} style={ctx.env.styles.del}>
            {children(token, ctx, key)}
        </Text>
    ),
    codespan: (token, ctx, key) => (
        <Text key={key} style={ctx.env.styles.codespan}>
            {` ${(token as Tokens.Codespan).text} `}
        </Text>
    ),
    link: (token, ctx, key) => {
        const { href } = token as Tokens.Link;
        return (
            <Text key={key} accessibilityRole="link" style={ctx.env.styles.link} onPress={() => ctx.env.open(href)}>
                {children(token, ctx, key)}
            </Text>
        );
    },
    // Only reached where a picture cannot stand on its own line (a heading, a
    // table cell): its description stands in for it.
    image: (token, ctx, key) => (
        <Text key={key} style={ctx.env.styles.imageAlt}>
            {(token as Tokens.Image).text}
        </Text>
    ),
    br: () => '\n',
    html: (token) => (BR.test((token as Tokens.HTML).text.trim()) ? '\n' : null),
    inlineMath: (token, _ctx, key) => <InlineMath key={key} tex={(token as MathToken).text} />,
    checkbox: () => null,
};

export function renderInline(tokens: readonly Token[], ctx: RenderCtx, prefix = 'i'): ReactNode[] {
    return tokens.map((token, index) => {
        const key = `${prefix}.${index}`;
        const render = INLINE[token.type];
        return render ? render(token, ctx, key) : decodeEntities(token.raw);
    });
}

/** The words of some inline tokens, for an accessibility label or a heading slug. */
export function plainText(tokens: readonly Token[] | undefined): string {
    return (tokens ?? [])
        .map((token) => {
            const inner = (token as { tokens?: Token[] }).tokens;
            if (inner?.length) return plainText(inner);
            return decodeEntities((token as { text?: string }).text ?? '');
        })
        .join('');
}
