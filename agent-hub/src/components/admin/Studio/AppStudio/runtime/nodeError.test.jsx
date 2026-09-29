import { render, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import AppRenderer from './AppRenderer';
import { APP_COMPONENT_TYPES } from './componentRegistry';
import { describeNodeError } from './nodeError';

/**
 * The per-node error boundary (runtime/nodeError.jsx), from the two angles that
 * cost a real misdiagnosis: what the failure card SAYS, and whether a node that
 * failed on transient data ever comes back.
 *
 * The containment basics — a crash stays inside its own cell, a corrected prop
 * clears it — live in AppRenderer.test.jsx next to the rest of the renderer.
 */

// A permissive theme'd definition scaffold for one-off nodes.
function defWith(children) {
    return {
        schemaVersion: 1,
        meta: { name: 'Test app', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_test01',
        screens: [{
            id: 'scr_test01', name: 'Test', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [{ id: 'sec_test01', style: { padding: 4, gap: 3, background: 'none' }, children }],
        }],
        actions: {},
    };
}

describe('NodeErrorBoundary', () => {
    afterEach(() => {
        delete APP_COMPONENT_TYPES.boomtest;
    });

    /**
     * The failure card used to say "This component failed" and nothing else,
     * which is as much as a blank box: it named neither the component nor the
     * reason, so a bad prop and a render loop looked identical. That cost a
     * whole misdiagnosis — see AppRenderer.formulaBinding.test.jsx.
     */
    it('names the component type, and in the editor the reason', () => {
        APP_COMPONENT_TYPES.boomtest = {
            Component: () => { throw new Error('Too many re-renders. React limits the number of renders.'); },
            label: 'Boom', icon: null, category: 'Content', defaultProps: {}, defaultStyle: { span: 12 },
        };
        const def = defWith([
            { id: 'cmp_boom01', type: 'boomtest', props: {}, style: { span: 12 }, visible: true },
        ]);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const edit = render(<AppRenderer definition={def} screenId="scr_test01" mode="edit" />);
            const card = edit.container.querySelector('[data-app-node-error]');
            expect(card.getAttribute('data-app-node-error')).toBe('boomtest');
            expect(within(card).getByText('boomtest')).toBeTruthy();
            expect(within(card).getByText(/Too many re-renders/)).toBeTruthy();
            edit.unmount();

            // A viewer gets the type but not React's internals — there is
            // nothing they could do with them.
            const run = render(<AppRenderer definition={def} screenId="scr_test01" mode="run" />);
            const runCard = run.container.querySelector('[data-app-node-error]');
            expect(within(runCard).getByText('boomtest')).toBeTruthy();
            expect(runCard.querySelector('[data-app-node-error-detail]')).toBeNull();
        } finally {
            errSpy.mockRestore();
        }
    });

    it('reports a minified production React error by its CODE', () => {
        expect(describeNodeError(new Error('Minified React error #301; visit https://…')))
            .toBe('React error #301');
        expect(describeNodeError(new Error('https://react.dev/errors/418?invariant=418')))
            .toBe('React error #418');
        expect(describeNodeError(new Error('kaboom'))).toBe('kaboom');
        expect(describeNodeError(null)).toBeNull();
        expect(describeNodeError(new Error('x'.repeat(400))).length).toBe(160);
    });

    /**
     * A node that threw because the data it reads had not arrived yet used to
     * stay dead for the whole session: the boundary only reset on a props/style
     * change, and data is neither. One honest retry when the SCOPE moves.
     */
    it('retries a failed node when the scope changes, and gives up if it keeps throwing', () => {
        let armed = true;
        APP_COMPONENT_TYPES.boomtest = {
            Component: () => {
                if (armed) throw new Error('kaboom');
                return <div>recovered ok</div>;
            },
            label: 'Boom', icon: null, category: 'Content', defaultProps: {}, defaultStyle: { span: 12 },
        };
        const def = defWith([
            { id: 'cmp_boom01', type: 'boomtest', props: {}, style: { span: 12 }, visible: true },
        ]);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { getByText, queryByText, rerender } = render(
                <AppRenderer definition={def} screenId="scr_test01" mode="run" forms={{}} />,
            );
            expect(getByText('This component failed')).toBeTruthy();

            // Same definition, new form values → new scope → retried.
            armed = false;
            rerender(<AppRenderer definition={def} screenId="scr_test01" mode="run" forms={{ std: { a: 1 } }} />);
            expect(queryByText('This component failed')).toBeNull();
            expect(getByText('recovered ok')).toBeTruthy();

            // A node that throws on every scope tick stops being retried.
            armed = true;
            for (let i = 0; i < 8; i += 1) {
                rerender(<AppRenderer definition={def} screenId="scr_test01" mode="run" forms={{ std: { a: i + 2 } }} />);
            }
            expect(getByText('This component failed')).toBeTruthy();
            const calls = errSpy.mock.calls.filter(([msg]) => String(msg).includes("component 'boomtest' crashed")).length;
            expect(calls).toBeLessThanOrEqual(6);
        } finally {
            errSpy.mockRestore();
        }
    });
});
