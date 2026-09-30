/**
 * Markdown as the web's MarkdownRenderer draws it, natively: GFM, TeX,
 * highlighted code with Copy and folding, tables, pictures that open full
 * screen, cards for the webpages and documents an answer links to, and the
 * rich fences — research reports, test reports, pages, Vega-Lite charts,
 * Mermaid flowcharts and maps — as native views. No WebView anywhere.
 *
 * The answer is first normalised as the web does (parse/normalize.ts), then
 * cut into top-level blocks (parse/lexer.ts) that render one by one
 * (MarkdownBlock), each memoised on its own source. A streaming answer grows
 * only at its tail, so a flush re-lexes and re-renders the last block alone.
 *
 * `streaming`: say `false` once an answer is complete. Until then the last
 * block counts as still arriving, so a rich fence that has not closed shows
 * the web's "Building…" placeholder instead of half a JSON document. Left
 * out, the tail is assumed live — right for a stream, harmless for stored
 * text, whose fences are closed.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';

import { MarkdownEnvProvider, useMarkdownEnvValue } from './env';
import { MarkdownBlock } from './MarkdownBlock';
import { splitBlocks } from './parse/lexer';
import { normalizeAnswer } from './parse/normalize';

/** Markdown inside a rich block (a research section, a report's notes): complete by definition. */
function Nested({ value }: { value: string }) {
    return <Markdown value={value} streaming={false} />;
}

export function Markdown({ value, streaming }: { value: string; streaming?: boolean }) {
    const env = useMarkdownEnvValue(Nested);
    const blocks = useMemo(() => splitBlocks(normalizeAnswer(value)), [value]);
    const last = blocks.length - 1;

    return (
        <MarkdownEnvProvider value={env}>
            <View style={env.styles.root}>
                {blocks.map((raw, index) => (
                    // By position, not by text: the tail block keeps its place as
                    // it grows, and two identical paragraphs are still two blocks.
                    <MarkdownBlock key={index} raw={raw} env={env} index={index} live={streaming !== false && index === last} />
                ))}
            </View>
        </MarkdownEnvProvider>
    );
}
