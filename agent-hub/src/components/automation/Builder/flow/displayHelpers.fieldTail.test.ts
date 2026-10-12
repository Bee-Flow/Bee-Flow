// @vitest-environment node
/**
 * Every surface that names a field after its path — a node's subtitle, the
 * "is a list of" explanation, a used-by line — reads it the way the pills do
 * (refTokens.fieldTailLabel): the leaf key, a generic key with whose it is,
 * and an index as a person counts.
 */
import { describe, expect, it } from 'vitest';
import * as dh from './displayHelpers';
import { fieldTailLabel } from '../mapping/refTokens';

type Fn = (...args: unknown[]) => string;
const humanizeFieldTail = dh.humanizeFieldTail as unknown as Fn;
const humanizeTemplate = dh.humanizeTemplate as unknown as Fn;

describe('humanizeFieldTail labels a path like a pill', () => {
    it.each([
        ['from.emailAddress.address', 'From ▸ Address'],
        ['value[*].toRecipients[*].emailAddress.address', 'To recipients ▸ Address'],
        ['items[0]', 'Items ▸ 1st'],
        ['items[-1]', 'Items ▸ last'],
        ['fields["Story Points"]', 'Story points'],
        ['headers[name="Subject"].value', 'Subject'],
        ['results[*].from_email', 'From email'],
        ['customer.id', 'Customer ▸ Id'],
        ['subject', 'Subject'],
    ])('%s → %s', (path, label) => {
        expect(humanizeFieldTail(path)).toBe(label);
        expect(fieldTailLabel(path)).toBe(label);
    });

    it('text that is no path still reads as its last segment', () => {
        expect(humanizeFieldTail('a.')).toBe('A');
        expect(humanizeFieldTail('')).toBe('');
    });

    it('a template summary tells a sender and a recipient apart', () => {
        const labels = new Map([['mail', 'Mail']]);
        expect(humanizeTemplate('{{steps.mail.output.from.emailAddress.address}} → {{steps.mail.output.toRecipients[0].emailAddress.address}}', labels))
            .toBe('Mail ▸ From ▸ Address → Mail ▸ To recipients ▸ Address');
    });
});
