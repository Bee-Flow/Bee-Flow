import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_MEMORY_PANEL_EVENT } from '../../../utils/memoryMode';
import { deleteMemory, fetchMemoriesByIds } from './memoryApi';
import MemoryUsedDisclosure, { memoryUsedOf } from './MemoryUsedDisclosure';

vi.mock('./memoryApi', () => ({ fetchMemoriesByIds: vi.fn(), deleteMemory: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const byIds = vi.mocked(fetchMemoriesByIds);
const del = vi.mocked(deleteMemory);
beforeEach(() => { byIds.mockReset(); del.mockReset(); });

const ITEMS = [
    { id: 'm1', type: 'preference', preview: 'Prefers short answers' },
    { id: 'm2', type: 'person', preview: 'Colleague Anouk, finance' },
    { id: 'm3', type: 'fact', preview: 'Lives in Utrecht' },
];

describe('memoryUsedOf', () => {
    it('reads the live list from the message', () => {
        expect(memoryUsedOf({ id: 'a', memoryUsed: ITEMS })).toEqual(ITEMS);
    });

    it('reads the persisted list from meta or metadata after a reload', () => {
        expect(memoryUsedOf({ id: 'a', meta: { memoryUsed: ITEMS } })).toEqual(ITEMS);
        expect(memoryUsedOf({ id: 'a', metadata: { memoryUsed: ITEMS } })).toEqual(ITEMS);
    });

    it('is empty for a message without the list or with junk in it', () => {
        expect(memoryUsedOf({ id: 'a' })).toEqual([]);
        expect(memoryUsedOf({ id: 'a', memoryUsed: 'x' as never })).toEqual([]);
        expect(memoryUsedOf({ id: 'a', meta: { memoryUsed: [null, 3, { nope: 1 }] } })).toEqual([]);
        expect(memoryUsedOf(null)).toEqual([]);
    });
});

describe('MemoryUsedDisclosure', () => {
    afterEach(() => { document.body.innerHTML = ''; });

    it('shows nothing without items', () => {
        const { container } = render(<MemoryUsedDisclosure items={[]} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('is collapsed with a count, and opens from the keyboard to type and preview', async () => {
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={ITEMS} />);
        const toggle = screen.getByRole('button', { name: /Used 3 memories/ });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('Lives in Utrecht')).not.toBeInTheDocument();

        toggle.focus();
        await user.keyboard('{Enter}');
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const list = screen.getByRole('region', { name: 'Memories used for this answer' });
        expect(screen.getByRole('img', { name: 'Preference' })).toBeInTheDocument();
        expect(list).toHaveTextContent('Prefers short answers');
        expect(list).toHaveTextContent('Lives in Utrecht');
    });

    it('says "Used 1 memory" for one', () => {
        render(<MemoryUsedDisclosure items={[ITEMS[0]]} />);
        expect(screen.getByRole('button', { name: /Used 1 memory/ })).toBeInTheDocument();
    });

    it('"Manage memory" asks the app to open the memory panel', async () => {
        const user = userEvent.setup();
        let opened = 0;
        const onOpen = () => { opened += 1; };
        window.addEventListener(OPEN_MEMORY_PANEL_EVENT, onOpen);
        render(<MemoryUsedDisclosure items={ITEMS} />);
        expect(screen.queryByRole('button', { name: 'Manage memory' })).not.toBeInTheDocument();
        await user.click(screen.getByTestId('memory-used-toggle'));
        await user.click(screen.getByRole('button', { name: 'Manage memory' }));
        window.removeEventListener(OPEN_MEMORY_PANEL_EVENT, onOpen);
        expect(opened).toBe(1);
    });
});

describe('MemoryUsedDisclosure after a reload (ids and types only)', () => {
    const PERSISTED = [{ id: 'm1', type: 'fact' }, { id: 'm2', type: 'person' }];

    it('reads the persisted list without previews', () => {
        expect(memoryUsedOf({ id: 'a', meta: { memoryUsed: PERSISTED } })).toEqual(PERSISTED);
    });

    it('shows the count and does not fetch until expanded', () => {
        render(<MemoryUsedDisclosure items={PERSISTED} />);
        expect(screen.getByRole('button', { name: /Used 2 memories/ })).toBeInTheDocument();
        expect(byIds).not.toHaveBeenCalled();
    });

    it('fetches the previews once on expand, and says which are no longer available', async () => {
        byIds.mockResolvedValue([{ id: 'm1', type: 'fact', content: 'Lives in Utrecht' }]);
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={PERSISTED} />);
        const toggle = screen.getByRole('button', { name: /Used 2 memories/ });
        await user.click(toggle);
        const list = screen.getByRole('region', { name: 'Memories used for this answer' });
        expect(await screen.findByText('Lives in Utrecht')).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Fact' })).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Person' })).toBeInTheDocument();
        expect(list).toHaveTextContent('No longer available');
        expect(byIds).toHaveBeenCalledTimes(1);
        expect(byIds.mock.calls[0][0]).toEqual(['m1', 'm2']);
        // Collapse and expand again: cached, no second request.
        await user.click(toggle);
        await user.click(toggle);
        expect(byIds).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Lives in Utrecht')).toBeInTheDocument();
    });

    it('a failed lookup shows no longer available rather than a spinner', async () => {
        byIds.mockRejectedValue(new Error('offline'));
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={[PERSISTED[0]]} />);
        await user.click(screen.getByRole('button', { name: /Used 1 memory/ }));
        expect(await screen.findByText('No longer available')).toBeInTheDocument();
    });

    it('does not fetch when the live items already carry previews', async () => {
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={ITEMS} />);
        await user.click(screen.getByRole('button', { name: /Used 3 memories/ }));
        expect(byIds).not.toHaveBeenCalled();
    });
});

describe('MemoryUsedDisclosure card', () => {
    const MIXED = [
        { id: 'p1', type: 'instruction', preview: 'Answer in Dutch', why: 'profile' as const },
        { id: 'r1', type: 'fact', preview: 'Lives in Utrecht', why: 'relevant' as const },
    ];

    it('groups by why, with the profile description', async () => {
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={MIXED} />);
        await user.click(screen.getByTestId('memory-used-toggle'));
        const always = screen.getByRole('region', { name: 'Always used' });
        expect(always).toHaveTextContent('Your standing instructions and preferences');
        expect(always).toHaveTextContent('Answer in Dutch');
        const relevant = screen.getByRole('region', { name: 'Relevant to this message' });
        expect(relevant).toHaveTextContent('Lives in Utrecht');
        expect(relevant).not.toHaveTextContent('Answer in Dutch');
    });

    it('treats items without why as relevant and shows no headings when only one group exists', async () => {
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={ITEMS} />);
        await user.click(screen.getByTestId('memory-used-toggle'));
        expect(screen.queryByText('Always used')).not.toBeInTheDocument();
        expect(screen.queryByText('Relevant to this message')).not.toBeInTheDocument();
        expect(screen.getAllByTestId('memory-used-row')).toHaveLength(3);
    });

    it('scrolls inside a max-height container', async () => {
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={ITEMS} />);
        await user.click(screen.getByTestId('memory-used-toggle'));
        const scroll = screen.getByTestId('memory-used-scroll');
        expect(scroll.className).toContain('max-h-64');
        expect(scroll.className).toContain('overflow-y-auto');
    });

    it('forget calls DELETE without undo and marks the row forgotten', async () => {
        del.mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={MIXED} />);
        await user.click(screen.getByTestId('memory-used-toggle'));
        const [first] = screen.getAllByRole('button', { name: 'Forget this memory' });
        await user.click(first);
        expect(del).toHaveBeenCalledWith('p1');
        const row = screen.getAllByTestId('memory-used-row')[0];
        expect(await within(row).findByText('Forgotten')).toBeInTheDocument();
        expect(within(row).queryByRole('button', { name: 'Forget this memory' })).not.toBeInTheDocument();
    });

    it('a failed forget keeps the row and its button', async () => {
        del.mockRejectedValue(new Error('x'));
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={[MIXED[1]]} />);
        await user.click(screen.getByTestId('memory-used-toggle'));
        await user.click(screen.getByRole('button', { name: 'Forget this memory' }));
        expect(await screen.findByRole('button', { name: 'Forget this memory' })).toBeEnabled();
        expect(screen.queryByText('Forgotten')).not.toBeInTheDocument();
    });

    it('is reachable by keyboard: toggle, then row text, forget and manage', async () => {
        const user = userEvent.setup();
        render(<MemoryUsedDisclosure items={[MIXED[1]]} />);
        await user.tab();
        expect(screen.getByTestId('memory-used-toggle')).toHaveFocus();
        await user.keyboard('{Enter}');
        await user.tab();
        expect(screen.getByText('Lives in Utrecht')).toHaveFocus();
        await user.tab();
        expect(screen.getByRole('button', { name: 'Forget this memory' })).toHaveFocus();
        await user.tab();
        expect(screen.getByRole('button', { name: 'Manage memory' })).toHaveFocus();
    });
});
