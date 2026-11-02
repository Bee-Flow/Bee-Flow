import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppPageHeader from './AppPageHeader';
import AppList from './AppList';
import TagChips from './TagChips';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import type { ReactElement } from 'react';

function withRuntime(ui: ReactElement) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }) };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const chipTexts = (c: HTMLElement) => [...c.querySelectorAll('[data-app-tags] > span')].map((e) => e.textContent);

describe('TagChips', () => {
    it.each([
        ['comma text', 'Daniel, Urgent'],
        ['JSON array string', '["Daniel","Urgent"]'],
        ['array', ['Daniel', 'Urgent']],
    ])('shows chips for %s', (_n, value) => {
        const { container } = render(<TagChips value={value} />);
        expect(chipTexts(container)).toEqual(['Daniel', 'Urgent']);
    });
    it.each([[null], [''], [[]], ['  '], [undefined]])('shows nothing for %j', (value) => {
        const { container } = render(<TagChips value={value} />);
        expect(container.querySelector('[data-app-tags]')).toBeNull();
    });
    it('caps visible chips and adds +N', () => {
        const { container } = render(<TagChips value="a,b,c,d,e" max={3} />);
        expect(chipTexts(container)).toEqual(['a', 'b', 'c', '+2']);
    });
});

describe.each(['plain', 'banner', 'hero', 'split'])('page_header tagsFrom, look %s', (look) => {
    const node = (tags: unknown) => ({
        id: 'cmp_ph', type: 'page_header', visible: true,
        props: { title: 'Subject', look, tagsFrom: { kind: 'static' as const, value: tags } },
        style: { span: 12, gap: 3, padding: 0 },
    });
    it('renders the chips', () => {
        const { container } = withRuntime(<AppPageHeader node={node('Daniel,Urgent')} />);
        expect(chipTexts(container)).toEqual(['Daniel', 'Urgent']);
    });
    it('renders none when empty', () => {
        const { container } = withRuntime(<AppPageHeader node={node(null)} />);
        expect(container.querySelector('[data-app-tags]')).toBeNull();
    });
});

describe('list tagsKey', () => {
    const node = (rows: unknown[]) => ({
        id: 'cmp_l', type: 'list', visible: true,
        props: { source: { kind: 'static' as const, value: rows }, titleKey: 'title', tagsKey: 'labels' },
        style: { span: 12 },
    });
    it('shows at most 3 chips per row plus +N, none for empty', () => {
        const { container } = withRuntime(
            <AppList node={node([{ title: 'A', labels: 'a,b,c,d,e' }, { title: 'B', labels: '["x"]' }, { title: 'C', labels: null }])} />,
        );
        const rows = [...container.querySelectorAll('[data-app-list-row]')];
        const texts = rows.map((r) => [...r.querySelectorAll('[data-app-tags] > span')].map((e) => e.textContent));
        expect(texts).toEqual([['a', 'b', 'c', '+2'], ['x'], []]);
    });
});
