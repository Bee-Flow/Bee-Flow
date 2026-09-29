import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppTimeline from './AppTimeline';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * timeline.metaKey (spec: server/appStudio/componentSpecs.js).
 *
 * The byline an audit trail needs: WHO or WHAT produced the entry. Without it
 * a timeline over an activity log shows what happened and when, and silently
 * drops the one column the log exists to carry — so an entry an AI wrote is
 * indistinguishable from one a colleague typed.
 *
 * `null` is the IDENTITY value: the date line must render exactly as it did
 * before the prop existed, because every stored timeline is on that path.
 */

function withRuntime(ui) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }) };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const ROWS = [
    { kind: 'Geclassificeerd', at: '2026-08-17', door: 'AI · Tom Smit', detail: 'inkooporder' },
    { kind: 'Notitie', at: '2026-08-17', door: 'Tom Smit', detail: 'test' },
    { kind: 'Status', at: '2026-08-17', door: '', detail: 'open' },
];

function node(props = {}) {
    return {
        id: 'cmp_tl',
        type: 'timeline',
        visible: true,
        props: {
            source: { kind: 'static', value: ROWS },
            titleKey: 'kind', dateKey: 'at', descriptionKey: 'detail',
            emptyText: 'x',
            ...props,
        },
        style: { span: 12 },
    };
}

const dateLine = (utils, i) => utils.container
    .querySelector(`[data-app-timeline-row="${i}"]`)
    .querySelector('.text-xs');

describe('timeline byline', () => {
    it('renders the meta field beside the date', () => {
        const utils = withRuntime(<AppTimeline node={node({ metaKey: 'door' })} />);
        expect(dateLine(utils, 0).textContent).toContain('AI · Tom Smit');
        expect(dateLine(utils, 1).textContent).toContain('Tom Smit');
    });

    it('treats an empty byline as absent rather than printing a stray separator', () => {
        const utils = withRuntime(<AppTimeline node={node({ metaKey: 'door' })} />);
        expect(dateLine(utils, 2).textContent).not.toContain('·');
    });

    it('leaves the date line untouched when no metaKey is set', () => {
        const withMeta = withRuntime(<AppTimeline node={node()} />);
        expect(dateLine(withMeta, 0).textContent).not.toContain('·');
        expect(dateLine(withMeta, 0).querySelector('span')).toBe(null);
    });
});
