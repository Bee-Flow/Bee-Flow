import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppTabs from './AppTabs';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

function renderTabs(second: Record<string, unknown>) {
    const node = {
        id: 'cmp_tabs', type: 'tabs', visible: true, props: {},
        style: { span: 12, gap: 3, padding: 0 },
        children: [
            { id: 'cmp_ta', type: 'tab', visible: true, props: { label: 'First' }, children: [] },
            { id: 'cmp_tb', type: 'tab', props: { label: 'Second' }, children: [], ...second },
        ],
    };
    const value = { ...DEFAULT_RUNTIME, mode: 'run', scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }) };
    return render(
        <RuntimeProvider value={value as never}>
            <AppTabs node={node as never}>
                <div>Panel A</div>
                <div>Panel B</div>
            </AppTabs>
        </RuntimeProvider>,
    );
}

const labels = (c: HTMLElement) => Array.from(c.querySelectorAll('[role="tab"]')).map((b) => b.textContent);

describe('AppTabs strip visibleWhen', () => {
    it('hides a tab whose stored visibleWhen formula object is false', () => {
        const { container } = renderTabs({ visibleWhen: { kind: 'formula', expr: '1 == 2' } });
        expect(labels(container)).toEqual(['First']);
    });

    it('keeps a tab whose stored visibleWhen formula object is true', () => {
        const { container } = renderTabs({ visibleWhen: { kind: 'formula', expr: '1 == 1' } });
        expect(labels(container)).toEqual(['First', 'Second']);
    });

    it('still honours the bare-string form and the visible formula', () => {
        expect(labels(renderTabs({ visibleWhen: '1 == 2' }).container)).toEqual(['First']);
        expect(labels(renderTabs({ visible: { kind: 'formula', expr: '1 == 2' } }).container)).toEqual(['First']);
    });

    it('falls to the first visible tab when the active one is hidden', () => {
        const node = {
            id: 'cmp_tabs', type: 'tabs', visible: true, props: {}, style: {},
            children: [
                { id: 'a', type: 'tab', visibleWhen: { kind: 'formula', expr: '1 == 2' }, props: { label: 'First' }, children: [] },
                { id: 'b', type: 'tab', props: { label: 'Second' }, children: [] },
            ],
        };
        const value = { ...DEFAULT_RUNTIME, mode: 'run', scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }) };
        const { container } = render(
            <RuntimeProvider value={value as never}>
                <AppTabs node={node as never}><div>Panel A</div><div>Panel B</div></AppTabs>
            </RuntimeProvider>,
        );
        expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Second');
    });
});
