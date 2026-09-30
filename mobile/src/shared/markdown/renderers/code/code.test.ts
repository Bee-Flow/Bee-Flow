/**
 * The code block's languages, colours and highlighting, held to the web:
 * the grammars MarkdownRenderer.jsx registers (under the same names), its
 * header labels, its panel colours, and highlight.js's GitHub Dark theme read
 * from the stylesheet the web imports.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { CODE_PANEL, GITHUB_DARK, paintedScope } from './codeTheme';
import { htmlToRuns, scopeKey } from './hljsHtml';
import { GRAMMAR_OF, isCompactSnippet, LANGUAGE_LABELS, languageLabel } from './languages';
import { highlightDelay, highlightRuns } from './useHighlight';

const WEB = fs.readFileSync(`${AGENT_HUB_SRC}/components/renderers/MarkdownRenderer.jsx`, 'utf8');
const MOBILE = path.resolve(__dirname, '../../../../..');
const GITHUB_DARK_CSS = fs.readFileSync(path.join(MOBILE, 'node_modules/highlight.js/styles/github-dark.css'), 'utf8');

describe('lockstep with the web', () => {
    it('registers every language the web registers, under the same grammar', () => {
        const imports = new Map([...WEB.matchAll(/^import (\w+) from 'highlight\.js\/lib\/languages\/(\w+)';$/gm)].map((m) => [m[1], m[2]]));
        const registered = [...WEB.matchAll(/hljs\.registerLanguage\('([\w-]+)', (\w+)\)/g)].map((m) => [m[1], imports.get(m[2] as string)]);
        expect(Object.entries(GRAMMAR_OF)).toEqual(registered);
    });

    it('labels languages as the web’s header does', () => {
        const table = /const langLabels = \{([\s\S]*?)\};/.exec(WEB)?.[1] ?? '';
        const labels = Object.fromEntries([...table.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
        expect(LANGUAGE_LABELS).toEqual(labels);
    });

    it('paints the web’s panel', () => {
        for (const colour of [CODE_PANEL.background, CODE_PANEL.headerText, CODE_PANEL.copied]) expect(WEB).toContain(`'${colour}'`);
        expect(WEB).toContain(`background: '${CODE_PANEL.headerBackground}'`);
        expect(WEB).toContain(`borderBottom: '1px solid ${CODE_PANEL.headerBorder}'`);
        expect(WEB).toContain("import 'highlight.js/styles/github-dark.min.css';");
    });

    it('colours every scope as github-dark.css does', () => {
        const rules = [...GITHUB_DARK_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)];
        let checked = 0;
        for (const [, selectors, body] of rules) {
            const color = /(?:^|[\s;])color:\s*(#[0-9a-f]{6})/i.exec(body as string)?.[1];
            if (!color) continue;
            for (const raw of (selectors as string).split(',').map((s) => s.trim())) {
                const simple = /^\.hljs-([\w-]+)((?:\.[\w-]+)*)$/.exec(raw);
                if (!simple) continue;
                const key = `${simple[1]}${simple[2]}`;
                expect({ key, color: GITHUB_DARK[key]?.color }).toEqual({ key, color });
                checked += 1;
            }
        }
        expect(checked).toBe(Object.keys(GITHUB_DARK).length);
        expect(GITHUB_DARK_CSS).toContain(`color: ${CODE_PANEL.text}`);
    });
});

describe('languages', () => {
    it('names a language as the header shows it', () => {
        expect(languageLabel('ts')).toBe('TypeScript');
        expect(languageLabel('Dockerfile')).toBe('Dockerfile');
        expect(languageLabel('elixir')).toBe('Elixir');
        expect(languageLabel('')).toBe('');
    });

    it('treats one or two unlabelled lines as the compact chip', () => {
        expect(isCompactSnippet('npm i', '')).toBe(true);
        expect(isCompactSnippet('a\nb', '')).toBe(true);
        expect(isCompactSnippet('a\nb\nc', '')).toBe(false);
        expect(isCompactSnippet('x', 'js')).toBe(false);
    });
});

describe('highlighting', () => {
    it('reads hljs’s HTML into runs, inner spans winning and entities decoded', () => {
        const runs = htmlToRuns('<span class="hljs-string">&quot;a<span class="hljs-subst">${b}</span>&quot;</span> &amp;&amp; x', paintedScope);
        expect(runs).toEqual([
            { text: '"a', scope: 'string' },
            { text: '${b}', scope: 'subst' },
            { text: '"', scope: 'string' },
            { text: ' && x', scope: null },
        ]);
    });

    it('keys compound scopes and falls back to their base', () => {
        expect(scopeKey('hljs-title function_')).toBe('title.function_');
        expect(paintedScope('title.function_')).toBe('title.function_');
        expect(paintedScope('title.unknown_')).toBe('title');
        expect(paintedScope('params')).toBeNull();
    });

    it('highlights the web’s languages, and auto-detects an unlabelled block', () => {
        const ts = highlightRuns('const x: number = 1;', 'ts') ?? [];
        expect(ts).toContainEqual({ text: 'const', scope: 'keyword' });
        const py = highlightRuns('def greet(name):\n    return f"hi {name}"', 'python') ?? [];
        expect(py).toContainEqual({ text: 'def', scope: 'keyword' });
        expect(highlightRuns('SELECT id, name FROM users WHERE active = 1 ORDER BY name;', '')).toContainEqual({ text: 'SELECT', scope: 'keyword' });
        expect(highlightRuns('x', 'no-such-language')).not.toBeNull();
    });

    it('waits longer before highlighting a long block', () => {
        expect(highlightDelay('x')).toBe(150);
        expect(highlightDelay('x'.repeat(1001))).toBe(300);
    });
});
