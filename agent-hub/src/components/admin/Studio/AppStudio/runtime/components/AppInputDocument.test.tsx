import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppForm from './AppForm';
import AppInputDocument from './AppInputDocument';
import { mountInApp, stubFetch } from './documentCompare/documentTestKit';

/**
 * input_document: the options are exactly what the server answers for THIS
 * picker (its documentIds and folder, read as the app owner); picking one
 * submits its id and fires onChange with it.
 */

const picker = { id: 'cmp_pick', type: 'input_document', onChange: 'act_show', props: { name: 'document', label: 'Presentation', kind: 'presentation', documentIds: ['d1', 'd2'], required: false }, style: { span: 6 } };
const form = { id: 'cmp_form', type: 'form', visible: true, props: { name: 'pick', submitLabel: 'Go', showSubmit: false }, style: { span: 12 }, children: [picker] };
const DOCS = [
    { id: 'd1', name: 'Quarterly review', docType: 'presentation', family: 'deck', updatedAt: null },
    { id: 'd2', name: 'Kick-off', docType: 'presentation', family: 'deck', updatedAt: null },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('AppInputDocument', () => {
    it('offers the documents the server lists for this picker, and a pick submits the id', async () => {
        const calls = stubFetch([['/documents?node=cmp_pick', () => ({ body: { documents: DOCS } })]]);
        const runAction = vi.fn();
        mountInApp(<AppForm node={form as never}><AppInputDocument node={picker as never} /></AppForm>, { runAction });
        await userEvent.click(screen.getByRole('combobox'));
        expect(await screen.findByRole('option', { name: 'Quarterly review' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Kick-off' })).toBeTruthy();
        await userEvent.click(screen.getByRole('option', { name: 'Kick-off' }));
        expect(runAction).toHaveBeenCalledWith('act_show', { formValues: { document: 'd2' } });
        expect(calls[0].url).toContain('/api/studio-apps/app_1/documents?node=cmp_pick');
    });

    it('is disabled and fetches nothing while designing', () => {
        const calls = stubFetch([]);
        mountInApp(<AppForm node={form as never}><AppInputDocument node={picker as never} /></AppForm>, { mode: 'design' });
        expect(calls).toEqual([]);
        expect(screen.getByPlaceholderText('Documents can be picked when the app runs.')).toBeTruthy();
    });
});
