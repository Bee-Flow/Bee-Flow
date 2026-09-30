/**
 * The web's two pre-passes, ported. Textual lockstep: each pattern here must
 * appear verbatim in agent-hub's MarkdownRenderer.jsx, so a change there fails
 * this test instead of drifting.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import {
    DIRECTIVE_CLOSE,
    DIRECTIVE_OPEN,
    normalizeAnswer,
    stripDirectiveBlocks,
    stripWrappingCodeBlock,
    WRAPPING_FENCE_CLOSE,
    WRAPPING_FENCE_OPEN,
} from './normalize';

const WEB = fs.readFileSync(`${AGENT_HUB_SRC}/components/renderers/MarkdownRenderer.jsx`, 'utf8');

describe('lockstep with the web', () => {
    it.each([
        ['WRAPPING_FENCE_OPEN', WRAPPING_FENCE_OPEN],
        ['WRAPPING_FENCE_CLOSE', WRAPPING_FENCE_CLOSE],
        ['DIRECTIVE_OPEN', DIRECTIVE_OPEN],
        ['DIRECTIVE_CLOSE', DIRECTIVE_CLOSE],
    ])('%s is the web’s own pattern', (_name, pattern) => {
        expect(WEB).toContain(String(pattern));
    });

    it('replaces a directive with the same heading level', () => {
        expect(WEB).toContain(`${String(DIRECTIVE_OPEN)}, '## $2')`);
    });
});

describe('stripWrappingCodeBlock', () => {
    it('unwraps an answer the model fenced as Markdown', () => {
        expect(stripWrappingCodeBlock('```markdown\n# Title\n\nBody\n```')).toBe('# Title\n\nBody');
        expect(stripWrappingCodeBlock('  ```md\nx\n```  ')).toBe('x');
    });

    it('drops the opening fence while the closing one is still streaming in', () => {
        expect(stripWrappingCodeBlock('```markdown\n# Tit')).toBe('# Tit');
    });

    it('leaves an answer that only contains a fence alone', () => {
        const value = 'Here:\n\n```js\nx\n```\n\nDone.';
        expect(stripWrappingCodeBlock(value)).toBe(value);
    });

    it('keeps the closing fence of an answer that merely ends in a code block', () => {
        // The web strips it too; see the function's note on why the phone does not.
        const value = 'Here:\n\n```js\nx\n```';
        expect(stripWrappingCodeBlock(value)).toBe(value);
    });
});

describe('stripDirectiveBlocks', () => {
    it('turns a directive into a heading and drops its closing line', () => {
        expect(stripDirectiveBlocks(':::writing Draft reply\nHello\n:::')).toBe('## Draft reply\nHello\n');
        expect(stripDirectiveBlocks(':::note\tMind this\n:::  ')).toBe('## Mind this\n');
    });

    it('leaves unknown directives and inline colons alone', () => {
        expect(stripDirectiveBlocks(':::custom Title')).toBe(':::custom Title');
        expect(stripDirectiveBlocks('ratio 1:::2')).toBe('ratio 1:::2');
    });
});

it('normalizeAnswer runs both passes', () => {
    expect(normalizeAnswer('```markdown\n:::tip Faster\nUse the cache.\n:::\n```')).toBe('## Faster\nUse the cache.\n');
});
