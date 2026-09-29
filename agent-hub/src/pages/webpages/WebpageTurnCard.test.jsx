import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WebpageTurnCard from './WebpageTurnCard';

/**
 * What one assistant turn shows underneath itself (plan W2).
 *
 * The rules under test are all the same rule: the card may only offer what it
 * can actually deliver, and may only claim what the tool stream recorded.
 *
 *   - "Link added" appears for a COMPLETED grant and for nothing else;
 *   - Undo is ABSENT — not disabled — when the before-state is gone, because
 *     a disabled control still says "this is possible, just not now" and a
 *     control that runs without the bytes would restore something else;
 *   - "How I did this" keeps its step count when the duration is unknown,
 *     rather than dropping the line or inventing a time.
 */

const doneTool = (name, ms = 1000) => ({ name, status: 'done', startTime: 0, endTime: ms });
const EDIT = { file: 'html', title: 'index.html', diff: { summary: '2 changed' } };

function renderCard(props = {}) {
    return render(<WebpageTurnCard msg={{ id: 'm1' }} {...props} />);
}

describe('WebpageTurnCard — link added', () => {
    it('appears when a grant tool completed', () => {
        renderCard({ msg: { id: 'm1', toolHistory: [doneTool('webpage_grant_automation')] } });
        expect(screen.getByTestId('webpage-link-added')).toHaveTextContent('Link added');
    });

    it('stays away for a turn that only read the table', () => {
        renderCard({ msg: { id: 'm1', toolHistory: [doneTool('webpage_db_query')] } });
        expect(screen.queryByTestId('webpage-link-added')).not.toBeInTheDocument();
    });

    it('stays away for a grant that never finished', () => {
        renderCard({ msg: { id: 'm1', toolHistory: [{ name: 'webpage_grant_ai', status: 'running' }] } });
        expect(screen.queryByTestId('webpage-link-added')).not.toBeInTheDocument();
    });
});

describe('WebpageTurnCard — the chips', () => {
    const base = { msg: { id: 'm1', webpageEdits: [EDIT] } };

    it('offers Keep, Undo and Change in code when an edit can be undone', () => {
        renderCard({ ...base, canUndo: true });
        expect(screen.getByTestId('webpage-chip-keep')).toBeInTheDocument();
        expect(screen.getByTestId('webpage-chip-undo')).toBeInTheDocument();
        expect(screen.getByTestId('webpage-chip-code')).toBeInTheDocument();
    });

    it('OMITS Undo when the before-state is gone — never a disabled one', () => {
        renderCard({ ...base, canUndo: false });
        expect(screen.queryByTestId('webpage-chip-undo')).not.toBeInTheDocument();
        // The other two still work: keeping and inspecting need no snapshot.
        expect(screen.getByTestId('webpage-chip-keep')).toBeInTheDocument();
    });

    it('shows no chips at all on a turn that changed no file', () => {
        renderCard({ msg: { id: 'm1', toolHistory: [doneTool('webpage_db_query')] }, canUndo: true });
        expect(screen.queryByTestId('webpage-chip-keep')).not.toBeInTheDocument();
    });

    it('reports Keep and Undo, and names the file for Change in code', () => {
        const onKeep = vi.fn(); const onUndo = vi.fn(); const onShowInCode = vi.fn();
        renderCard({ ...base, canUndo: true, onKeep, onUndo, onShowInCode });
        fireEvent.click(screen.getByTestId('webpage-chip-keep'));
        fireEvent.click(screen.getByTestId('webpage-chip-undo'));
        fireEvent.click(screen.getByTestId('webpage-chip-code'));
        expect(onKeep).toHaveBeenCalled();
        expect(onUndo).toHaveBeenCalled();
        expect(onShowInCode).toHaveBeenCalledWith('html');
    });

    it('a kept turn drops its chips and says nothing more', () => {
        renderCard({ ...base, canUndo: true, kept: true });
        expect(screen.queryByTestId('webpage-chip-keep')).not.toBeInTheDocument();
        expect(screen.queryByTestId('webpage-turn-undone')).not.toBeInTheDocument();
    });

    it('an undone turn drops its chips and SAYS it was undone', () => {
        renderCard({ ...base, canUndo: false, undone: true });
        expect(screen.queryByTestId('webpage-chip-keep')).not.toBeInTheDocument();
        expect(screen.getByTestId('webpage-turn-undone')).toBeInTheDocument();
    });
});

describe('WebpageTurnCard — how I did this', () => {
    it('counts the steps and the time', () => {
        renderCard({ msg: { id: 'm1', toolHistory: [doneTool('a', 400), doneTool('b', 1100)] } });
        const line = screen.getByTestId('webpage-how-i-did-this');
        expect(line).toHaveTextContent('2 steps');
        expect(line).toHaveTextContent('1.5s');
    });

    it('says "1 step" in the singular', () => {
        renderCard({ msg: { id: 'm1', toolHistory: [doneTool('a', 200)] } });
        expect(screen.getByTestId('webpage-how-i-did-this')).toHaveTextContent('1 step');
    });

    it('keeps the count but prints no time when a step was untimed', () => {
        renderCard({ msg: { id: 'm1', toolHistory: [doneTool('a', 400), { name: 'b', status: 'done' }] } });
        const line = screen.getByTestId('webpage-how-i-did-this');
        expect(line).toHaveTextContent('2 steps');
        // No "· 0.4s" tail: a partial sum shown as a total would understate
        // the work by an unknown amount.
        expect(line.textContent).not.toMatch(/·\s*\d+\.\d+s/);
    });

    it('is absent for a turn that ran no tool', () => {
        renderCard({ msg: { id: 'm1', webpageEdits: [EDIT] }, canUndo: true });
        expect(screen.queryByTestId('webpage-how-i-did-this')).not.toBeInTheDocument();
    });
});

describe('WebpageTurnCard — nothing to say', () => {
    it('renders nothing at all for an ordinary answer', () => {
        const { container } = renderCard({ msg: { id: 'm1', content: 'Sure!' } });
        expect(container).toBeEmptyDOMElement();
    });
});
