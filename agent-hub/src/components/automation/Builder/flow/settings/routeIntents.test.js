import { describe, it, expect } from 'vitest';
import { describeRuleExpr, ruleSentence } from '../displayHelpers';
import { suggestOutputs, matchCounts, slugName } from './routeIntents';

/**
 * The offline intent catalogue behind "Suggest outputs".
 *
 * These tests pin EXACT expressions on purpose. The whole promise of the box
 * is that the author never has to know that "word" is two extensions and that
 * the operator they need is "ends with"; if the generated expression drifts,
 * the node quietly matches nothing at runtime and reports no error — the
 * failure this feature exists to remove.
 */

// The fields the rule rows would offer for a list of Drive/Gmail attachments.
const FILE_FIELDS = [
    { path: 'item.name', label: 'Name', sample: 'Offerte 2026.pdf' },
    { path: 'item.from_email', label: 'From email', sample: 'anna@bee-flow.nl' },
    { path: 'item.size', label: 'Size', sample: 20481 },
];

// A mail with its attachments, and the rule menu shared ruleFieldOptions
// builds for it: the attachments once as a list, then their own group.
const MAIL = {
    subject: 'Offer Fabrikam', from: 'sales@fabrikam.example',
    attachments: [
        { filename: 'offer.pdf', mimeType: 'application/pdf', size: 1200 },
        { filename: 'logo.png', mimeType: 'image/png', size: 300 },
    ],
};
const MAIL_FIELDS = [
    { path: 'item.subject', label: 'Subject', sample: MAIL.subject, group: 'Fields of each message' },
    { path: 'item.from', label: 'From', sample: MAIL.from, group: 'Fields of each message' },
    { path: 'item.attachments', label: 'Attachments', sample: MAIL.attachments, group: 'Fields of each message', kind: 'records' },
    { path: 'fileType(item.attachments[*])', label: 'File type', sample: 'pdf', group: 'Attachments of each message', quantified: true, kind: 'fileType' },
    { path: 'item.attachments[*].filename', label: 'Filename', sample: 'offer.pdf', group: 'Attachments of each message', quantified: true },
    { path: 'item.attachments[*].mimeType', label: 'Mime type', sample: 'application/pdf', group: 'Attachments of each message', quantified: true },
];

describe('routeIntents — file types (the example that motivated the feature)', () => {
    it('answers "split these files by pdf, word, powerpoint" with three named outputs', () => {
        const s = suggestOutputs('split these files by pdf, word, powerpoint', { fields: FILE_FIELDS });
        expect(s.kind).toBe('fileType');
        expect(s.rules.map(r => r.name)).toEqual(['pdf', 'word', 'powerpoint']);
        expect(s.field.path).toBe('item.name');
        expect(s.problem).toBeNull();
        expect(s.filesInside).toBeNull();
    });

    it('checks the file type of a name field with fileType(), not a list of extensions', () => {
        const s = suggestOutputs('split by word and powerpoint', { fields: FILE_FIELDS });
        const byName = Object.fromEntries(s.rules.map(r => [r.name, r.expr]));
        expect(byName.word).toBe('equals(fileType(item.name), "word")');
        expect(byName.powerpoint).toBe('equals(fileType(item.name), "powerpoint")');
    });

    it('produces outputs in the order they were asked for', () => {
        const s = suggestOutputs('powerpoint first, then pdf', { fields: FILE_FIELDS });
        expect(s.rules.map(r => r.name)).toEqual(['powerpoint', 'pdf']);
    });

    it('names each output with the word the author used: csv is the excel type, named csv', () => {
        const s = suggestOutputs('split by csv and pdf', { fields: FILE_FIELDS });
        expect(s.rules).toEqual([
            { name: 'csv', expr: 'equals(fileType(item.name), "excel")' },
            { name: 'pdf', expr: 'equals(fileType(item.name), "pdf")' },
        ]);
    });

    it('reads back as a sentence through the canvas describer, never as code', () => {
        const s = suggestOutputs('keep only the pdf files', { fields: FILE_FIELDS });
        expect(ruleSentence(s.rules[0].expr)).toBe('File type is PDF');
    });

    it('checks the item itself when each item is a file', () => {
        const element = { name: 'Offerte 2026.pdf', mimeType: 'application/pdf', size: 20481 };
        const s = suggestOutputs('split by pdf and word', { fields: FILE_FIELDS, element });
        expect(s.rules).toEqual([
            { name: 'pdf', expr: 'equals(fileType(item), "pdf")' },
            { name: 'word', expr: 'equals(fileType(item), "word")' },
        ]);
        expect(s.field.path).toBe('fileType(item)');
        expect(s.filesInside).toBeNull();
    });

    it('uses the File type entry the rule menu offers when there is no item sample', () => {
        const fields = [{ path: 'fileType(item)', label: 'File type', sample: 'pdf', kind: 'fileType' }, ...FILE_FIELDS];
        const s = suggestOutputs('keep the pdfs', { fields });
        expect(s.rules).toEqual([{ name: 'pdfs', expr: 'equals(fileType(item), "pdf")' }]);
        expect(s.field.label).toBe('File type');
    });

});

describe('routeIntents — file types on mails (the files inside each item)', () => {
    it('on mails, checks EVERY attachment and says the files sit inside each item', () => {
        const s = suggestOutputs('split these by pdf, word and powerpoint', { fields: MAIL_FIELDS, element: MAIL });
        expect(s.rules).toEqual([
            { name: 'pdf', expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")' },
            { name: 'word', expr: 'anyOf(fileType(item.attachments[*]), "equals", "word")' },
            { name: 'powerpoint', expr: 'anyOf(fileType(item.attachments[*]), "equals", "powerpoint")' },
        ]);
        expect(s.filesInside).toEqual({ listPath: 'item.attachments', listKey: 'attachments' });
        expect(s.field.path).toBe('fileType(item.attachments[*])');
        expect(ruleSentence(s.rules[0].expr)).toBe('any attachment · File type is PDF');
    });

    it('finds the attachments from the rule menu alone (ruleFieldOptions), without an item sample', () => {
        const s = suggestOutputs('mails with a pdf', { fields: MAIL_FIELDS });
        expect(s.rules).toEqual([{ name: 'pdf', expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")' }]);
        expect(s.filesInside).toEqual({ listPath: 'item.attachments', listKey: 'attachments' });
    });

    it('never compares a list column or a list of records directly', () => {
        const s = suggestOutputs('subject contains "invoice"', { fields: MAIL_FIELDS, element: MAIL });
        expect(s.rules).toEqual([{ name: 'invoice', expr: 'contains(item.subject, "invoice")' }]);
    });

    it('asks for the file types when a sentence is about files but names none', () => {
        const s = suggestOutputs('split the attachments', { fields: MAIL_FIELDS, element: MAIL });
        expect(s.rules).toEqual([]);
        expect(s.problemCode).toBe('name_types');
        expect(s.problem).toBe('Name the file types to split by, for example “pdf, word and powerpoint”.');
        expect(s.filesInside).toEqual({ listPath: 'item.attachments', listKey: 'attachments' });
    });

    it('does NOT mistake an e-mail address for a file name — ".nl" is not an extension', () => {
        const s = suggestOutputs('split by pdf and word', {
            fields: [{ path: 'item.from_email', label: 'From email', sample: 'anna@bee-flow.nl' }],
        });
        expect(s.rules).toEqual([]);
        expect(s.problem).toMatch(/Nothing here looks like a file name/);
    });

    it('honours a field the author named over the sample heuristic', () => {
        const s = suggestOutputs('split by pdf when the title is a pdf', {
            fields: [
                { path: 'item.name', label: 'Name', sample: 'note.pdf' },
                { path: 'item.title', label: 'Title', sample: 'Quarterly report' },
            ],
        });
        expect(s.field.path).toBe('item.title');
        expect(s.rules[0].expr).toBe('equals(fileType(item.title), "pdf")');
    });

    it('refuses to invent a path when there is no sample data at all', () => {
        const s = suggestOutputs('split by pdf and word', { fields: [] });
        expect(s.rules).toEqual([]);
        expect(s.problem).toMatch(/no sample data for this step yet/);
    });
});

describe('routeIntents — words, numbers and dates', () => {
    it('makes one output per quoted phrase', () => {
        const s = suggestOutputs('split the subject on "urgent" and "invoice"', {
            fields: [{ path: 'item.subject', label: 'Subject', sample: 'Nextcloud ISV contract' }],
        });
        expect(s.kind).toBe('contains');
        expect(s.rules).toEqual([
            { name: 'urgent', expr: 'contains(item.subject, "urgent")' },
            { name: 'invoice', expr: 'contains(item.subject, "invoice")' },
        ]);
    });

    it('compares numbers on the field the author named', () => {
        const s = suggestOutputs('amount over 1000', {
            fields: [{ path: 'item.amount', label: 'Amount', sample: 250 }],
        });
        expect(s.rules).toEqual([{ name: 'over_1000', expr: 'item.amount > 1000' }]);
        expect(describeRuleExpr(s.rules[0].expr)).toBe('Amount greater than 1000');
    });

    it('reads "no more than 100" as ONE at-most output, not also as "more than 100"', () => {
        const s = suggestOutputs('amount no more than 100', {
            fields: [{ path: 'item.amount', label: 'Amount', sample: 250 }],
        });
        expect(s.rules).toEqual([{ name: 'at_most_100', expr: 'item.amount <= 100' }]);
    });

    it('closes a date range on the day AFTER the end date so the last day is not lost', () => {
        const s = suggestOutputs('created between 2026-01-01 and 2026-01-31', {
            fields: [{ path: 'item.created', label: 'Created', sample: '2026-01-04T09:12:00Z' }],
        });
        expect(s.rules).toEqual([{
            name: 'between_2026_01_01_and_2026_01_31',
            expr: 'item.created >= "2026-01-01" && item.created < "2026-02-01"',
        }]);
        // A timestamp ON the last day still matches — the whole reason for it.
        expect(matchCounts(s.rules, [{ created: '2026-01-31T14:02:00Z' }]).perRule[0].matched).toBe(1);
    });

    it('says out loud that a relative date is not something it can work out', () => {
        const s = suggestOutputs('everything from last week', {
            fields: [{ path: 'item.created', label: 'Created', sample: '2026-01-04' }],
        });
        expect(s.rules).toEqual([]);
        expect(s.problem).toMatch(/2026-01-31/);
    });

    it('names what it did not understand instead of guessing', () => {
        const s = suggestOutputs('do the usual thing', { fields: FILE_FIELDS });
        expect(s.rules).toEqual([]);
        expect(s.problem).toMatch(/Nothing recognised there yet/);
    });

    it('is silent on an empty description', () => {
        const s = suggestOutputs('   ', { fields: FILE_FIELDS });
        expect(s.rules).toEqual([]);
        expect(s.problem).toBeNull();
    });
});

describe('routeIntents — counting against real sample rows', () => {
    const rows = [
        { name: 'Offerte.pdf' }, { name: 'Contract.PDF' },
        { name: 'Notes.docx' }, { name: 'Oud.doc' },
        { name: 'Deck.pptx' }, { name: 'archief.zip' },
    ];

    it('counts each output and what falls through, with the engine the server runs', () => {
        const s = suggestOutputs('split by pdf, word, powerpoint', { fields: FILE_FIELDS });
        const counts = matchCounts(s.rules, rows);
        expect(counts.total).toBe(6);
        expect(counts.perRule).toEqual([
            { name: 'pdf', matched: 2, failed: 0 },   // ".PDF" too — the extension ignores case
            { name: 'word', matched: 2, failed: 0 },
            { name: 'powerpoint', matched: 1, failed: 0 },
        ]);
        expect(counts.unmatched).toBe(1);
    });

    it('counts a mail once per output however many of its attachments match', () => {
        const mails = [
            MAIL,
            { subject: 'Contoso', attachments: [{ filename: 'notes.docx', mimeType: 'application/octet-stream' }] },
            { subject: 'No files', attachments: [] },
        ];
        const s = suggestOutputs('split by pdf and word', { fields: MAIL_FIELDS, element: MAIL });
        const counts = matchCounts(s.rules, mails);
        // Gmail's octet-stream falls back to the extension: notes.docx is Word.
        expect(counts.perRule.map(r => r.matched)).toEqual([1, 1]);
        expect(counts.unmatched).toBe(1);
    });

    it('evaluates with the run\'s scope: the item and its position (_index)', () => {
        const counts = matchCounts([{ name: 'first_two', expr: '_index < 2' }], ['a', 'b', 'c']);
        expect(counts.perRule[0]).toEqual({ name: 'first_two', matched: 2, failed: 0 });
        expect(counts.unmatched).toBe(1);
    });

    it('returns null when there are no real sample rows — never a reassuring "1 of 1"', () => {
        const s = suggestOutputs('split by pdf', { fields: FILE_FIELDS });
        expect(matchCounts(s.rules, null)).toBeNull();
        expect(matchCounts(s.rules, undefined)).toBeNull();
    });

    it('treats a row that is missing the field as a non-match, exactly like the runtime', () => {
        const s = suggestOutputs('split by pdf', { fields: FILE_FIELDS });
        const counts = matchCounts(s.rules, [{ subject: 'no name field here' }]);
        expect(counts.perRule[0]).toEqual({ name: 'pdf', matched: 0, failed: 0 });
        expect(counts.unmatched).toBe(1);
    });
});

describe('routeIntents — port names', () => {
    it('keeps names wireable: lowercase, word characters only', () => {
        expect(slugName('between 2026-01-01 and 2026-01-31')).toBe('between_2026_01_01_and_2026_01_31');
        expect(slugName('  !!  ')).toBe('output');
    });

    it('never mints the same port name twice', () => {
        const s = suggestOutputs('subject contains "urgent!" and "urgent?"', {
            fields: [{ path: 'item.subject', label: 'Subject', sample: 'x' }],
        });
        expect(s.rules.map(r => r.name)).toEqual(['urgent', 'urgent_2']);
    });
});
