import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import scopedStorage from '../../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';
import SettingsForm from '../SettingsForm';

/**
 * "Suggest outputs" — the Condition node, told in words what it should do.
 *
 * The node cannot be told anything: a rule's predicate is a restricted-grammar
 * expression, so "split these files by pdf, word and powerpoint" is three
 * `equals(fileType(item), …)` rules — and on mails three `anyOf` rules over
 * every attachment — that nobody types by hand. These tests drive the box the way an author
 * does — type, read the preview, accept — and check what actually lands in the
 * saved step, because the point of the feature is a node that ROUTES, not a
 * node that looks configured and matches nothing.
 */

const noIssues = { errors: [], warnings: [] };

const FILE_ROWS = [
    { name: 'Offerte.pdf' },
    { name: 'Contract.PDF' },          // shouty extension — the file type ignores case
    { name: 'Notulen.docx' },
    { name: 'Oud contract.doc' },
    { name: 'Deck.pptx' },
    { name: 'archief.zip' },           // matches nothing: the otherwise output
];

const DRIVE_GROUP = {
    id: 'd', label: 'drive list', kind: 'integration_action', basePath: 'steps.d.output',
    sample: { files: FILE_ROWS },
    fields: [{ key: 'files', path: 'steps.d.output.files', sample: FILE_ROWS }],
};
const DRIVE_ROOT = { steps: { d: { output: { files: FILE_ROWS } } } };

// Whole-run mode: one upstream field, and no list of rows to count against.
const DOC_GROUP = {
    id: 'g', label: 'get document', kind: 'integration_action', basePath: 'steps.g.output',
    sample: { filename: 'rapport.pdf' },
    fields: [{ key: 'filename', path: 'steps.g.output.filename', sample: 'rapport.pdf' }],
};
const DOC_ROOT = { steps: { g: { output: { filename: 'rapport.pdf' } } } };

// Four demo mails (Fabrikam / Contoso) with 9 attachments: 3 PDF, 1 Word
// (Gmail's octet-stream, read by its extension), 5 images.
const att = (filename, mimeType) => ({ filename, mimeType });
const MAILS = [
    { subject: 'Offer', from: 'sales@fabrikam.example', attachments: [att('offer.pdf', 'application/pdf'), att('terms.docx', 'application/octet-stream'), att('logo.png', 'image/png')] },
    { subject: 'Invoice', from: 'billing@fabrikam.example', attachments: [att('invoice.pdf', 'application/pdf'), att('logo.png', 'image/png')] },
    { subject: 'Minutes', from: 'office@fabrikam.example', attachments: [att('minutes.pdf', 'application/pdf'), att('logo.png', 'image/png')] },
    { subject: 'Hello', from: 'info@contoso.example', attachments: [att('photo.png', 'image/png'), att('logo.png', 'image/png')] },
];
const MAIL_GROUP = {
    id: 'm', label: 'read many', kind: 'integration_action', basePath: 'steps.m.output',
    sample: { messages: MAILS },
    fields: [{ key: 'messages', path: 'steps.m.output.messages', sample: MAILS }],
};
const MAIL_ROOT = { steps: { m: { output: { messages: MAILS } } } };

const FILES_STEP = { id: 'f1', type: 'filter', arrayRef: 'steps.d.output.files', expr: '' };
const IF_STEP = { id: 'r1', type: 'condition', expr: '' };

function renderForm(step, { groups, previewSample, onPatch = vi.fn(), wiredCaseNames = null }) {
    render(
        <VariablePickerProvider groups={groups} previewSample={previewSample} stepLabelById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null}
                onPatch={onPatch} catalog={null} groups={groups} previewSample={previewSample}
                wiredCaseNames={wiredCaseNames}
            />
        </VariablePickerProvider>,
    );
    return { onPatch };
}

const renderFiles = (step = FILES_STEP, onPatch = vi.fn()) =>
    renderForm(step, { groups: [DRIVE_GROUP], previewSample: DRIVE_ROOT, onPatch });

const describeIt = (text) => fireEvent.change(
    screen.getByLabelText('Describe the outputs you want'),
    { target: { value: text } },
);
const save = () => fireEvent.click(screen.getByText('Save'));
// The preview is one <li> per suggested output; its text is assembled from
// the name, the sentence and the count, so read the line as a whole.
const previewLines = () => Array.from(document.querySelectorAll('li'))
    .map(li => li.textContent.replace(/\s+/g, ' ').trim());

describe('Condition editor — Suggest outputs', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('suggest-outputs-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it('lives INSIDE the Outputs section — a section of its own would have to be declared on three node types', () => {
        renderFiles();
        expect(screen.getByText('Suggest outputs')).toBeTruthy();
        // Collapsing the section that owns it takes it with it.
        fireEvent.click(screen.getByText('Output'));
        expect(screen.queryByText('Suggest outputs')).toBeNull();
    });

    it('answers the example that motivated the feature, in sentences and not in code', () => {
        renderFiles();
        describeIt('split these files by pdf, word and powerpoint');

        expect(screen.getByText(/File type is PDF/)).toBeTruthy();
        expect(screen.getByText(/File type is Word/)).toBeTruthy();
        expect(screen.getByText(/File type is PowerPoint/)).toBeTruthy();
        // Never the expression itself — that lives under Advanced, like every
        // other generated expression in this editor.
        expect(screen.queryByText(/fileType\(|equals\(/)).toBeNull();
    });

    it('counts the suggestion against the rows the editor already has', () => {
        renderFiles();
        describeIt('split by pdf, word, powerpoint');

        // Counted with the engine the server runs, against the rows the step
        // above actually produced — ".PDF" included, because the file type
        // ignores case and a Windows scanner does not.
        expect(previewLines()).toEqual([
            'pdf — File type is PDF · 2 of 6 sample files',
            'word — File type is Word · 2 of 6 sample files',
            'powerpoint — File type is PowerPoint · 1 of 6 sample files',
        ]);
        expect(screen.getByText('1 of 6 sample files match none of these and go to “Otherwise”.')).toBeTruthy();
    });

    it('saves nothing until the suggestion is accepted', async () => {
        const { onPatch } = renderFiles();
        describeIt('split by pdf, word, powerpoint');
        // The node is untouched while the preview is on screen.
        expect(screen.getByText('This node has 1 output.')).toBeTruthy();

        fireEvent.click(screen.getByText('Use these 3 outputs'));
        expect(screen.getByText('This node has 3 outputs.')).toBeTruthy();

        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        // Straight through writeRoute: several rules ⇒ a switch, and the
        // fan-out opt-in a router built here gets. (The source list is absent
        // because it did not change — buildPatch sends only what did.)
        expect(patch.type).toBe('switch');
        expect(patch.matchMode).toBe('all');
        expect(patch.cases).toEqual([
            { name: 'pdf', expr: 'equals(fileType(item), "pdf")' },
            { name: 'word', expr: 'equals(fileType(item), "word")' },
            { name: 'powerpoint', expr: 'equals(fileType(item), "powerpoint")' },
        ]);
    });

    it('pre-fills the chooser the node already has instead of asking again', async () => {
        // A two-output router, given a one-output suggestion: the node's own
        // "One output" / "Several outputs" chooser follows the rule count, and
        // writeRoute narrows the step back to a filter. There is no second
        // copy of that question anywhere in the box.
        const { onPatch } = renderFiles({
            id: 's2', type: 'switch', arrayRef: 'steps.d.output.files', routeStyle: 'rules',
            cases: [{ name: 'big', expr: 'item.size > 10' }, { name: 'small', expr: 'item.size <= 10' }],
        });
        expect(screen.getByRole('radio', { name: 'Several outputs' }).getAttribute('aria-checked')).toBe('true');

        describeIt('keep only the pdf ones');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Use this output' }));
        expect(screen.getByRole('radio', { name: 'One output' }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByText('This node has 1 output.')).toBeTruthy();

        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.type).toBe('filter');
        expect(patch.expr).toBe('equals(fileType(item), "pdf")');
        expect(patch.cases).toBeUndefined();
        expect(patch.matchMode).toBeUndefined();
    });

    it('hands the accepted rules to the normal condition builder, still editable', async () => {
        renderFiles();
        describeIt('split by pdf and word');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Use these 2 outputs' }));
        // The rules landed as ordinary rows — named ports with a readable
        // field, not a frozen blob the author now has to live with.
        expect(screen.getByDisplayValue('pdf')).toBeTruthy();
        expect(screen.getByDisplayValue('word')).toBeTruthy();
        expect(screen.getAllByText('File type').length).toBeGreaterThan(0);
        expect(screen.queryByRole('textbox', { name: /expression/i })).toBeNull();
    });

    it('says plainly that it cannot count, instead of a reassuring "1 of 1"', () => {
        renderForm(IF_STEP, { groups: [DOC_GROUP], previewSample: DOC_ROOT });
        describeIt('split by pdf and word');
        expect(screen.getByText(/File type is PDF/)).toBeTruthy();
        expect(screen.getByText(/no sample records here yet, so none of this can be counted/)).toBeTruthy();
        expect(screen.queryByText(/1 of 1/)).toBeNull();
    });

    it('warns before it replaces outputs that are already set up', () => {
        renderFiles({ ...FILES_STEP, expr: 'contains(item.name, "2025")' });
        describeIt('split by pdf and word');
        expect(screen.getByText(/Accepting replaces the output already set up below/)).toBeTruthy();
    });

    /**
     * An accept renames every output of the node at once, which on the canvas
     * means every edge drawn from a name the suggestion does not reuse is
     * gone. The Outputs section states that rule two lines above the box ("an
     * output that disappears takes its connection with it") and honours it
     * everywhere else: collapsing to one output stops and NAMES the wired
     * outputs it would cost, and the trash icon says so in its tooltip.
     *
     * The count of "outputs already set up" cannot carry this on its own,
     * which is the trap: a named output with no condition yet is still a real
     * port with a real edge — routeModel.js keeps such a rule as a case on
     * purpose, so the author can wire the port before writing its condition —
     * and it is invisible to a count of configured rules. A wired `todo`
     * output would have been unwired by an accept with nothing on screen
     * mentioning it, which is the silent-loss shape BFSF-356 is about.
     */
    it('names the wired outputs an accept would unwire, including one with no condition yet', () => {
        renderForm(
            {
                id: 's3', type: 'switch', arrayRef: 'steps.d.output.files', routeStyle: 'rules',
                cases: [{ name: 'big', expr: 'item.size > 10' }, { name: 'todo', expr: '' }],
            },
            { groups: [DRIVE_GROUP], previewSample: DRIVE_ROOT, wiredCaseNames: new Set(['big', 'todo']) },
        );
        describeIt('split by pdf and word');
        // The "already set up" line can only see `big` — `todo` has no
        // condition yet. Both are ports, and both lose their edge.
        expect(screen.getByText(/Accepting replaces the output already set up below/)).toBeTruthy();
        expect(screen.getByText(/big, todo are wired on the canvas and are not in this suggestion, so their connections go too/)).toBeTruthy();
    });

    it('does not call an output a casualty when the suggestion keeps its name', () => {
        renderForm(
            {
                id: 's4', type: 'switch', arrayRef: 'steps.d.output.files', routeStyle: 'rules',
                cases: [{ name: 'pdf', expr: 'item.size > 10' }, { name: 'oud', expr: 'item.size <= 10' }],
            },
            { groups: [DRIVE_GROUP], previewSample: DRIVE_ROOT, wiredCaseNames: new Set(['pdf', 'oud']) },
        );
        describeIt('split by pdf and word');
        // An output that keeps its name keeps its connection — the rule this
        // section states — so only `oud` is named.
        expect(screen.getByText(/oud is wired on the canvas and is not in this suggestion, so its connection goes too/)).toBeTruthy();
    });

    it('says nothing about wiring when nothing is wired', () => {
        renderFiles({ ...FILES_STEP, expr: 'contains(item.name, "2025")' });
        describeIt('split by pdf and word');
        expect(screen.queryByText(/wired on the canvas and/)).toBeNull();
    });

    it('refuses to guess a field rather than building rules that match nothing', () => {
        renderForm(
            { id: 'f2', type: 'filter', arrayRef: 'steps.m.output.messages', expr: '' },
            {
                groups: [{
                    id: 'm', label: 'mail', kind: 'integration_action', basePath: 'steps.m.output',
                    sample: { messages: [{ from_email: 'anna@bee-flow.nl' }] },
                    fields: [{ key: 'messages', path: 'steps.m.output.messages', sample: [{ from_email: 'anna@bee-flow.nl' }] }],
                }],
                previewSample: { steps: { m: { output: { messages: [{ from_email: 'anna@bee-flow.nl' }] } } } },
            },
        );
        describeIt('split by pdf and word');
        // ".nl" is not a file extension, and an e-mail address is not a file
        // name — so it says so instead of routing on one.
        expect(screen.getByText(/Nothing here looks like a file name/)).toBeTruthy();
        expect(screen.queryByText(/Use these/)).toBeNull();
    });

    it('on mails, checks every attachment and offers to check each attachment instead (J1, J3)', async () => {
        const { onPatch } = renderForm(
            { id: 'f3', type: 'filter', arrayRef: 'steps.m.output.messages', expr: '' },
            { groups: [MAIL_GROUP], previewSample: MAIL_ROOT },
        );
        describeIt('split by pdf and word');
        expect(previewLines()).toEqual([
            'pdf — any attachment · File type is PDF · 3 of 4 sample messages',
            'word — any attachment · File type is Word · 1 of 4 sample messages',
        ]);
        expect(screen.getByText(/a message with a PDF and a Word file goes down both/)).toBeTruthy();

        // Check each attachment: the node now works through the attachments,
        // the sentence stays and is read again against them.
        await userEvent.setup().click(screen.getByRole('button', { name: 'Check each attachment instead' }));
        expect(previewLines()).toEqual([
            'pdf — File type is PDF · 3 of 9 sample attachments',
            'word — File type is Word · 1 of 9 sample attachments',
        ]);
        expect(screen.getByText('5 of 9 sample attachments match none of these and go to “Otherwise”.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Check each/ })).toBeNull();

        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls[0][0].arrayRef).toBe('steps.m.output.messages[*].attachments');
    });

    it('names what it did not understand', () => {
        renderFiles();
        describeIt('do the usual thing here');
        expect(screen.getByText(/Nothing recognised there yet/)).toBeTruthy();
    });
});

describe('Condition editor — the output name field speaks plain words', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('suggest-outputs-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it('asks for a name instead of a "case name (becomes the port label)"', () => {
        renderForm(
            { id: 's1', type: 'switch', cases: [{ name: 'big', expr: 'a > 10' }, { name: 'small', expr: 'a <= 10' }] },
            { groups: [DOC_GROUP], previewSample: DOC_ROOT },
        );
        expect(screen.queryByPlaceholderText(/case name/i)).toBeNull();
        expect(screen.getAllByPlaceholderText('Name this output — for example invoices').length).toBe(2);
    });
});
