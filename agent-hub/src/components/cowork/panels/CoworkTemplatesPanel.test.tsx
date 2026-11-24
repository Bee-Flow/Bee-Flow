// Templates, a page of Cowork: "Use" hands a template's sentence to the composer; a task from a file shows who signed
// it before anything is added, and "Add as a paused task" opens the new task. The network is the seam (a recording fetch);
// no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import CoworkTemplatesPanel from './CoworkTemplatesPanel';
import { panelProps } from './panelProps.testkit';

afterEach(() => { vi.unstubAllGlobals(); });

const TEMPLATES = [
    { id: 't1', title: 'Monday summary', brief: 'Every Monday at 09:00, summarise last week’s meetings and send it to me', repeatInterval: 'weekly', hasPlan: false, createdAt: null, mine: false },
    { id: 't2', title: 'Invoice check', brief: 'Check new supplier invoices against the orders', repeatInterval: null, hasPlan: false, createdAt: null, mine: true },
];
const PREVIEW = { title: 'Supplier radar', brief: 'Watch the suppliers.', repeatInterval: 'weekly', plan: null, signedBy: { keyId: 'abcd1234', thisInstallation: true, organisation: 'another_organisation' } };
const file = (text: string) => new File([text], 'supplier-radar.json', { type: 'application/json' });

function serve(preview: object = PREVIEW, templates: object[] = TEMPLATES) {
    return stubRecordingFetch(({ url }) => {
        if (url.endsWith('/api/cowork/templates')) return jsonResponse({ templates });
        if (url.endsWith('/packages/preview')) return jsonResponse(preview);
        if (url.endsWith('/packages/add')) return jsonResponse({ item: { id: 'w9' }, planAttached: false, findings: [] }, 201);
        return jsonResponse({});
    });
}

describe('CoworkTemplatesPanel', () => {
    it('lists the organisation’s templates and "Use" hands the sentence over', async () => {
        serve();
        const onUseText = vi.fn();
        renderWithClient(<CoworkTemplatesPanel {...panelProps({ kind: 'templates' }, { fillComposer: onUseText })} />);
        expect(await screen.findByText('Monday summary')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Use “Invoice check”' }));
        expect(onUseText).toHaveBeenCalledWith('Check new supplier invoices against the orders');
    });

    it('with no templates yet, says where one is saved: a task’s People section', async () => {
        serve(PREVIEW, []);
        renderWithClient(<CoworkTemplatesPanel {...panelProps({ kind: 'templates' })} />);
        expect(await screen.findByText('Your organisation has no templates yet. Save one from a task’s People section.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'Add a task from a file' })).toBeInTheDocument();
    });

    it('names who signed a package file before adding it, then adds it as a paused task and opens that task', async () => {
        const calls = serve();
        const onOpenTask = vi.fn();
        renderWithClient(<CoworkTemplatesPanel {...panelProps({ kind: 'templates' }, { open: (p) => { if (p.kind === 'task') onOpenTask(p.id); } })} />);
        const user = userEvent.setup();
        await user.upload(await screen.findByLabelText('Choose a file'), file(JSON.stringify({ format: 'beeflow.cowork-package', v: 1 })));
        const preview = await screen.findByTestId('cowork-panels-package-preview');
        expect(preview).toHaveTextContent('Signature checked.');
        expect(preview).toHaveTextContent('Signed by another organisation on this Bee Flow, not yours.');
        expect(preview).toHaveTextContent('Nothing was changed since it was signed.');
        expect(preview).toHaveTextContent('Add it only if you know where it comes from.');
        expect(preview).toHaveTextContent('Supplier radar');
        expect(calls.filter((c) => c.url.endsWith('/packages/add'))).toHaveLength(0);
        await user.click(screen.getByRole('button', { name: 'Add as a paused task' }));
        await waitFor(() => expect(onOpenTask).toHaveBeenCalledWith('w9'));
        expect(calls.find((c) => c.url.endsWith('/packages/add'))?.body).toEqual({ package: { format: 'beeflow.cowork-package', v: 1 } });
    });

    it('a package signed by the own organisation needs no warning, and Cancel starts over', async () => {
        serve({ ...PREVIEW, signedBy: { keyId: 'abcd1234', thisInstallation: true, organisation: 'your_organisation' } });
        renderWithClient(<CoworkTemplatesPanel {...panelProps({ kind: 'templates' })} />);
        const user = userEvent.setup();
        await user.upload(await screen.findByLabelText('Choose a file'), file(JSON.stringify({ format: 'beeflow.cowork-package', v: 1 })));
        const preview = await screen.findByTestId('cowork-panels-package-preview');
        expect(preview).toHaveTextContent('Signed by your organisation.');
        expect(preview).not.toHaveTextContent('Add it only if you know');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByLabelText('Choose a file')).toBeInTheDocument();
    });

    it('a file that is no package is said to be none, and nothing is asked', async () => {
        const calls = serve();
        renderWithClient(<CoworkTemplatesPanel {...panelProps({ kind: 'templates' })} />);
        await userEvent.setup().upload(await screen.findByLabelText('Choose a file'), file('not json'));
        expect(await screen.findByRole('alert')).toHaveTextContent('That file is not a task exported from Cowork.');
        expect(calls.filter((c) => c.url.includes('/packages/'))).toHaveLength(0);
    });
});
