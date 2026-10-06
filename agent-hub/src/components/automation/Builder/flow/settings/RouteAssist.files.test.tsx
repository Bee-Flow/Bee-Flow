/**
 * "Suggest outputs" on mails and on files (spec S1, S3, S4, S5): sentences
 * instead of code, the Otherwise story, and the way from "look at the
 * attachments of each mail" to "check each attachment".
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/flow/settings/RouteAssist.files.test.tsx
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RouteAssistJs from './RouteAssist';

// RouteAssist is JavaScript: its defaults would otherwise narrow the props.
const RouteAssist = RouteAssistJs as unknown as ComponentType<Record<string, unknown>>;

const pdf = (name: string) => ({ filename: name, mimeType: 'application/pdf' });
const word = (name: string) => ({ filename: name, mimeType: 'application/octet-stream' }); // Gmail: by extension
const png = (name: string) => ({ filename: name, mimeType: 'image/png' });

// Four demo mails (Fabrikam / Contoso): three hold a PDF.
const MAILS = [
    { subject: 'Offer', from: 'sales@fabrikam.example', attachments: [pdf('offer.pdf'), word('terms.docx'), png('logo.png')] },
    { subject: 'Invoice', from: 'billing@fabrikam.example', attachments: [pdf('invoice.pdf'), png('logo.png')] },
    { subject: 'Minutes', from: 'office@fabrikam.example', attachments: [pdf('minutes.pdf'), png('logo.png')] },
    { subject: 'Hello', from: 'info@contoso.example', attachments: [png('logo.png')] },
];
const MAIL_FIELDS = [
    { path: 'item.subject', label: 'Subject', sample: 'Offer', group: 'Fields of each message' },
    { path: 'item.from', label: 'From', sample: 'sales@fabrikam.example', group: 'Fields of each message' },
    { path: 'item.attachments', label: 'Attachments', sample: MAILS[0].attachments, group: 'Fields of each message', kind: 'records' },
    { path: 'fileType(item.attachments[*])', label: 'File type', sample: 'pdf', group: 'Attachments of each message', quantified: true, kind: 'fileType' },
    { path: 'item.attachments[*].filename', label: 'Filename', sample: 'offer.pdf', group: 'Attachments of each message', quantified: true },
];
const SOURCE = 'steps.mc_read_many.output.messages';

function renderMails(props: Record<string, unknown> = {}) {
    const onWorkThroughList = vi.fn();
    const onApply = vi.fn();
    render(
        <RouteAssist
            fields={MAIL_FIELDS}
            sampleRows={MAILS}
            sampleRoot={{}}
            unit="messages"
            itemSample={MAILS[0]}
            sourceRef={SOURCE}
            onApply={onApply}
            onWorkThroughList={onWorkThroughList}
            {...props}
        />,
    );
    return { onWorkThroughList, onApply };
}

const lines = () => Array.from(document.querySelectorAll('li')).map(li => (li.textContent || '').replace(/\s+/g, ' ').trim());

async function describeOutputs(text: string) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Describe the outputs you want'), text);
    return user;
}

afterEach(cleanup);

describe('Suggest outputs on mails', () => {
    it('checks every attachment, reads back in words and counts like the run (J1)', async () => {
        renderMails();
        await describeOutputs('mails with a pdf');
        expect(lines()).toEqual(['pdf — any attachment · File type is PDF · 3 of 4 sample messages']);
        expect(screen.getByText('1 of 4 sample messages don’t match and stop here.')).toBeTruthy();
        expect(screen.queryByText(/anyOf|fileType\(/)).toBeNull();
        // One output: the "goes down both" note is about several outputs only.
        expect(screen.queryByText(/goes down both/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Check each attachment instead' })).toBeTruthy();
    });

    it('says a mail goes down several outputs, and Check each works through the attachments (J3)', async () => {
        const { onWorkThroughList } = renderMails();
        const user = await describeOutputs('split by pdf and word');
        expect(lines()).toEqual([
            'pdf — any attachment · File type is PDF · 3 of 4 sample messages',
            'word — any attachment · File type is Word · 1 of 4 sample messages',
        ]);
        expect(screen.getByText('1 of 4 sample messages match none of these and go to “Otherwise”.')).toBeTruthy();
        expect(screen.getByText(
            'These outputs look at the attachments of each message: a message with a PDF and a Word file goes down both.',
        )).toBeTruthy();
        expect(screen.getByText('Splits the attachments themselves, one by one.')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Check each attachment instead' }));
        expect(onWorkThroughList).toHaveBeenCalledWith('steps.mc_read_many.output.messages[*].attachments');
        // The sentence stays, so the box suggests again against the new list.
        expect((screen.getByLabelText('Describe the outputs you want') as HTMLInputElement).value).toBe('split by pdf and word');
    });

    it('asks for the file types when the sentence names none, and still offers Check each', async () => {
        renderMails();
        await describeOutputs('split the attachments');
        expect(screen.getByText('Name the file types to split by, for example “pdf, word and powerpoint”.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Check each attachment instead' })).toBeTruthy();
    });

    it('says nothing about the unmatched when every sample message matches an output (S5, n = 0)', async () => {
        renderMails();
        await describeOutputs('split by pdf and image');
        expect(lines()).toHaveLength(2);
        expect(screen.queryByText(/match none of these/)).toBeNull();
        expect(screen.queryByText(/0 of 4/)).toBeNull();
    });

    it('offers no Check each where the surface cannot change the list', async () => {
        renderMails({ onWorkThroughList: undefined });
        await describeOutputs('split by pdf and word');
        expect(screen.getByText(/goes down both/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Check each/ })).toBeNull();
    });

    it('accepts with a primary button', async () => {
        const { onApply } = renderMails();
        const user = await describeOutputs('split by pdf and word');
        const accept = screen.getByRole('button', { name: 'Use these 2 outputs' });
        // O1: a filled button in the inverted text colours, never the grey accent that reads as disabled.
        expect(accept.className).toContain('bg-[var(--text-primary)]');
        expect(accept.className).not.toContain('accent');
        await user.click(accept);
        expect(onApply).toHaveBeenCalledWith([
            { name: 'pdf', expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")' },
            { name: 'word', expr: 'anyOf(fileType(item.attachments[*]), "equals", "word")' },
        ]);
    });
});

describe('Suggest outputs on mails: router mode, keep-rest and focus', () => {
    it('on a first-match router says the mail goes down the first output that matches, not both', async () => {
        renderMails({ fanOut: false });
        await describeOutputs('split by pdf and word');
        expect(screen.queryByText(/goes down both/)).toBeNull();
        expect(screen.getByText(
            'These outputs look at the attachments of each message: a message with a PDF and a Word file goes down the first matching output only.',
        )).toBeTruthy();
    });

    it('with one output that sends the rest to Otherwise, says the unmatched go to Otherwise', async () => {
        renderMails({ keepRest: true });
        await describeOutputs('mails with a pdf');
        expect(screen.queryByText(/stop here/)).toBeNull();
        expect(screen.getByText('1 of 4 sample messages don’t match and go to “Otherwise”.')).toBeTruthy();
    });

    it('keeps focus in the box when Check each removes its own note', async () => {
        function Stateful() {
            const [source, setSource] = useState(SOURCE);
            return (
                <RouteAssist
                    fields={MAIL_FIELDS} sampleRows={MAILS} sampleRoot={{}} unit="messages"
                    itemSample={source === SOURCE ? MAILS[0] : MAILS[0].attachments[0]}
                    sourceRef={source} onApply={vi.fn()} onWorkThroughList={setSource}
                />
            );
        }
        render(<Stateful />);
        const user = await describeOutputs('split by pdf and word');
        await user.click(screen.getByRole('button', { name: 'Check each attachment instead' }));
        expect(screen.queryByRole('button', { name: /Check each/ })).toBeNull();
        expect(document.activeElement).toBe(screen.getByLabelText('Describe the outputs you want'));
    });
});

describe('Suggest outputs on files', () => {
    const FILES = [
        { name: 'offer.pdf', mimeType: 'application/pdf' },
        { name: 'terms.docx', mimeType: 'application/octet-stream' },
        { name: 'deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
        { name: 'logo.png', mimeType: 'image/png' },
    ];
    const FILE_FIELDS = [
        { path: 'fileType(item)', label: 'File type', sample: 'pdf', group: 'Fields of each attachment', kind: 'fileType' },
        { path: 'item.name', label: 'Name', sample: 'offer.pdf', group: 'Fields of each attachment' },
    ];

    it('checks each file itself and offers no Check each (J3 after the switch)', async () => {
        render(
            <RouteAssist
                fields={FILE_FIELDS} sampleRows={FILES} sampleRoot={{}} unit="attachments"
                itemSample={FILES[0]} sourceRef={`${SOURCE}[*].attachments`} onApply={vi.fn()} onWorkThroughList={vi.fn()}
            />,
        );
        await describeOutputs('split these files by pdf, word and powerpoint');
        expect(screen.getByText('Split by file type — 3 outputs, using File type:')).toBeTruthy();
        expect(lines()).toEqual([
            'pdf — File type is PDF · 1 of 4 sample attachments',
            'word — File type is Word · 1 of 4 sample attachments',
            'powerpoint — File type is PowerPoint · 1 of 4 sample attachments',
        ]);
        expect(screen.getByText('1 of 4 sample attachments match none of these and go to “Otherwise”.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Check each/ })).toBeNull();
    });
});
