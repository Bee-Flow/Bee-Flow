import { describe, expect, it } from 'vitest';
import { describeRuleExpr, ruleSentence } from './displayHelpers';

/**
 * A rule as the sentence its clickable rows read (C1, C3): the canvas card,
 * the Suggest-outputs preview and the run panel all use it. Never a path, a
 * function name or a step id.
 */
const LABELS = new Map([['mc_read_many', 'Read many'], ['ai_1', 'Classify']]);

describe('ruleSentence: every row shape the builder writes (R3)', () => {
    it.each([
        ['equals(item.status, "Open")', 'Status is “Open”'],
        ['!equals(item.status, "Closed")', 'Status is not “Closed”'],
        ['contains(item.from, "fabrikam")', 'From contains “fabrikam”'],
        ['!contains(item.subject, "spam")', 'Subject does not contain “spam”'],
        ['startsWith(item.subject, "RE:")', 'Subject starts with “RE:”'],
        ['endsWith(item.filename, ".pdf")', 'Filename ends with “.pdf”'],
        ['item.amount > 1000', 'Amount greater than 1000'],
        ['item.amount <= 5', 'Amount less than or equal 5'],
        ['item.received > "2026-01-01"', 'Received is after “2026-01-01”'],
        ['isEmpty(item.body)', 'Body is empty'],
        ['!isEmpty(item.body)', 'Body is not empty'],
        ['item.paid == true', 'Paid is true'],
        ['item.paid == false', 'Paid is false'],
        ['item.status == "Open"', 'Status is exactly (same upper/lower case) “Open”'],
        ['isAbout(item.body, "a complaint")', 'Body is about “a complaint”'],
    ])('%s → %s', (expr, sentence) => {
        expect(ruleSentence(expr)).toBe(sentence);
    });

    it('reads a quantified column with its quantifier first', () => {
        expect(ruleSentence('anyOf(item.attachments[*].mimeType, "contains", "pdf")'))
            .toBe('any attachment · Mime type contains “pdf”');
        expect(ruleSentence('everyOf(item.attachments[*].size, ">", 1000)'))
            .toBe('every attachment · Size greater than 1000');
        expect(ruleSentence('noneOf(item.attachments[*].filename, "endsWith", ".exe")'))
            .toBe('no attachment · Filename ends with “.exe”');
    });

    it('reads the legacy column `contains` as "any" and its negation as "no" (R5)', () => {
        expect(ruleSentence('contains(item.attachments[*].mimeType, "pdf")')).toBe('any attachment · Mime type contains “pdf”');
        expect(ruleSentence('!contains(item.attachments[*].mimeType, "pdf")')).toBe('no attachment · Mime type contains “pdf”');
    });

    it('names File type and its value, of the item and of a list inside it', () => {
        expect(ruleSentence('equals(fileType(item), "pdf")')).toBe('File type is PDF');
        expect(ruleSentence('!equals(fileType(item), "excel")')).toBe('File type is not Excel or CSV');
        expect(ruleSentence('anyOf(fileType(item.attachments[*]), "equals", "pdf")')).toBe('any attachment · File type is PDF');
        expect(ruleSentence('noneOf(fileType(item.attachments[*]), "equals", "image")')).toBe('no attachment · File type is Image');
    });

    it('reads an emptiness test on a list of records as "has at least one" / "has none"', () => {
        expect(ruleSentence('!isEmpty(item.attachments)')).toBe('Attachments has at least one');
        expect(ruleSentence('isEmpty(item.attachments)')).toBe('Attachments has none');
    });

    it('joins rows with and / or', () => {
        expect(ruleSentence('contains(item.from, "fabrikam") && anyOf(fileType(item.attachments[*]), "equals", "pdf")'))
            .toBe('From contains “fabrikam” and any attachment · File type is PDF');
        expect(ruleSentence('item.a > 1 || item.b > 2')).toBe('A greater than 1 or B greater than 2');
    });

    it('names a whole-run field by its step, never by its id', () => {
        const s = ruleSentence('steps.ai_1.output.urgency == "high"', LABELS);
        expect(s).toBe('Classify ▸ Urgency is exactly (same upper/lower case) “high”');
    });

    it('is null for a formula the rows cannot show, and empty for a rule not there yet', () => {
        expect(ruleSentence('len(steps.ai_1.output.tags) > 2', LABELS)).toBeNull();
        expect(ruleSentence('')).toBe('');
        expect(ruleSentence('true')).toBe('');
        expect(ruleSentence('false')).toBe('');
        expect(ruleSentence(null as unknown as string)).toBe('');
    });

    it('translates through t with the English as the fallback', () => {
        const seen: string[] = [];
        const t = (key: string, en: string, vars: Record<string, unknown> = {}) => {
            seen.push(key);
            return en.replace('{name}', String(vars.name ?? ''));
        };
        expect(ruleSentence('anyOf(fileType(item.attachments[*]), "equals", "pdf")', null, t)).toBe('any attachment · File type is PDF');
        expect(seen).toEqual(expect.arrayContaining([
            'condition_node.file_type.label', 'condition_node.file_type.pdf', 'condition_node.quantifier.any', 'condition_node.op.is',
        ]));
    });
});

describe('describeRuleExpr', () => {
    it('is the sentence, "Custom rule" for a formula, and never code', () => {
        expect(describeRuleExpr('equals(fileType(item), "word")')).toBe('File type is Word');
        expect(describeRuleExpr('len(item.tags) > 2 && upper(item.x) == "Y"')).toBe('Custom rule');
        for (const expr of ['anyOf(item.attachments[*].mimeType, "contains", "pdf")', 'steps.mc_read_many.output.count > 1']) {
            const text = describeRuleExpr(expr, LABELS);
            expect(text).not.toMatch(/[‹(]|item\.|steps\./);
        }
    });
});
