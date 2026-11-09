/**
 * The pure mail-trigger helpers the Cowork page uses for its flash line and its save errors,
 * and the payload cleaning the composer and the edit form share.
 */
import { describe, it, expect } from 'vitest';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { CoworkTriggerPayload } from '@/api/cowork.types';
import { createdFlash, saveErrorMessage, normaliseMailTrigger, isMailTriggerItem } from './mailTrigger';

const t = ((_key: string, fallback?: string) => fallback ?? _key) as TranslateFn;

const mailPayload = {
    title: 'Answer new mail', prompt: 'Answer new mail', repeatInterval: null, modelTier: 'auto',
    timezone: 'Europe/Amsterdam', agentId: 'a1', triggerKind: 'app_event',
    trigger: { provider: 'gmail', event: 'mail.new', filter: {} },
} as unknown as CoworkTriggerPayload;

describe('mailTrigger helpers', () => {
    it('says it is watching for mail after a mail trigger is created', () => {
        expect(createdFlash(mailPayload, t)).toBe('Watching for new email.');
    });

    it('explains mail_not_connected, and passes other errors through', () => {
        const refused = Object.assign(new Error('mail_not_connected'), { code: 'mail_not_connected' });
        expect(saveErrorMessage(refused, t)).toMatch(/mail account is not connected/);
        expect(saveErrorMessage(new Error('boom'), t)).toBe('boom');
    });

    it('drops empty filter fields and keys of the other provider', () => {
        expect(normaliseMailTrigger({ provider: 'gmail', event: 'mail.new', filter: { from: '  ann@x.nl ', subjectContains: ' ', labelIds: ['INBOX', ''], mailbox: 'shared@x.nl' } }))
            .toEqual({ provider: 'gmail', event: 'mail.new', filter: { from: 'ann@x.nl', labelIds: ['INBOX'] } });
        expect(normaliseMailTrigger({ provider: 'msgraph', event: 'mail.new', filter: { labelIds: ['INBOX'], mailbox: 'shared@x.nl' } }))
            .toEqual({ provider: 'msgraph', event: 'mail.new', filter: { mailbox: 'shared@x.nl' } });
    });

    it('recognises a mail-trigger item', () => {
        expect(isMailTriggerItem({ triggerKind: 'app_event', trigger: { provider: 'gmail', event: 'mail.new' } })).toBe(true);
        expect(isMailTriggerItem({ triggerKind: 'schedule', trigger: null })).toBe(false);
    });
});
