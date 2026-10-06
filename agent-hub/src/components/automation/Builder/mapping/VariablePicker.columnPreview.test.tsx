/**
 * The {} picker previews a column the way the Comes-in panel does — its first
 * values "a · b · c" — not as "[3 items]". Only a list of records with no
 * column picked keeps its count.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import VariablePickerJs from './VariablePicker';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const VariablePicker = VariablePickerJs as unknown as Loose;

const VALUE = [
    { id: 'AAMk1', subject: 'Invoice F-1' },
    { id: 'AAMk2', subject: 'RE: delivery' },
    { id: 'AAMk3', subject: 'Hello' },
];
const ROOT = { steps: { graph: { output: { value: VALUE } } } };
const GROUPS = [{
    id: 'graph', label: 'Graph', kind: 'integration_action', basePath: 'steps.graph.output',
    fields: [{
        key: 'value', path: 'steps.graph.output.value', sample: VALUE,
        children: [
            { key: 'id', path: 'steps.graph.output.value[*].id', sample: 'AAMk1' },
            { key: 'subject', path: 'steps.graph.output.value[*].subject', sample: 'Invoice F-1' },
        ],
    }],
}];

afterEach(() => cleanup());

const MAIL = [
    { from: { emailAddress: { address: 'ada@x.nl', name: 'Ada' } } },
    { from: { emailAddress: { address: 'bob@x.nl', name: 'Bob' } } },
];
const MAIL_GROUPS = [{
    id: 'mail', label: 'Read the purchasing inbox', kind: 'integration_action', basePath: 'steps.mail.output',
    fields: [{
        key: 'value', path: 'steps.mail.output.value', sample: MAIL,
        children: [{
            key: 'from', path: 'steps.mail.output.value[*].from', sample: MAIL[0].from,
            children: [{
                key: 'emailAddress', path: 'steps.mail.output.value[*].from.emailAddress', sample: MAIL[0].from.emailAddress,
                children: [
                    { key: 'address', path: 'steps.mail.output.value[*].from.emailAddress.address', sample: 'ada@x.nl' },
                    { key: 'name', path: 'steps.mail.output.value[*].from.emailAddress.name', sample: 'Ada' },
                ],
            }],
        }],
    }],
}];
const MAIL_ROOT = { steps: { mail: { output: { value: MAIL } } } };

describe('VariablePicker — search, names and group rows', () => {
    it('a search reveals the matching deep rows, not just their collapsed parent', async () => {
        const user = userEvent.setup();
        render(<VariablePicker open anchorEl={document.body} groups={MAIL_GROUPS} previewSample={MAIL_ROOT} onPick={() => {}} onClose={() => {}} />);
        await user.type(screen.getByPlaceholderText('Search variables…'), 'address');
        expect(screen.getByText('ada@x.nl · bob@x.nl')).toBeTruthy();
        expect(document.querySelector("[title='steps.mail.output.value[*].from.emailAddress.address']")).toBeTruthy();
    });

    it('a row that opens into its own fields shows no "[n items]"; its name never shrinks first', () => {
        render(<VariablePicker open anchorEl={document.body} groups={MAIL_GROUPS} previewSample={MAIL_ROOT} onPick={() => {}} onClose={() => {}} />);
        const row = document.querySelector("[title='steps.mail.output.value']") as HTMLElement;
        expect(row.textContent).not.toContain('items]');
        expect(row.querySelector('[data-picker-name]')?.className).toContain('shrink-0');
    });
});

describe('VariablePicker — column previews', () => {
    it('a column shows its first values; a list of records without columns keeps its count', async () => {
        const user = userEvent.setup();
        const flat = [{ ...GROUPS[0], fields: [{ ...GROUPS[0].fields[0], children: undefined }] }];
        render(<VariablePicker open anchorEl={document.body} groups={flat} previewSample={ROOT} onPick={() => {}} onClose={() => {}} />);
        expect(screen.getByText('[3 items]')).toBeTruthy();
        cleanup();
        render(<VariablePicker open anchorEl={document.body} groups={GROUPS} previewSample={ROOT} onPick={() => {}} onClose={() => {}} />);
        await user.click(screen.getByRole('button', { name: 'Expand' }));
        expect(screen.getByText('AAMk1 · AAMk2 · AAMk3')).toBeTruthy();
        expect(screen.getByText('Invoice F-1 · RE: delivery · Hello')).toBeTruthy();
        // Neither column row says "[3 items]" (the hover panel may, for the list).
        for (const path of ['steps.graph.output.value[*].id', 'steps.graph.output.value[*].subject']) {
            expect(document.querySelector(`[title='${path}']`)?.textContent).not.toContain('items]');
        }
    });
});
