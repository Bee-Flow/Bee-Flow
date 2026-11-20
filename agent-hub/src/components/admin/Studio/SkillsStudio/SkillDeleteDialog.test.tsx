import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient as render } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import SkillDeleteDialog from './SkillDeleteDialog';

const SKILL = { id: 'sk1', name: 'Quote helper' };
const IN_USE = { error: 'This skill is still in use', code: 'in_use', usage: [{ kind: 'agent', id: 'a1', title: 'Sales agent' }], unchecked: [] };

/** The usage read answers "nothing"; each DELETE takes the next answer from `deletes`. */
function serve(deletes: Response[]) {
    return stubRecordingFetch(({ method, url }: RecordedCall) => {
        if (method === 'DELETE') return deletes.shift() || jsonResponse({ success: true });
        if (url.includes('/usage')) return jsonResponse({ usage: [], unchecked: [] });
        return jsonResponse({}, 404);
    });
}
const deleteBodies = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'DELETE').map((c) => c.body);

describe('SkillDeleteDialog', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('asks for the name, then deletes WITHOUT confirmBreaking: the server still checks', async () => {
        const calls = serve([]);
        const onDeleted = vi.fn();
        render(<SkillDeleteDialog skill={SKILL} onClose={vi.fn()} onDeleted={onDeleted} />);
        await userEvent.type(screen.getByPlaceholderText('Quote helper'), 'Quote helper');
        await userEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
        await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('sk1'));
        expect(deleteBodies(calls)).toEqual([{ confirmBreaking: false }]);
    });

    it('a 409 in_use shows what would break, and only the second confirmation sends confirmBreaking', async () => {
        const calls = serve([jsonResponse(IN_USE, 409)]);
        const onDeleted = vi.fn();
        render(<SkillDeleteDialog skill={SKILL} onClose={vi.fn()} onDeleted={onDeleted} />);
        await userEvent.type(screen.getByPlaceholderText('Quote helper'), 'Quote helper');
        await userEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
        expect(await screen.findByText('Sales agent')).toBeTruthy();
        expect(onDeleted).not.toHaveBeenCalled();
        await userEvent.type(screen.getByPlaceholderText('Quote helper'), 'Quote helper');
        await userEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
        await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('sk1'));
        expect(deleteBodies(calls)).toEqual([{ confirmBreaking: false }, { confirmBreaking: true }]);
    });

    it('Cancel closes the dialog', async () => {
        serve([]);
        const onClose = vi.fn();
        render(<SkillDeleteDialog skill={SKILL} onClose={onClose} onDeleted={vi.fn()} />);
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalled();
    });
});
