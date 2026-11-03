/**
 * File questions in the builder's form test (studio-and-forms F8): picking a
 * file on page one uploads it to the builder's own endpoint (POST
 * /:id/form-test/upload, multipart: file, field, triggerStepId) and the page
 * submits the returned fileId, which the form test claims. A later page has no
 * builder upload endpoint, so its file question says where it can be tried
 * instead of silently doing nothing.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { fakeServer } from '@/test/formRunServer';
import FormRunOverlay from './FormRunOverlay';

const fileQuestion = { name: 'invoice', type: 'file', label: 'Upload your invoice', required: true, placeholder: '', help: '', maxSizeMb: 5, accept: '' };
const FORM = { title: 'Expense', description: '', submitLabel: 'Send', successMessage: 'Thanks', theme: {}, fields: [fileQuestion] };
const PAGE_TWO = { ...FORM, title: 'Receipt', submitLabel: 'Continue', fields: [{ ...fileQuestion, name: 'receipt', label: 'Upload the receipt' }] };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;
const pdf = () => new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });

describe('FormRunOverlay — file questions', () => {
    it('uploads to the builder\'s endpoint and submits the returned fileId', async () => {
        const user = userEvent.setup();
        const server = fakeServer((call) => {
            if (call.path === '/api/automation/a1/form-test/upload') return { body: { fileId: 'up_1', filename: 'invoice.pdf', size: 4, mimeType: 'application/pdf' } };
            if (call.path.endsWith('/form')) return { body: { runId: 'r1', status: 'running', waiting: false } };
            return null;
        });
        const onStartRun = vi.fn(async () => ({ kind: 'started' as const, runId: 'r1' }));
        const { container } = render(withQueryClient(
            <FormRunOverlay automationId="a1" form={FORM} triggerStepId="trg2" onStartRun={onStartRun} onClose={vi.fn()} followTiming={{ intervalMs: 50 }} />,
        ));

        await user.upload(fileInput(container), pdf());
        expect(await screen.findByText('invoice.pdf')).toBeTruthy();
        const sent = server.posts().find(c => c.path === '/api/automation/a1/form-test/upload');
        const body = sent?.body as FormData;
        expect(body.get('field')).toBe('invoice');
        expect(body.get('triggerStepId')).toBe('trg2');
        expect((body.get('file') as File).name).toBe('invoice.pdf');

        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(onStartRun).toHaveBeenCalled());
        expect((onStartRun.mock.calls[0] as unknown[])[0]).toEqual({ invoice: { kind: 'form_upload', fileId: 'up_1', filename: 'invoice.pdf', size: 4 } });
    });

    it('an upload the server refuses shows its reason on the question', async () => {
        const user = userEvent.setup();
        fakeServer((call) => (call.path.endsWith('/form-test/upload') ? { status: 422, body: { error: 'That file failed a malware scan' } } : null));
        const { container } = render(withQueryClient(<FormRunOverlay automationId="a1" form={FORM} onStartRun={vi.fn()} onClose={vi.fn()} />));
        await user.upload(fileInput(container), pdf());
        expect(await screen.findByText('That file failed a malware scan')).toBeTruthy();
    });

    it('a file question on a later page says where it can be tried, and uploads nothing', async () => {
        const user = userEvent.setup();
        const server = fakeServer((call) => (call.path.endsWith('/form') ? { body: { runId: 'r9', status: 'awaiting_form', waiting: true, stepId: 'fp_2', form: PAGE_TWO } } : null));
        const { container } = render(withQueryClient(<FormRunOverlay automationId="a1" runId="r9" runKind="dry" onStartRun={vi.fn()} onClose={vi.fn()} />));
        expect(await screen.findByText('Receipt')).toBeTruthy();
        await user.upload(fileInput(container), pdf());
        expect(await screen.findByText(/can be tried from the form's test link/)).toBeTruthy();
        expect(server.posts()).toEqual([]);
    });
});
