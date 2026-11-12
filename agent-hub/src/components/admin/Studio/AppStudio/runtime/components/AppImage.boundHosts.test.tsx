import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderInRuntime } from '@/test/appRuntimeRender';
import { buildScope } from '../RuntimeContext';
import AppAvatar from './AppAvatar';
import AppImage from './AppImage';

// A bound picture (srcFrom) loads only from an asset of the app or a host the owner listed.
const USER = { id: 'u_1', name: 'Ada Lovelace', email: 'ada@example.org' };
const TRACKING = { kind: 'formula', expr: 'concat("https://x.test/p.png?e=", currentUser.email)' };

function show(type: 'image' | 'avatar', props: Record<string, unknown>, linkHosts: string[] | null = null) {
    const node = { id: `cmp_${type}`, type, visible: true, style: {}, props: { alt: 'Photo', name: 'Ada Lovelace', ...props } } as never;
    const ui = type === 'image' ? <AppImage node={node} /> : <AppAvatar node={node} />;
    return renderInRuntime(ui, { mode: 'run', linkHosts, scope: buildScope({ currentUser: USER, now: '2026-01-01T00:00:00.000Z' }) });
}

describe('a bound image source', () => {
    it('on a host nobody listed renders the placeholder and requests nothing', () => {
        for (const type of ['image', 'avatar'] as const) {
            const { container, unmount } = show(type, { src: 'https://example.test/fallback.png', srcFrom: TRACKING });
            expect(container.querySelector('img')).toBeNull();
            expect(container.innerHTML).not.toContain('ada@example.org');
            unmount();
        }
        const listedElsewhere = show('image', { srcFrom: TRACKING }, ['cdn.example.org']);
        expect(listedElsewhere.container.querySelector('img')).toBeNull();
    });

    it('on a host the owner listed loads', () => {
        const { container } = show('image', { srcFrom: { kind: 'static', value: 'https://X.test/p.png' } }, ['x.test']);
        expect(container.querySelector('img')).toHaveAttribute('src', 'https://X.test/p.png');
    });

    it('never with a port or credentials in the address', () => {
        for (const value of ['https://x.test:8443/p.png', 'https://u:p@x.test/p.png']) {
            const { container, unmount } = show('image', { srcFrom: { kind: 'static', value } }, ['x.test']);
            expect(container.querySelector('img')).toBeNull();
            unmount();
        }
    });

    it('an asset of the app needs no list; a literal src is unchanged', () => {
        const literal = show('image', { src: 'https://example.com/a.png' });
        expect(literal.container.querySelector('img')).toHaveAttribute('src', 'https://example.com/a.png');
        literal.unmount();
        const empty = show('image', { src: 'https://example.com/a.png', srcFrom: { kind: 'formula', expr: 'vars.none' } });
        expect(empty.container.querySelector('img')).toHaveAttribute('src', 'https://example.com/a.png');
        empty.unmount();
        render(<AppImage node={{ id: 'cmp_a', type: 'image', props: { alt: 'Logo', srcFrom: { kind: 'static', value: 'asset:abc' } }, style: {} } as never} />);
        expect(screen.getByRole('img', { name: 'Logo' })).toBeTruthy();
    });
});
