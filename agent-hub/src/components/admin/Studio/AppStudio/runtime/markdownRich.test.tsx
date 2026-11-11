import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/utils/helpers';
import AppMarkdown from './components/AppMarkdown';
import { DataProvider } from './DataContext';
import { parseRichBlocks } from './markdownRich';
import type { ComponentProps } from 'react';

type MarkdownNode = ComponentProps<typeof AppMarkdown>['node'];

/** `rich`: on, off, or 'absent' (the prop is not in the definition at all). */
type Rich = boolean | 'absent';

function node(content: string, rich: Rich): MarkdownNode {
    return { id: 'cmp_md000001', type: 'markdown', props: { content, ...(rich === 'absent' ? {} : { rich }) }, style: { span: 12 } } as MarkdownNode;
}

function mount(content: string, rich: Rich = true) {
    return render(<DataProvider appId="app_1"><AppMarkdown node={node(content, rich)} /></DataProvider>);
}

describe('rich markdown: what it draws', () => {
    it('a table with alignment, a header row and padded short rows', () => {
        const { container } = mount('| A | B | C |\n| :-- | :-: | --: |\n| 1 | 2 |\n| x | y | z |');
        const heads = [...container.querySelectorAll('th')];
        expect(heads.map((h) => h.textContent)).toEqual(['A', 'B', 'C']);
        expect(heads.map((h) => h.className)).toEqual([
            expect.stringContaining('text-left'), expect.stringContaining('text-center'), expect.stringContaining('text-right'),
        ]);
        const rows = [...container.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent));
        expect(rows).toEqual([['1', '2', ''], ['x', 'y', 'z']]);
    });

    it('a line with a pipe and no delimiter row stays a paragraph', () => {
        const { container } = mount('a | b\nplain');
        expect(container.querySelector('table')).toBeNull();
        expect(container.textContent).toBe('a | b plain');
    });

    it('task items get a read-only named checkbox, ordinary items none', () => {
        mount('- [x] done\n- [ ] open\n- plain');
        const boxes = screen.getAllByRole('checkbox');
        expect(boxes).toHaveLength(2);
        expect(boxes[0]).toBeChecked();
        expect(boxes[0]).toBeDisabled();
        expect(boxes[0]).toHaveAccessibleName('Done');
        expect(boxes[1]).not.toBeChecked();
        expect(boxes[1]).toHaveAccessibleName('Not done');
    });

    it('a quote holds blocks of its own, nested only a few levels deep', () => {
        const { container } = mount('> # Title\n> - one\n> - two\n>\n> > inner');
        const quote = container.querySelector('blockquote');
        expect(quote?.querySelector('h1')?.textContent).toBe('Title');
        expect(quote?.querySelectorAll('li')).toHaveLength(2);
        expect(quote?.querySelector('blockquote')?.textContent).toBe('inner');
        const deep = parseRichBlocks('>>>>>>>> far');
        let depth = 0;
        let at = deep[0];
        while (at && at.kind === 'quote') { depth += 1; at = at.blocks[0]; }
        expect(depth).toBe(4);
    });

    it('headings of every level and fenced code still render', () => {
        const { container } = mount('###### Six\n\n```js\nlet a = 1;\n```');
        expect(container.querySelector('h6')?.textContent).toBe('Six');
        expect(container.querySelector('pre code')?.textContent).toBe('let a = 1;');
    });

    it('links are http, https or mailto anchors that never keep the opener', () => {
        const { container } = mount('[web](https://example.com) [plain](http://example.com) [mail](mailto:a@example.com)');
        const anchors = [...container.querySelectorAll('a')];
        expect(anchors.map((a) => a.getAttribute('href'))).toEqual(['https://example.com', 'http://example.com', 'mailto:a@example.com']);
        for (const a of anchors) expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('a picture is an uploaded file of the app, resolved the way the image component resolves it', () => {
        mount('![Team photo](asset:img_1)');
        expect(screen.getByAltText('Team photo')).toHaveAttribute('src', `${API_BASE}/api/studio-apps/app_1/assets/img_1`);
    });
});

describe('rich markdown: nothing but text and the allowed elements ever reaches the page', () => {
    const HOSTILE = [
        '<script>window.__pwned = 1</script>',
        '<img src=x onerror="window.__pwned = 2">',
        '<a href="javascript:window.__pwned = 3" onclick="window.__pwned = 4">raw anchor</a>',
        '<iframe src="https://evil.example"></iframe><style>body{display:none}</style>',
        '[js](javascript:window.__pwned=5) [JS](  JaVaScRiPt:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:x) [file](file:///etc/passwd) [rel](//evil.example) [blob](blob:https://x/y)',
        '![remote](https://evil.example/p.png) ![js](javascript:alert(1)) ![data](data:image/png;base64,AAAA) ![rel](/api/secret) ![dots](asset:../x) ![long](asset:' + 'a'.repeat(65) + ')',
        '| <img src=x onerror=alert(1)> | b |\n| --- | --- |\n| <script>x</script> | [x](javascript:y) |',
        '> <b onmouseover=alert(1)>nested **markup** <script>x</script></b>',
        '- [x] <input autofocus onfocus=alert(1)>',
        '`<script>x</script>`\n\n```\n<script>x</script>\n```',
    ].join('\n\n');

    it('no script, frame, style, handler attribute or foreign element is created', () => {
        const { container } = mount(HOSTILE);
        expect(container.querySelector('script, iframe, style, object, embed, form, svg, link, meta, base')).toBeNull();
        expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
        for (const el of container.querySelectorAll('*')) {
            for (const attr of el.getAttributeNames()) {
                expect(attr.startsWith('on'), `${el.tagName} has ${attr}`).toBe(false);
            }
        }
        // The only <input>s are the checkbox the task list draws itself.
        for (const input of container.querySelectorAll('input')) {
            expect(input.getAttribute('type')).toBe('checkbox');
            expect(input).toBeDisabled();
            expect(input.hasAttribute('autofocus')).toBe(false);
        }
    });

    it('every anchor goes to http, https or mailto, and every picture to the app asset route', () => {
        const { container } = mount(HOSTILE);
        for (const a of container.querySelectorAll('a')) {
            expect(a.getAttribute('href')).toMatch(/^(https?:\/\/|mailto:)/i);
            expect(a).toHaveAttribute('rel', 'noopener noreferrer');
        }
        for (const img of container.querySelectorAll('img')) {
            expect(img.getAttribute('src')).toContain('/api/studio-apps/app_1/assets/');
        }
    });

    it('the markup is shown as text', () => {
        const { container } = mount(HOSTILE);
        expect(container.textContent).toContain('<script>window.__pwned = 1</script>');
        expect(container.textContent).toContain('<img src=x onerror="window.__pwned = 2">');
        expect(container.textContent).toContain('[js](javascript:window.__pwned=5)');
    });

    it('a picture whose source is not an uploaded file is not drawn as a picture', () => {
        const { container } = mount('![a](https://evil.example/p.png) ![b](data:image/png;base64,AAAA) ![c](/api/x) ![d](asset:)');
        expect(container.querySelectorAll('img')).toHaveLength(0);
    });
});

describe('rich is opt-in', () => {
    const TEXT = '| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n> quote\n\n![p](asset:img_1)';

    it('without the prop, and with it false, the block is the plain renderer', () => {
        for (const rich of ['absent', false] as const) {
            const { container, unmount } = mount(TEXT, rich);
            expect(container.querySelector('table, blockquote, img, input')).toBeNull();
            expect(container.textContent).toContain('| a | b |');
            expect(container.textContent).toContain('![p](asset:img_1)');
            unmount();
        }
    });

    it('a mailto link is not a link in a plain block', () => {
        const { container } = mount('[mail](mailto:a@example.com)', 'absent');
        expect(container.querySelector('a')).toBeNull();
    });
});
