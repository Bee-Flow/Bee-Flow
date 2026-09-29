import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppCard from './AppCard';

/**
 * AppCard — the look pass (props.look, spec componentSpecs.js).
 *
 * IDENTITY: look 'default' (or absent/unknown) must stamp NO look class — the
 * pre-look class string, byte for byte — because the card's cell-level
 * restyling in AppCard.css is keyed entirely off `app-card--<look>` classes
 * and must be unreachable for stored definitions.
 */

const cardNode = (props = {}, style = {}) => ({
    id: 'cmp_card', type: 'card', visible: true,
    props: { title: 'Totals', description: null, ...props },
    style: { span: 6, padding: 3, gap: 3, background: 'surface', ...style },
});

const LOOKS = ['flat', 'raised', 'tinted', 'accent', 'gradient', 'solid'];
const IDENTITY_CLASS = 'app-card flex flex-col';

describe('AppCard looks', () => {
    it("look 'default' renders the exact pre-look class string (identity)", () => {
        const { container } = render(
            <AppCard node={cardNode({ look: 'default' })}><div>kid</div></AppCard>,
        );
        const root = container.querySelector('.app-card');
        expect(root.className).toBe(IDENTITY_CLASS);
    });

    it('an absent look renders the identity too (stored definitions)', () => {
        const { container } = render(<AppCard node={cardNode()}><div>kid</div></AppCard>);
        expect(container.querySelector('.app-card').className).toBe(IDENTITY_CLASS);
    });

    it('an unknown look value falls back to the identity render', () => {
        const { container } = render(
            <AppCard node={cardNode({ look: 'constructor' })}><div>kid</div></AppCard>,
        );
        expect(container.querySelector('.app-card').className).toBe(IDENTITY_CLASS);
    });

    for (const look of LOOKS) {
        it(`look '${look}' stamps app-card--${look} and keeps header + children`, () => {
            const { container, getByText } = render(
                <AppCard node={cardNode({ look })}><div>kid</div></AppCard>,
            );
            const root = container.querySelector('.app-card');
            expect(root.className).toContain(`app-card--${look}`);
            expect(getByText('Totals')).toBeTruthy();
            expect(getByText('kid')).toBeTruthy();
        });
    }

    it('a look composes with height fill without disturbing the fill classes', () => {
        const { container } = render(
            <AppCard node={cardNode({ look: 'raised' }, { height: 'fill' })}><div>kid</div></AppCard>,
        );
        const root = container.querySelector('.app-card');
        expect(root.className).toContain('app-fill');
        expect(root.className).toContain('app-card--raised');
    });

    it('emits no purple/indigo/violet in any look', () => {
        for (const look of LOOKS) {
            const { container } = render(<AppCard node={cardNode({ look })}><div>kid</div></AppCard>);
            expect(/purple|violet|indigo|#6366f1|#7c3aed/i.test(container.innerHTML), look).toBe(false);
        }
    });
});
