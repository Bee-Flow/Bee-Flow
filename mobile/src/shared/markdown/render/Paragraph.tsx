/**
 * A paragraph's inline tokens, cut into what can flow as text and what has to
 * stand on its own line: a picture, a linked picture, or a link the web draws
 * as a card (a webpage or document the model just built). Each run of text
 * becomes one selectable <Text>; the rest are blocks between them.
 */

import type { Token, Tokens } from 'marked';
import React, { type ReactNode } from 'react';
import { Text } from 'react-native';

import type { InlineStyle, RenderCtx } from './ctx';
import { plainText, renderInline } from './inline';
import { MarkdownImage } from '../renderers/image/MarkdownImage';
import { LinkCard } from '../renderers/links/LinkCard';
import { linkCardKind } from '../renderers/links/linkCards';

type Standalone = (token: Token, ctx: RenderCtx, key: string) => ReactNode | null;

/** The block a token stands for, or null when it flows with the text. */
const standalone: Standalone = (token, ctx, key) => {
    if (token.type === 'image') {
        const image = token as Tokens.Image;
        return <MarkdownImage key={key} href={image.href} alt={image.text} />;
    }
    if (token.type !== 'link') return null;
    const link = token as Tokens.Link;
    const only = link.tokens?.length === 1 ? link.tokens[0] : undefined;
    if (only?.type === 'image') {
        const image = only as Tokens.Image;
        return <MarkdownImage key={key} href={image.href} alt={image.text} onPress={() => ctx.env.open(link.href)} />;
    }
    const kind = linkCardKind(link.href);
    return kind ? <LinkCard key={key} kind={kind} href={link.href} label={plainText(link.tokens)} /> : null;
};

export function renderParagraph(tokens: readonly Token[], ctx: RenderCtx, key: string, style?: InlineStyle): ReactNode[] {
    const out: ReactNode[] = [];
    let run: Token[] = [];
    const flush = () => {
        // A run of nothing but spaces between two pictures is not a line.
        if (plainText(run).trim() !== '') {
            out.push(
                <Text key={`${key}.t${out.length}`} selectable style={[ctx.env.styles.text, ctx.quoted && ctx.env.styles.quoteText, style]}>
                    {renderInline(run, ctx, `${key}.${out.length}`)}
                </Text>,
            );
        }
        run = [];
    };
    tokens.forEach((token, i) => {
        const block = standalone(token, ctx, `${key}.b${i}`);
        if (!block) {
            run.push(token);
            return;
        }
        flush();
        out.push(block);
    });
    flush();
    return out;
}
