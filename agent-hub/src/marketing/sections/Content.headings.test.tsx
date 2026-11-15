/**
 * A Content block's headings follow the page outline: the block's first
 * heading is its h2, wherever it sits (a block that opens with an image in
 * the first column used to start at h3), and every other heading an h3. The
 * size stays tied to the position, by class, so nothing on the page grows.
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/Content.headings.test.tsx
 */
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Content from './Content';
import type { ContentBlockData } from './Content.types';

function block(columns: Array<Array<Record<string, unknown>>>): ContentBlockData {
    return {
        enabled: true,
        columnLayout: String(columns.length),
        columns: columns.map((elements, i) => ({ id: `col_${i}`, elements })),
    } as unknown as ContentBlockData;
}

const outline = (container: HTMLElement) => [...container.querySelectorAll('h1, h2, h3, h4')]
    .map((h) => `${h.tagName.toLowerCase()}:${h.textContent}`);

describe('Content headings', () => {
    it('makes the first heading the h2 when the first column holds only an image', () => {
        const { container } = render(<Content data={block([
            [{ id: 'img', kind: 'image', src: 'https://example.com/a.png', alt: '' }],
            [
                { id: 't1', kind: 'text', heading: 'Why it matters', body: '' },
                { id: 't2', kind: 'text', heading: 'How it works', body: '' },
            ],
        ])} />);
        expect(outline(container)).toEqual(['h2:Why it matters', 'h3:How it works']);
    });

    it('keeps the size on the position: only the first element of the first column is large', () => {
        const { container } = render(<Content data={block([
            [{ id: 'img', kind: 'image', src: 'https://example.com/a.png', alt: '' }],
            [{ id: 't1', kind: 'text', heading: 'Why it matters', body: '' }],
        ])} />);
        const h2 = container.querySelector('h2')!;
        expect(h2.className).toContain('content-el-heading--sub');
        expect(h2.className).not.toContain('content-el-heading--lead');
    });

    it('leaves a block that opens with text as it was: h2 large, h3 small', () => {
        const { container } = render(<Content data={block([[
            { id: 't1', kind: 'text', heading: 'First', body: '' },
            { id: 't2', kind: 'text', heading: 'Second', body: '' },
        ]])} />);
        expect(outline(container)).toEqual(['h2:First', 'h3:Second']);
        expect(container.querySelector('h2')!.className).toContain('content-el-heading--lead');
        expect(container.querySelector('h3')!.className).toContain('content-el-heading--sub');
    });
});
