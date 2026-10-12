import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { editorWithValue, typeInEditor } from '../../../../../test/refEditor';
import { MAIL_GROUP, MAILS, renderRoute } from './routeEditors.harness';

/**
 * R11: changing the list a Condition works through never drops a rule
 * silently. One level in (messages → their attachments) the rules quantified
 * over the attachments move onto the attachment itself; rules the new item
 * cannot read stay, are named, and go only on a click.
 */
const RULE = 'contains(item.from, "fabrikam") && anyOf(fileType(item.attachments[*]), "equals", "pdf")';
const FILTER = { id: 'f1', type: 'filter', arrayRef: 'steps.m.output.messages', expr: RULE };
const CONTACTS = [{ name: 'Fabrikam', email: 'info@fabrikam.example' }];
const GROUPS = [
    MAIL_GROUP,
    {
        id: 'c', label: 'Contacts', kind: 'integration_action', basePath: 'steps.c.output',
        sample: { contacts: CONTACTS }, fields: [{ key: 'contacts', path: 'steps.c.output.contacts', sample: CONTACTS }],
    },
];
const ROOT = { steps: { m: { output: { messages: MAILS } }, c: { output: { contacts: CONTACTS } } } };

const changeListTo = (path: string) => typeInEditor(editorWithValue(document.body, 'steps.m.output.messages'), path);

afterEach(cleanup);

describe('changing the list one level in (L → L[*].attachments)', () => {
    it('moves the attachment rule onto the attachment and names the rule that no longer fits', () => {
        const { saved } = renderRoute(FILTER, { groups: GROUPS, previewSample: ROOT });
        changeListTo('steps.m.output.messages[*].attachments');
        expect(saved()).toMatchObject({
            type: 'filter',
            arrayRef: 'steps.m.output.messages[*].attachments',
            expr: 'contains(item.from, "fabrikam") && equals(fileType(item), "pdf")',
        });
        expect(screen.getByText('These rules read From, which each attachment doesn’t have.')).toBeTruthy();
    });

    it('"Remove those rules" removes exactly them, in one more edit', async () => {
        const { saved } = renderRoute(FILTER, { groups: GROUPS, previewSample: ROOT });
        changeListTo('steps.m.output.messages[*].attachments');
        await userEvent.click(screen.getByRole('button', { name: 'Remove those rules' }));
        expect(saved()).toMatchObject({ type: 'filter', expr: 'equals(fileType(item), "pdf")' });
        expect(screen.queryByText(/which each attachment doesn’t have/)).toBeNull();
    });

    it('"Remove those rules" hands focus to a place that stays, and says what it did', async () => {
        renderRoute(FILTER, { groups: GROUPS, previewSample: ROOT });
        changeListTo('steps.m.output.messages[*].attachments');
        await userEvent.click(screen.getByRole('button', { name: 'Remove those rules' }));
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement?.textContent).toBe('Done: those rules are removed.');
    });

    it('"no attachment is a PDF" becomes "is not a PDF" on each attachment', () => {
        const { saved } = renderRoute(
            { ...FILTER, expr: 'noneOf(fileType(item.attachments[*]), "equals", "pdf")' },
            { groups: GROUPS, previewSample: ROOT },
        );
        changeListTo('steps.m.output.messages[*].attachments');
        expect(saved()).toMatchObject({ expr: '!equals(fileType(item), "pdf")' });
        expect(screen.queryByText(/doesn’t have/)).toBeNull();
    });
});

describe('changing to an unrelated list', () => {
    it('rewrites nothing, and lists every field the new item lacks', () => {
        const { saved } = renderRoute(FILTER, { groups: GROUPS, previewSample: ROOT });
        changeListTo('steps.c.output.contacts');
        expect(saved()).toMatchObject({ arrayRef: 'steps.c.output.contacts', expr: RULE });
        expect(screen.getByText(/These rules read From, .+, which each contact doesn’t have\./)).toBeTruthy();
    });

    it('a rule written as a formula is left exactly as it was', () => {
        const formula = 'len(item.attachments) > 1 || lower(item.subject) == "x"';
        const { saved } = renderRoute({ ...FILTER, expr: formula }, { groups: GROUPS, previewSample: ROOT });
        changeListTo('steps.c.output.contacts');
        expect(saved()).toMatchObject({ arrayRef: 'steps.c.output.contacts', expr: formula });
        expect(screen.queryByText(/doesn’t have/)).toBeNull();
    });
});
