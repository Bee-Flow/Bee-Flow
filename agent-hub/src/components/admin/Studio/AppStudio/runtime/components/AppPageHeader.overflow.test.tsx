import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppPageHeader from './AppPageHeader';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * The header must not starve its own title.
 *
 * `flex-wrap shrink-0` on the action row is a contradiction: `shrink-0` sizes
 * the row to max-content and refuses to yield width, and a box never asked to
 * be narrower than its content never wraps. Every pixel of deficit therefore
 * landed on the title column, and a five-button header rendered "Projectr…"
 * and "Verwerken m…".
 *
 * jsdom has no layout, so these assert the CONTRACT that produces the layout
 * rather than the pixels — which is also what keeps them stable.
 */

const LONG_TITLE = 'Projectregels voor deze aanvraag, inclusief nabewerkingen';
const LONG_SUBTITLE = 'Kies een bestand om het te bekijken of samen te vatten. '
    + 'Lees als projectregels werkt op het gekozen bestand, of op alle bestanden als er niets gekozen is.';

function node(props: Record<string, unknown> = {}) {
    return {
        id: 'cmp_h', type: 'page_header',
        props: { title: LONG_TITLE, subtitle: LONG_SUBTITLE, ...props },
        style: { span: 12 },
    };
}

function renderHeader(n: ReturnType<typeof node>, kids = 5) {
    return render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run' }}>
            <AppPageHeader node={n}>
                {Array.from({ length: kids }, (_, i) => <button key={i} type="button">Action {i}</button>)}
            </AppPageHeader>
        </RuntimeProvider>,
    );
}

describe.each(['plain', 'split'])('AppPageHeader (%s) under a crowded action row', (look) => {
    const props = look === 'plain' ? {} : { look };

    it('lets the action row shrink so it can wrap', () => {
        const { container } = renderHeader(node(props));
        const actions = container.querySelector('[data-app-pageheader-actions]');
        expect(actions).toBeTruthy();
        expect(actions!.className).toContain('flex-wrap');
        expect(actions!.className).not.toContain('shrink-0');
    });

    it('wraps the header row itself rather than crushing one child', () => {
        const { container } = renderHeader(node(props));
        const row = container.querySelector('[data-app-pageheader] > div');
        expect(row!.className).toContain('flex-wrap');
    });

    it('exposes a clipped title and subtitle on hover', () => {
        const { container } = renderHeader(node(props));
        expect(container.querySelector('h1')!.getAttribute('title')).toBe(LONG_TITLE);
        expect(container.querySelector('p')!.getAttribute('title')).toBe(LONG_SUBTITLE);
    });

    it('gives the subtitle two lines instead of one truncated one', () => {
        const { container } = renderHeader(node(props));
        expect(container.querySelector('p')!.className).toContain('line-clamp-2');
    });
});

describe('AppPageHeader title floor', () => {
    it('reserves a readable width for the title column', () => {
        const { container } = renderHeader(node());
        const col = container.querySelector('h1')!.parentElement;
        expect(col!.className).toContain('flex-1');
        expect(col!.className).toContain('basis-');
    });

    it('still has no action container when there are no children', () => {
        const { container } = renderHeader(node(), 0);
        expect(container.querySelector('[data-app-pageheader-actions]')).toBeNull();
    });
});
