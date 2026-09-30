/**
 * Fence kinds, and their lockstep with the web's CodeRenderer
 * (agent-hub/src/components/renderers/MarkdownRenderer.jsx), which decides
 * the same thing with `language === '…'` tests.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { FENCE_LANGUAGES, fenceKind, fenceLanguage, isClosedFence } from './fences';
import { lexBlock } from './lexer';

const WEB = fs.readFileSync(`${AGENT_HUB_SRC}/components/renderers/MarkdownRenderer.jsx`, 'utf8');

describe('fence languages, in lockstep with the web', () => {
    const webNames = [...WEB.matchAll(/language === '([\w-]+)'/g)].map((m) => m[1]);
    const ours = Object.values(FENCE_LANGUAGES).flat();

    it('names exactly the languages the web tests for, in its order', () => {
        expect(ours).toEqual(webNames);
    });

    it.each(Object.entries(FENCE_LANGUAGES))('%s lists the web’s own names', (_kind, names) => {
        for (const name of names) expect(WEB).toContain(`language === '${name}'`);
    });
});

describe('fenceLanguage', () => {
    it('reads the first word of the info string, as react-markdown does', () => {
        expect(fenceLanguage('json-research')).toBe('json-research');
        expect(fenceLanguage('ts title="a.ts"')).toBe('ts');
        expect(fenceLanguage('c++')).toBe('c');
        expect(fenceLanguage(undefined)).toBe('');
        expect(fenceLanguage('')).toBe('');
    });

    it('maps each alias to its renderer, and everything else to code', () => {
        expect(fenceKind('vegalite')).toBe('vega-lite');
        expect(fenceKind('maps')).toBe('map');
        expect(fenceKind('research-json')).toBe('research');
        expect(fenceKind('python')).toBe('code');
        expect(fenceKind('')).toBe('code');
    });
});

describe('isClosedFence', () => {
    const raw = (value: string) => (lexBlock(value)[0] as { raw: string }).raw;

    it('sees a closed fence', () => {
        expect(isClosedFence(raw('```js\nx\n```'))).toBe(true);
        expect(isClosedFence(raw('~~~~\nx\n~~~~~\n'))).toBe(true);
    });

    it('sees one still arriving', () => {
        expect(isClosedFence(raw('```json\n{"a":'))).toBe(false);
        expect(isClosedFence(raw('```json'))).toBe(false);
        // A shorter run of backticks does not close a longer fence.
        expect(isClosedFence(raw('````\nx\n```'))).toBe(false);
    });

    it('counts an indented code block as complete', () => {
        expect(isClosedFence(raw('    indented'))).toBe(true);
    });
});
