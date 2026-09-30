/**
 * Block-by-block rendering must draw exactly what one pass over the whole
 * answer draws — it exists only so a streaming answer rebuilds its tail and
 * not everything above it. Each sample is rendered both ways and the host
 * trees compared (handlers and React keys aside, which a user cannot see).
 */

import { act, screen } from '@testing-library/react-native';
import { Lexer } from 'marked';
import React from 'react';
import { View } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { MarkdownEnvProvider, useMarkdownEnvValue } from './env';
import { Markdown } from './Markdown';
import { MarkdownBlock } from './MarkdownBlock';
import { splitBlocks } from './parse/lexer';
import { normalizeAnswer } from './parse/normalize';

function Nothing() {
    return null;
}

/** The whole answer as one block: what a single pass draws. */
function SinglePass({ value }: { value: string }) {
    const env = useMarkdownEnvValue(Nothing);
    return (
        <View testID="tree">
            <MarkdownEnvProvider value={env}>
                <View style={env.styles.root}>
                    <MarkdownBlock raw={normalizeAnswer(value)} env={env} index={0} live />
                </View>
            </MarkdownEnvProvider>
        </View>
    );
}

function Blocks({ value }: { value: string }) {
    return (
        <View testID="tree">
            <Markdown value={value} />
        </View>
    );
}

/**
 * The drawn tree as text: functions (handlers) drop out of JSON. Code is
 * highlighted after a debounce; with the clock faked and run once, both trees
 * are compared highlighted — never one before its timer and one after.
 */
async function drawn(ui: React.ReactElement): Promise<string> {
    await renderWithProviders(<ToastProvider>{ui}</ToastProvider>);
    await act(async () => {
        jest.runOnlyPendingTimers();
    });
    return JSON.stringify(screen.toJSON());
}

const ANSWER = [
    '# Plan',
    '',
    'Here is **the** plan, with `code` and a [link](https://example.com).',
    '',
    '1. First',
    '2. Second',
    '   - nested',
    '',
    '- loose item',
    '',
    '- another loose item',
    '',
    '> A quote',
    '> over two lines',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'Setext heading',
    '---',
    '',
    '***',
    '',
    'Last paragraph with _emphasis_ and ~~strike~~.',
].join('\n');

const SAMPLES = [
    '',
    'Just one line.',
    'Two\nlines in a paragraph.\n\nAnd another.',
    ANSWER,
    'See [the docs][ref] for more.\n\n[ref]: https://example.com/docs',
    '    indented code\n\nafter',
    'Paragraph\n    lazy continuation',
];

describe('splitBlocks', () => {
    it('cuts an answer into top-level blocks that join back to the answer', () => {
        const blocks = splitBlocks(ANSWER);
        expect(blocks.length).toBeGreaterThan(8);
        expect(blocks.join('')).toBe(ANSWER);
    });

    it.each(SAMPLES.map((s) => [s.slice(0, 24).replace(/\n/g, '⏎'), s]))(
        'cuts %j where a full lex (block and inline) does',
        (_label, value) => {
            const full = Lexer.lex(value, { gfm: true });
            const expected = Object.keys(full.links).length > 0 ? [value] : full.map((token) => token.raw);
            expect(splitBlocks(value)).toEqual(expected);
        },
    );

    it('keeps an answer with reference links whole, since they resolve across blocks', () => {
        const value = SAMPLES[4] as string;
        expect(splitBlocks(value)).toEqual([value]);
    });

    it('has nothing to render for an empty answer', () => {
        expect(splitBlocks('')).toEqual([]);
    });
});

describe('Markdown', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it.each(SAMPLES.map((s) => [s.slice(0, 24).replace(/\n/g, '⏎'), s]))(
        'draws %j exactly as a single pass does',
        async (_label, value) => {
            const before = await drawn(<SinglePass value={value as string} />);
            const after = await drawn(<Blocks value={value as string} />);
            expect(after).toEqual(before);
        },
    );

    it('draws every prefix of a streaming answer exactly as a single pass does', async () => {
        for (let end = 0; end <= ANSWER.length; end += 7) {
            const value = ANSWER.slice(0, end);
            const before = await drawn(<SinglePass value={value} />);
            const after = await drawn(<Blocks value={value} />);
            expect({ end, after }).toEqual({ end, after: before });
        }
    });

    it('compares code as highlighted, both ways', async () => {
        expect(await drawn(<Blocks value={ANSWER} />)).toContain('"color":"#ff7b72"');
    });

    it('renders at all', async () => {
        await renderWithProviders(
            <ToastProvider>
                <Markdown value="Hello **world**" />
            </ToastProvider>,
        );
        expect(screen.getByText('world')).toBeTruthy();
    });
});
