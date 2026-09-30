/**
 * What counts as something to lose on a page being filled in: an answer to a
 * question that collects one, by the server's own blank rule.
 */

import { initialValues } from './contract';
import { hasAnswers } from './fillDraft';
import type { Answers, FillField } from './fillTypes';

const field = (name: string, type: string, extra: Partial<FillField> = {}): FillField => ({
    name,
    type,
    label: name,
    required: false,
    placeholder: '',
    help: '',
    options: [],
    accept: '',
    maxSizeMb: 10,
    source: '',
    app: '',
    sourceLabel: '',
    searchHint: '',
    multiple: false,
    maxItems: 1,
    fileId: '',
    filename: '',
    mimeType: '',
    size: null,
    ...extra,
});

const FIELDS = [
    field('name', 'text'),
    field('agree', 'checkbox'),
    field('records', 'app_pick', { multiple: true, maxItems: 3 }),
    field('report', 'download', { fileId: 'f1', filename: 'report.pdf' }),
];

describe('hasAnswers', () => {
    it('is false for a page as it opened', () => {
        expect(hasAnswers(FIELDS, initialValues(FIELDS))).toBe(false);
    });

    it('does not count spaces, an unticked box or an empty pick', () => {
        expect(hasAnswers(FIELDS, { ...initialValues(FIELDS), name: '   ', agree: false, records: [] })).toBe(false);
    });

    it.each<[string, Answers]>([
        ['a typed text', { name: 'Anna' }],
        ['a ticked box', { agree: true }],
        ['a picked record', { records: [{ kind: 'app_pick', source: 'crm', recordId: 'r1', title: 'Acme' }] }],
    ])('counts %s', (_what, answer) => {
        expect(hasAnswers(FIELDS, { ...initialValues(FIELDS), ...answer })).toBe(true);
    });

    it('never counts a display field', () => {
        expect(hasAnswers([field('report', 'download')], { report: 'anything' })).toBe(false);
    });
});
