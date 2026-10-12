import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ImportMemoryModal from './ImportMemoryModal';
import { mockApi, respond } from './testApi';

afterEach(() => { vi.restoreAllMocks(); });

async function submit(text = '- I like tea') {
    const user = userEvent.setup();
    render(<ImportMemoryModal onClose={vi.fn()} onImported={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: /Paste results below/ }), text);
    await user.click(screen.getByRole('button', { name: 'Add to memory' }));
}

describe('ImportMemoryModal', () => {
    it('shows what was added and why items were skipped', async () => {
        mockApi({ 'POST /import': () => respond({ imported: 3, skipped: 3, skippedBy: { sensitive: 2, identifier: 1, duplicate: 0 } }) });
        await submit();
        const status = await screen.findByRole('status');
        expect(status).toHaveTextContent('Added 3 memories');
        expect(status).toHaveTextContent('3 skipped');
        expect(status).toHaveTextContent('2 skipped because they are about a sensitive topic.');
        expect(status).toHaveTextContent('1 skipped because they look like a password, account or ID number.');
    });

    it('still reads a plain skipped number', async () => {
        mockApi({ 'POST /import': () => respond({ imported: 1, skipped: 4 }) });
        await submit();
        expect(await screen.findByRole('status')).toHaveTextContent('4 skipped');
    });

    it('explains a refused import while memory is paused', async () => {
        mockApi({ 'POST /import': () => respond({ error: 'Memory is paused' }, 403) });
        await submit();
        expect(await screen.findByRole('alert')).toHaveTextContent('Importing is not available while memory is paused or turned off.');
    });

    it('names an identifier refusal', async () => {
        mockApi({ 'POST /import': () => respond({ error: 'x', code: 'sensitive_identifier' }, 422) });
        await submit();
        expect(await screen.findByRole('alert')).toHaveTextContent('Those are never stored.');
    });
});
