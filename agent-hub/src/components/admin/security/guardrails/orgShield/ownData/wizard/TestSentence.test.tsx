import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Sentence } from '../ownDataModel';
import type { Mark } from '../testBench';
import { t } from '../testKit';
import TestSentence from './TestSentence';

/**
 * One test sentence. Every way of marking is covered here, and the keyboard
 * path in particular: a mouse selection is the fast way, but it is not a way
 * at all for a keyboard or a touch user, so "Mark what should be hidden…"
 * has to work on its own.
 */

const TEXT = 'Send KL-12345 and KL-12345 to KL-99999 today';

function setup(sentence: Partial<Sentence> = {}, marks: Mark[] | null = null) {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    const s: Sentence = { id: 's_1', text: TEXT, origin: 'own', ...sentence };
    render(<ul><TestSentence sentence={s} marks={marks} onChange={onChange} onRemove={onRemove} t={t} /></ul>);
    return { onChange, onRemove, user: userEvent.setup() };
}

describe('marking with the keyboard', () => {
    it('marks every occurrence of the typed text', async () => {
        const { onChange, user } = setup();
        expect(screen.getByText('Not marked')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'More for this sentence' }));
        await user.click(screen.getByRole('button', { name: 'Mark what should be hidden…' }));
        await user.type(screen.getByLabelText('Type the exact text that should be hidden'), 'kl-12345{Enter}');
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gold: [{ start: 5, end: 13 }, { start: 18, end: 26 }] }));
    });

    it('says so when the text is not in the sentence', async () => {
        const { onChange, user } = setup();
        await user.click(screen.getByRole('button', { name: 'More for this sentence' }));
        await user.click(screen.getByRole('button', { name: 'Mark what should be hidden…' }));
        await user.type(screen.getByLabelText('Type the exact text that should be hidden'), 'KL-00000');
        await user.click(screen.getByRole('button', { name: 'Mark it' }));
        expect(screen.getByRole('alert')).toHaveTextContent('That text is not in this sentence.');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('can say "nothing should be hidden here", which is not the same as unmarked', async () => {
        const { onChange, user } = setup();
        await user.click(screen.getByRole('button', { name: 'More for this sentence' }));
        await user.click(screen.getByRole('button', { name: 'Nothing should be hidden here' }));
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gold: [] }));
    });

    it('opens a mark\'s choices from the keyboard', async () => {
        const { onChange, user } = setup({ gold: [{ start: 5, end: 13 }] });
        const mark = screen.getByRole('button', { name: 'Should be hidden: KL-12345' });
        mark.focus();
        await user.keyboard('{Enter}');
        await user.click(screen.getByRole('button', { name: 'Not this' }));
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gold: [] }));
    });

    it('removes the sentence', async () => {
        const { onRemove, user } = setup();
        await user.click(screen.getByRole('button', { name: 'More for this sentence' }));
        await user.click(screen.getByRole('button', { name: 'Remove this sentence' }));
        expect(onRemove).toHaveBeenCalled();
    });
});

describe('marking with the mouse', () => {
    it('offers "Should be hidden" for selected text', async () => {
        const { onChange, user } = setup();
        const text = screen.getByText(TEXT);
        await user.pointer([
            { keys: '[MouseLeft>]', target: text, offset: 30 },
            { offset: 38 },
            { keys: '[/MouseLeft]' },
        ]);
        const bar = screen.getByRole('group', { name: 'About “KL-99999”' });
        await user.click(within(bar).getByRole('button', { name: 'Should be hidden' }));
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gold: [{ start: 30, end: 38 }] }));
    });
});

describe('after a test', () => {
    const gold = [{ start: 5, end: 13 }, { start: 18, end: 26 }];
    const marks: Mark[] = [
        { start: 5, end: 13, kind: 'hit' },
        { start: 18, end: 26, kind: 'missed' },
        { start: 30, end: 38, kind: 'false_alarm' },
    ];

    it('shows found, missed and false alarm, and says so per sentence', () => {
        setup({ gold }, marks);
        expect(screen.getByRole('button', { name: 'Found: KL-12345' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Missed: KL-12345' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'False alarm: KL-99999' })).toBeInTheDocument();
        expect(screen.getByText('Missed 1 · 1 false alarm')).toBeInTheDocument();
    });

    it('"Wrong, leave this" on a find takes it out of what should be hidden', async () => {
        const { onChange, user } = setup({ gold }, marks);
        await user.click(screen.getByRole('button', { name: 'Found: KL-12345' }));
        await user.click(screen.getByRole('button', { name: 'Wrong, leave this' }));
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gold: [{ start: 18, end: 26 }] }));
    });

    it('"Right, hide this" on a find changes nothing', async () => {
        const { onChange, user } = setup({ gold }, marks);
        await user.click(screen.getByRole('button', { name: 'Found: KL-12345' }));
        await user.click(screen.getByRole('button', { name: 'Right, hide this' }));
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Right, hide this' })).toBeNull();
    });

    it('"Right, hide this" on a false alarm makes it something to find', async () => {
        const { onChange, user } = setup({ gold }, marks);
        await user.click(screen.getByRole('button', { name: 'False alarm: KL-99999' }));
        await user.click(screen.getByRole('button', { name: 'Right, hide this' }));
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gold: [...gold, { start: 30, end: 38 }] }));
    });

    it('"It should not be hidden" on a miss takes the mark away', async () => {
        const { onChange, user } = setup({ gold }, marks);
        await user.click(screen.getByRole('button', { name: 'Missed: KL-12345' }));
        await user.click(screen.getByRole('button', { name: 'It should not be hidden' }));
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gold: [{ start: 5, end: 13 }] }));
    });

    it('says Correct for a sentence with nothing wrong', () => {
        setup({ gold: [{ start: 5, end: 13 }] }, [{ start: 5, end: 13, kind: 'hit' }]);
        expect(screen.getByText('Correct')).toBeInTheDocument();
    });
});
