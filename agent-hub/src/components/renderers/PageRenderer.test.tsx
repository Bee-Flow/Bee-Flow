/**
 * Characterisation of PageRenderer: one page definition that exercises every
 * element type of the renderer, pinned as DOM output, plus the button overlay.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

import PageRenderer from './PageRenderer';

const PAGE: Record<string, unknown> = {
    type: 'page',
    id: 'root',
    title: 'Dashboard',
    children: [
        { type: 'grid', columns: 3, gap: 8, children: [{ type: 'text', text: 'in grid' }] },
        { type: 'row', align: 'center', justify: 'space-between', children: [{ type: 'badge', text: 'ok', variant: 'success' }] },
        { type: 'columns', children: [{ type: 'badge', text: 'plain' }] },
        { type: 'section', title: 'Sec', children: [{ type: 'paragraph', content: 'para' }, 'raw child'] },
        { type: 'card', title: 'Card', children: [{ type: 'divider' }] },
        { type: 'heading', level: 3, text: 'H3' },
        { type: 'heading', text: 'H2 default' },
        { type: 'image', src: 'https://example.test/a.png', alt: 'pic', height: 100, fit: 'contain' },
        { type: 'list', ordered: true, items: ['one', { type: 'text', text: 'two' }] },
        { type: 'list', items: ['bullet'] },
        { type: 'button', text: 'Go', variant: 'secondary', action: 'run', overlay: 'Overlay body', url: 'https://example.test/x' },
        { type: 'tabs', tabs: [{ label: 'T1', children: [{ type: 'text', text: 'tab one body' }] }, { label: 'T2' }] },
        { type: 'accordion', items: [{ title: 'A1', content: 'acc content' }, { title: 'A2', children: [{ type: 'text', text: 'acc child' }] }] },
        { type: 'table', columns: ['c1', { label: 'c2' }], rows: [['a', 'b'], { x: 'c', y: 'd' }] },
        { type: 'stat', value: 42, label: 'Users', color: 'green', change: -5 },
        { type: 'stat', value: 1, label: 'Plain', change: 3 },
        { type: 'chart', title: 'Chart', data: [{ label: 'a', value: 5 }, { label: 'b', value: 10, color: 'red' }] },
        { type: 'unknown', text: 'fallback text' },
        { type: 'unknown-empty' },
        null,
    ],
};

function mount(def: unknown) {
    return render(<PageRenderer code={def} onAction={undefined} />);
}

/** Render a definition the renderer cannot handle: it throws, and React logs the error. */
function mountThrows(def: unknown) {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
        expect(() => mount(def)).toThrow();
    } finally {
        quiet.mockRestore();
    }
}

describe('PageRenderer', () => {
    it('renders every element type (DOM pinned)', () => {
        const { container } = render(<PageRenderer code={PAGE} onAction={undefined} />);
        expect(container.innerHTML).toMatchSnapshot();
    });

    it('accepts a JSON string', () => {
        render(<PageRenderer code={JSON.stringify({ type: 'text', text: 'hello' })} onAction={undefined} />);
        expect(screen.getByText('hello')).toBeTruthy();
    });

    it('shows an error for invalid JSON', () => {
        render(<PageRenderer code="{nope" onAction={undefined} />);
        expect(screen.getByText('Invalid page definition. Expected JSON format.')).toBeTruthy();
    });

    it('button click calls onAction and opens/closes the overlay', async () => {
        const user = userEvent.setup();
        const onAction = vi.fn();
        render(<PageRenderer code={PAGE} onAction={onAction} />);
        await user.click(screen.getByText('Go'));
        expect(onAction).toHaveBeenCalledWith({ type: 'button', action: 'run', data: undefined });
        expect(screen.getByText('Overlay body')).toBeTruthy();
        expect(screen.getByText('Open Link →').getAttribute('href')).toBe('https://example.test/x');
        await user.click(screen.getByText('Close'));
        expect(screen.queryByText('Overlay body')).toBeNull();
    });

    describe('malformed definitions behave as they always did', () => {
        it('throws on chart data that is not an array, or holds null', () => {
            mountThrows({ type: 'chart', data: { a: 1 } });
            mountThrows({ type: 'chart', data: 'abc' });
            mountThrows({ type: 'chart', data: [null, { label: 'x', value: 1 }] });
        });

        it('draws a chart row for a primitive bar', () => {
            const { container } = mount({ type: 'chart', data: [5] });
            expect(container.querySelectorAll('div[style*="flex: 1"]').length).toBe(1);
        });

        it('shows array titles and contents of an accordion item', () => {
            mount({ type: 'accordion', items: [{ title: ['T', 'x'], content: ['a', 'b'] }] });
            expect(screen.getByText('Tx')).toBeTruthy();
            expect(screen.getByText('ab')).toBeTruthy();
        });

        it('does not show the children of an accordion item whose content is true', () => {
            mount({ type: 'accordion', items: [{ title: 'Q', content: true, children: [{ type: 'text', text: 'hidden child' }] }] });
            expect(screen.queryByText('hidden child')).toBeNull();
        });

        it('throws on an accordion item that is null or has an object title', () => {
            mountThrows({ type: 'accordion', items: [null] });
            mountThrows({ type: 'accordion', items: [{ title: { a: 1 } }] });
        });

        it('throws on table columns that are not an array', () => {
            mountThrows({ type: 'table', columns: 3 });
        });

        it('treats a type that is an array as an unknown type', () => {
            mount({ type: ['page'], title: 'not a page', text: 'fallback body' });
            expect(screen.getByText('fallback body')).toBeTruthy();
            expect(screen.queryByText('not a page')).toBeNull();
        });
    });
});
