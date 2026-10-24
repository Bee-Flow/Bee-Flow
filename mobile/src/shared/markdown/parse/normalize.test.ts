/**
 * The web's two pre-passes, ported. The patterns are the web's own (generated
 * copy of agent-hub's markdownRules.ts, under ../mirror); the web's
 * stripDirectiveBlocks is run beside the port below.
 */

import {
    normalizeAnswer,
    stripDirectiveBlocks,
    stripWrappingCodeBlock,
} from './normalize';
import { stripDirectiveBlocks as webStripDirectiveBlocks } from '../mirror/markdownRules';


describe('stripDirectiveBlocks, against the web', () => {
    it.each([':::writing Title\nBody\n:::', ':::note  A note\ntext\n\n:::', 'plain\n:::\n:::tip x', '::: not a directive'])(
        'gives the web’s answer for %j',
        (text) => {
            expect(stripDirectiveBlocks(text)).toBe(webStripDirectiveBlocks(text));
        },
    );
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
