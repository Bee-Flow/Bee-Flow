import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderInRuntime } from '@/test/appRuntimeRender';
import { declaredParts, renderedParts } from '@/test/appPartsRendered';
import { buildScope } from '../RuntimeContext';
import AppAvatar, { initialsOf } from './AppAvatar';

const IMG = 'https://example.test/ada.png';

const view = (props: Record<string, unknown> = {}, vars: Record<string, unknown> = {}) => {
    const node = { id: 'cmp_avatar', type: 'avatar', visible: true, style: {}, props };
    return renderInRuntime(<AppAvatar node={node as never} />, { mode: 'run', scope: buildScope({ vars, now: '2026-01-01T00:00:00.000Z' }) });
};

describe('initialsOf', () => {
    it('takes the first letter of the first and of the last word, upper-cased', () => {
        expect(initialsOf('ada lovelace')).toBe('AL');
        expect(initialsOf('  Grace   Brewster Murray Hopper ')).toBe('GH');
        expect(initialsOf('Plato')).toBe('P');
        expect(initialsOf('   ')).toBe('');
        expect(initialsOf('émile zola')).toBe('ÉZ');
    });
});

describe('AppAvatar', () => {
    it('draws the picture of an https URL, named by the name', () => {
        const { getByRole, container } = view({ src: IMG, name: 'Ada Lovelace' });
        expect(getByRole('img', { name: 'Ada Lovelace' })).toBeTruthy();
        expect(container.querySelector('img')!.getAttribute('src')).toBe(IMG);
        expect(container.querySelector('.bfa-avatar__initials')).toBeNull();
    });

    it('falls back to the initials without a picture, and when the picture fails to load', () => {
        const none = view({ name: 'Ada Lovelace' });
        expect(none.container.querySelector('.bfa-avatar__initials')!.textContent).toBe('AL');
        expect(none.container.querySelector('img')).toBeNull();
        none.unmount();
        const broken = view({ src: IMG, name: 'Ada Lovelace' });
        fireEvent.error(broken.container.querySelector('img')!);
        expect(broken.container.querySelector('.bfa-avatar__initials')!.textContent).toBe('AL');
    });

    it('accepts only an https URL or an asset reference as a picture', () => {
        const { container } = view({ src: 'http://example.test/a.png', name: 'Ada' });
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('.bfa-avatar__initials')!.textContent).toBe('A');
    });

    it('takes the picture and the name from bindings first, and keeps src and name as the fallback', () => {
        const bound = view(
            { src: 'https://example.test/old.png', name: 'Old Name', srcFrom: { kind: 'formula', expr: 'vars.row.photo' }, nameFrom: { kind: 'formula', expr: 'vars.row.full' } },
            { row: { photo: IMG, full: 'Grace Hopper' } },
        );
        expect(bound.container.querySelector('img')!.getAttribute('src')).toBe(IMG);
        expect(bound.getByRole('img', { name: 'Grace Hopper' })).toBeTruthy();
        bound.unmount();
        const empty = view({ src: IMG, name: 'Kept', srcFrom: { kind: 'formula', expr: 'vars.row.photo' }, nameFrom: { kind: 'formula', expr: 'vars.row.full' } }, { row: { photo: null, full: '' } });
        expect(empty.container.querySelector('img')!.getAttribute('src')).toBe(IMG);
        expect(empty.getByRole('img', { name: 'Kept' })).toBeTruthy();
    });

    it('shows a person icon and a generic name when there is neither picture nor name', () => {
        const { getByRole, container } = view({});
        expect(getByRole('img', { name: 'Avatar' })).toBeTruthy();
        expect(container.querySelector('.bfa-avatar__initials svg')).toBeTruthy();
    });

    it('sizes by the size prop', () => {
        expect(view({ size: 'lg' }).getByRole('img').className).toContain('w-16');
    });

    it('renders exactly the parts its spec declares across its two states', () => {
        const withPicture = view({ src: IMG, name: 'Ada' });
        const picture = renderedParts('avatar', withPicture.container);
        withPicture.unmount();
        const withInitials = view({ name: 'Ada' });
        const initials = renderedParts('avatar', withInitials.container);
        expect([...new Set([...picture, ...initials])].sort()).toEqual(declaredParts('avatar'));
    });
});
