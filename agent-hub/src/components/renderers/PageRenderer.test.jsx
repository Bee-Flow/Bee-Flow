/**
 * Characterisation of PageRenderer: one page definition that exercises every
 * element type of the renderer, pinned as DOM output, plus the button overlay.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));

import PageRenderer from './PageRenderer';

const PAGE = {
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

describe('PageRenderer', () => {
    it('renders every element type (DOM pinned)', () => {
        const { container } = render(<PageRenderer code={PAGE} />);
        expect(container.innerHTML).toMatchSnapshot();
    });

    it('accepts a JSON string', () => {
        render(<PageRenderer code={JSON.stringify({ type: 'text', text: 'hello' })} />);
        expect(screen.getByText('hello')).toBeTruthy();
    });

    it('shows an error for invalid JSON', () => {
        render(<PageRenderer code="{nope" />);
        expect(screen.getByText('Invalid page definition. Expected JSON format.')).toBeTruthy();
    });

    it('button click calls onAction and opens/closes the overlay', () => {
        const onAction = vi.fn();
        render(<PageRenderer code={PAGE} onAction={onAction} />);
        fireEvent.click(screen.getByText('Go'));
        expect(onAction).toHaveBeenCalledWith({ type: 'button', action: 'run', data: undefined });
        expect(screen.getByText('Overlay body')).toBeTruthy();
        expect(screen.getByText('Open Link →').getAttribute('href')).toBe('https://example.test/x');
        fireEvent.click(screen.getByText('Close'));
        expect(screen.queryByText('Overlay body')).toBeNull();
    });
});
