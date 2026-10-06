import { describe, expect, it } from 'vitest';
import { discoverColumns, suggestColumns } from './columns';

/**
 * The default columns of a mail list must show who it is from: Microsoft
 * Graph puts `from` near the end of a message, after a dozen flags and ids,
 * and the suggestion used to fill its seven places before it got there.
 */
const MAIL = {
    id: 'AAMk1', createdDateTime: '2026-10-02T07:41:18Z', receivedDateTime: '2026-10-02T07:41:18Z', hasAttachments: true,
    subject: 'Invoice F-2026-0917', bodyPreview: 'Good morning', importance: 'normal', isRead: false, isDraft: false,
    webLink: 'https://outlook.example/1', categories: ['Purchasing'], conversationId: 'c1', inferenceClassification: 'focused',
    toRecipients: [{ emailAddress: { name: 'Purchasing', address: 'p@acme.example' } }],
    from: { emailAddress: { name: 'Ingrid Möller', address: 'ingrid@supplier.example' } },
};

describe('the suggested columns of a mail list', () => {
    it('include the sender, beside the subject', () => {
        const shown = suggestColumns(discoverColumns([MAIL, { ...MAIL, id: 'AAMk2' }]));
        expect(shown[0]).toBe('subject');
        expect(shown).toContain('from');
        expect(shown.length).toBeLessThanOrEqual(7);
    });
});
