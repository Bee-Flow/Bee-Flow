import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MessageAttachments from './MessageAttachments';

describe('MessageAttachments open button', () => {
    it('shows no Open button without documentId', () => {
        const msg = { id: 'm1', attachments: [{ name: 'a.xlsx', type: 'application/vnd.ms-excel' }] };
        render(<MessageAttachments msg={msg} isUser setLightboxImage={() => {}} />);
        expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
    });

    it('dispatches the open-side event when clicked', async () => {
        const seen = vi.fn((e: Event) => e.preventDefault());
        window.addEventListener('beeflow:open-document-side', seen);
        const msg = { id: 'm1', attachments: [{ name: 'a.xlsx', documentId: 'd1' }] };
        render(<MessageAttachments msg={msg} isUser setLightboxImage={() => {}} />);
        await userEvent.click(screen.getByRole('button', { name: /open/i }));
        window.removeEventListener('beeflow:open-document-side', seen);
        expect(seen).toHaveBeenCalledTimes(1);
        expect((seen.mock.calls[0][0] as CustomEvent<{ id: string }>).detail.id).toBe('d1');
    });
});
