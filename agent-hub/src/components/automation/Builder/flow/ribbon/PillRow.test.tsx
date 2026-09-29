import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import PillRow from './PillRow';
import type { RowPill } from './PillRow';
import type { StepPayload } from './ribbonCategories';

/**
 * The fold: jsdom lays nothing out, so the row is modelled here. Its
 * `clientWidth` is the given width and its `scrollWidth` is PILL px per
 * button still on it (the More pill included), as in useFitClusters.test.jsx.
 */
const PILL = 100;

function stubWidths(clientWidth: number) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get() { return (this as HTMLElement).hasAttribute('data-ribbon-pill-row') ? clientWidth : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get() {
            const el = this as HTMLElement;
            return el.hasAttribute('data-ribbon-pill-row') ? el.querySelectorAll('button').length * PILL : 0;
        },
    });
}
function restoreWidths() {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
}

const pill = (key: string, title: string, origin: string | null = null): RowPill => ({
    key,
    node: <button type="button">{key}</button>,
    fold: { key: `f:${title}`, title, rows: [{ key, label: `${key} step`, glyph: null, payload: { kind: key } }] },
    origins: origin ? [origin] : [],
});

function Harness({ segments, onAdd, enabled = true }: { segments: RowPill[][]; onAdd: (p: StepPayload) => void; enabled?: boolean }) {
    const [openKey, setOpenKey] = useState<string | null>(null);
    const add = (p: StepPayload) => { onAdd(p); setOpenKey(null); };
    return (
        <PillRow
            segments={segments}
            testId="row"
            enabled={enabled}
            moreOrigins={['more:Test']}
            empty="Nothing here"
            onAdd={add}
            openKey={openKey}
            setOpenKey={setOpenKey}
        />
    );
}

const row = () => screen.getByTestId('row');
const shownPills = () => within(row()).getAllByRole('button').map(b => b.textContent);

describe('PillRow', () => {
    afterEach(() => { cleanup(); restoreWidths(); });

    it('keeps every pill on the row when it fits, with a divider between segments', () => {
        stubWidths(10 * PILL);
        render(<Harness segments={[[pill('a', 'X')], [pill('b', 'X'), pill('c', 'Y')]]} onAdd={vi.fn()} />);
        expect(shownPills()).toEqual(['a', 'b', 'c']);
        expect(row().querySelectorAll('[aria-hidden="true"].w-px')).toHaveLength(1);
        expect(row()).toHaveClass('flex-nowrap');
    });

    it('folds the last pills into "More", which takes over their stamps and lists their commands', async () => {
        const user = userEvent.setup();
        stubWidths(2.5 * PILL);
        const onAdd = vi.fn();
        render(<Harness segments={[[pill('a', 'X')], [pill('b', 'Logic', 'section:flow_control'), pill('c', 'End the run', 'section:flow_control')]]} onAdd={onAdd} />);
        const more = within(row()).getByRole('button', { name: 'More' });
        expect(shownPills()).toEqual(['a', 'More']);
        expect(more).toHaveAttribute('aria-haspopup', 'true');
        // Nested stamps: the build film finds "More" under each key it stands in for, once.
        const stamps = [...row().querySelectorAll('[data-ribbon-origin]')].map(el => el.getAttribute('data-ribbon-origin'));
        expect(stamps).toEqual(['more:Test', 'section:flow_control']);

        await user.click(more);
        const list = document.querySelector('[data-ribbon-dropdown]') as HTMLElement;
        expect(within(list).getByText('Logic')).toBeInTheDocument();
        expect(within(list).getByText('End the run')).toBeInTheDocument();
        await user.click(within(list).getByRole('button', { name: /c step/ }));
        expect(onAdd).toHaveBeenCalledWith({ kind: 'c' });
        expect(document.querySelector('[data-ribbon-dropdown]')).toBeNull();
    });

    it('never folds the first pill, however narrow', () => {
        stubWidths(0);
        render(<Harness segments={[[pill('a', 'X'), pill('b', 'X'), pill('c', 'X')]]} onAdd={vi.fn()} />);
        expect(shownPills()).toEqual(['a', 'More']);
    });

    it('folds nothing while it is off screen, and says so when there is nothing to offer', () => {
        stubWidths(0);
        const { unmount } = render(<Harness enabled={false} segments={[[pill('a', 'X'), pill('b', 'X')]]} onAdd={vi.fn()} />);
        expect(shownPills()).toEqual(['a', 'b']);
        unmount();
        render(<Harness segments={[[], []]} onAdd={vi.fn()} />);
        expect(row()).toHaveTextContent('Nothing here');
    });
});
