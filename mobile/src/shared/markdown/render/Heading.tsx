/**
 * A heading, at the web's sizes (styles.ts headingSize) and weight 600,
 * marked as a header for TalkBack, and registered with its answer's anchors
 * under the web's slug so a `#fragment` link in the same answer can find it.
 */

import type { Token } from 'marked';
import React, { useEffect, useRef, type ReactNode } from 'react';
import { Text, View, type TextStyle } from 'react-native';

import { headingSlug } from '../parse/slug';
import { headingSize } from '../styles';
import type { RenderCtx } from './ctx';
import { plainText, renderInline } from './inline';

function sizeStyle(depth: number): TextStyle {
    const fontSize = headingSize(depth);
    return { fontSize, lineHeight: Math.round(fontSize * 1.3) };
}

interface HeadingProps {
    /** Unique within the answer: the heading's render key. */
    anchorKey: string;
    /** Where it stands in the answer, for the fuzzy `#fragment` match. */
    order: number;
    depth: number;
    tokens: Token[];
    ctx: RenderCtx;
}

export function Heading({ anchorKey, order, depth, tokens, ctx }: HeadingProps) {
    const view = useRef<View>(null);
    const text = plainText(tokens);
    const { anchors } = ctx.env;

    useEffect(() => {
        anchors.set(anchorKey, { slug: headingSlug(text), text, order, view: view.current });
        return () => anchors.delete(anchorKey);
    }, [anchors, anchorKey, text, order]);

    const children: ReactNode = renderInline(tokens, ctx, anchorKey);
    return (
        <View ref={view} collapsable={false}>
            <Text selectable accessibilityRole="header" style={[ctx.env.styles.text, ctx.env.styles.heading, sizeStyle(depth)]}>
                {children}
            </Text>
        </View>
    );
}
