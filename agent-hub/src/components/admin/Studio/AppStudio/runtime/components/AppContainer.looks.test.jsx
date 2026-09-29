import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppContainer from './AppContainer';

/**
 * AppContainer — the look pass (props.look, spec componentSpecs.js).
 * 'plain' (or absent/unknown) is the identity: the exact pre-look class string
 * and only the original style keys. The chrome (background/border/padding) of
 * the other looks lives inline on the container's own grid, all token-derived.
 * (The pre-look behaviour itself is pinned in v21Static.test.jsx — this file
 * only owns the look additions, so parallel work on that shared file stays
 * conflict-free.)
 */

const containerNode = (props = {}, style = {}) => ({
    id: 'cmp_ctr', type: 'container', visible: true,
    props: { ...props },
    style: { span: 6, gap: 3, ...style },
});

const LOOKS = ['panel', 'tinted', 'outlined'];

describe('AppContainer looks', () => {
    it("look 'plain' (default) stamps no look class — identity", () => {
        const { container } = render(
            <AppContainer node={containerNode({ look: 'plain' })}><div>kid</div></AppContainer>,
        );
        const grid = container.querySelector('[data-app-container]');
        expect(grid.className).toBe('app-grid');
        expect(grid.style.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))');
    });

    it('an absent look renders the identity too (stored definitions)', () => {
        const { container } = render(
            <AppContainer node={containerNode()}><div>kid</div></AppContainer>,
        );
        expect(container.querySelector('[data-app-container]').className).toBe('app-grid');
    });

    it('an unknown look value falls back to the identity render', () => {
        const { container } = render(
            <AppContainer node={containerNode({ look: 'nope' })}><div>kid</div></AppContainer>,
        );
        expect(container.querySelector('[data-app-container]').className).toBe('app-grid');
    });

    for (const look of LOOKS) {
        it(`look '${look}' stamps app-container--${look} and keeps the 12-column grid`, () => {
            const { container, getByText } = render(
                <AppContainer node={containerNode({ look })}><div>kid</div></AppContainer>,
            );
            const grid = container.querySelector('[data-app-container]');
            expect(grid.className).toContain(`app-container--${look}`);
            expect(grid.className).toContain('app-grid');
            expect(grid.style.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))');
            expect(getByText('kid')).toBeTruthy();
        });
    }

    it('a look composes with height fill', () => {
        const { container } = render(
            <AppContainer node={containerNode({ look: 'panel' }, { height: 'fill' })}><div>kid</div></AppContainer>,
        );
        const grid = container.querySelector('[data-app-container]');
        expect(grid.className).toContain('app-fill');
        expect(grid.className).toContain('app-container--panel');
    });

    it('emits no purple/indigo/violet in any look', () => {
        for (const look of LOOKS) {
            const { container } = render(<AppContainer node={containerNode({ look })}><div>kid</div></AppContainer>);
            expect(/purple|violet|indigo|#6366f1|#7c3aed/i.test(container.innerHTML), look).toBe(false);
        }
    });
});
