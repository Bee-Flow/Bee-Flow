import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import FormBuilderFields from './FormBuilderFields';

/**
 * The download button, from the author's side.
 *
 * The runtime half of this shipped first: the server accepts a `download`
 * field, validates it, and the public renderer draws it. None of that was
 * reachable, because the builder offered no way to add one — the type was
 * missing from the question dropdown, and a CLOSING page (where a produced
 * document actually belongs) hid the field list altogether.
 */
const endingForm = (fields = []) => ({
    title: 'All done',
    description: 'Thanks — here is what we did:',
    fields,
    theme: null,
});

const inputForm = (fields = []) => ({
    title: 'Get in touch',
    description: '',
    submitLabel: 'Submit',
    successMessage: 'Thanks!',
    fields,
    theme: null,
});

const download = (over = {}) => ({ name: 'document', type: 'download', label: 'Download', fileId: '', ...over });

function renderEditor(form, props = {}) {
    const onChange = vi.fn();
    const utils = render(
        <FormBuilderFields form={form} onChange={onChange} bindingBase="steps.fp_1.output" {...props} />,
    );
    return { ...utils, onChange };
}

describe('FormBuilderFields — download button', () => {
    beforeEach(cleanup);

    it('offers Download button as a question type', () => {
        renderEditor(inputForm([{ name: 'a', type: 'text', label: 'Your answer' }]));
        const select = screen.getByLabelText('Question 1 type');
        const options = [...select.querySelectorAll('option')].map(o => o.value);
        expect(options).toContain('download');
        expect(screen.getByRole('option', { name: 'Download button' })).toBeTruthy();
    });

    describe('on a closing page', () => {
        it('offers a Downloads section even though it has no questions', () => {
            renderEditor(endingForm(), { variant: 'ending' });
            expect(screen.getByText('Downloads')).toBeTruthy();
            expect(screen.getByRole('button', { name: /Add a download/ })).toBeTruthy();
            // A closing page collects nothing, so the questions block stays gone.
            expect(screen.queryByText('Questions')).toBeNull();
        });

        it('says what the empty state means instead of showing nothing', () => {
            renderEditor(endingForm(), { variant: 'ending' });
            expect(screen.getByText(/Nothing to hand over/)).toBeTruthy();
        });

        it('adds a download that collects nothing', () => {
            const { onChange } = renderEditor(endingForm(), { variant: 'ending' });
            fireEvent.click(screen.getByRole('button', { name: /Add a download/ }));

            const next = onChange.mock.calls[0][0];
            expect(next.fields).toHaveLength(1);
            expect(next.fields[0]).toMatchObject({ type: 'download', fileId: '' });
            expect(next.fields[0].required).toBeUndefined();
        });

        it('edits the right row when a closing page holds several downloads', () => {
            // The section filters the field list, so it has to carry the real
            // index through — otherwise the second card edits the first field.
            const { onChange } = renderEditor(
                endingForm([download({ name: 'one', label: 'One' }), download({ name: 'two', label: 'Two' })]),
                { variant: 'ending' },
            );
            fireEvent.change(screen.getByLabelText('Download 2 file'), {
                target: { value: '{{steps.doc_2.output.fileId}}' },
            });
            const next = onChange.mock.calls[0][0];
            expect(next.fields[0].fileId).toBe('');
            expect(next.fields[1].fileId).toBe('{{steps.doc_2.output.fileId}}');
        });
    });

    describe('the card itself', () => {
        it('asks which file to offer', () => {
            renderEditor(endingForm([download()]), { variant: 'ending' });
            expect(screen.getByText('File to offer')).toBeTruthy();
            expect(screen.getByLabelText('Download 1 file')).toBeTruthy();
        });

        it('has no Required checkbox — it collects nothing to require', () => {
            renderEditor(endingForm([download()]), { variant: 'ending' });
            expect(screen.queryByText('Required')).toBeNull();
        });

        it('has no Advanced section — no placeholder, no binding name', () => {
            renderEditor(endingForm([download()]), { variant: 'ending' });
            expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
        });

        it('still offers Required for a real question', () => {
            renderEditor(inputForm([{ name: 'a', type: 'text', label: 'Your answer' }]));
            expect(screen.getByText('Required')).toBeTruthy();
        });

        it('works on an input page too, not only a closing one', () => {
            renderEditor(inputForm([download()]));
            expect(screen.getByLabelText('Download 1 file')).toBeTruthy();
        });

        it('records the file binding', () => {
            const { onChange } = renderEditor(endingForm([download()]), { variant: 'ending' });
            fireEvent.change(screen.getByLabelText('Download 1 file'), {
                target: { value: '{{steps.doc_1.output.fileId}}' },
            });
            expect(onChange.mock.calls[0][0].fields[0].fileId).toBe('{{steps.doc_1.output.fileId}}');
        });
    });
});
