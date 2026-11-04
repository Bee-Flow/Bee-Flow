import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AssistantCapabilities from './AssistantCapabilities';

afterEach(cleanup);

describe('AssistantCapabilities', () => {
    it('has one column per work mode, "Describe it" first, and says what that mode may do', () => {
        render(<AssistantCapabilities workMode="describe" onChange={vi.fn()} />);
        const table = screen.getByRole('table');
        const headers = within(table.querySelector('thead') as HTMLElement).getAllByRole('columnheader').slice(1).map((th) => th.getAttribute('title'));
        expect(headers).toEqual(['Describe it', 'Just advise', 'Show me before changing', 'Ask, plan, then build', 'Change it right away']);
        const cells = (label: string) => within(screen.getByRole('row', { name: new RegExp(label) })).getAllByRole('cell').map((td) => td.textContent);
        expect(cells('Add steps')[0]).toBe('after your OK');
        expect(cells('Execute a test run')[0]).toBe('after your OK');
        expect(cells('Remove a step')[0]).toBe('—');
        expect(cells('Activate or publish')).toEqual(['—', '—', '—', '—', '—']);
    });
});
