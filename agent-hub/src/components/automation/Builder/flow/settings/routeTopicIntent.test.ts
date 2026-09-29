import { describe, it, expect } from 'vitest';
import { pickTopicField, readTopics } from './routeTopicIntent';
import { suggestOutputs } from './routeIntents';

/**
 * "Suggest outputs" for routing by meaning. Pinned like the rest of the
 * offline catalogue: exact topics, exact expressions, and the sentences it
 * must leave alone.
 */
describe('readTopics', () => {
    it('reads the topics out of a routing sentence, English and Dutch', () => {
        expect(readTopics('split complaints from invoices and questions')).toEqual(['complaints', 'invoices', 'questions']);
        expect(readTopics('Sort the incoming emails into complaints, invoices, job applications or something else.'))
            .toEqual(['complaints', 'invoices', 'job applications']);
        expect(readTopics('verdeel de berichten in klachten, facturen en vragen')).toEqual(['klachten', 'facturen', 'vragen']);
    });

    it('a single topic needs a routing word', () => {
        expect(readTopics('keep only complaints')).toEqual(['complaints']);
        expect(readTopics('about a refund')).toEqual(['a refund']);
        expect(readTopics('blah')).toEqual([]);
    });

    it('drops catch-alls, duplicates and phrases too long to be a topic', () => {
        expect(readTopics('sort complaints, other, complaints, the rest')).toEqual(['complaints']);
        expect(readTopics('sort invoices and a very long sentence that is clearly not a short topic at all')).toEqual(['invoices']);
    });
});

describe('pickTopicField', () => {
    const fields = [
        { path: 'item.id', label: 'Id', sample: 'm-1' },
        { path: 'item.subject', label: 'Subject', sample: 'Broken parcel' },
        { path: 'item.body', label: 'Body', sample: 'The parcel arrived broken and nobody answers the phone, I want my money back.' },
    ];

    it('prefers the body over the subject', () => {
        expect(pickTopicField(fields)?.path).toBe('item.body');
        expect(pickTopicField(fields.slice(0, 2))?.path).toBe('item.subject');
    });

    it('says nothing when nothing looks like text', () => {
        expect(pickTopicField([{ path: 'item.amount', sample: 12 }])).toBeNull();
    });
});

describe('suggestOutputs with topics', () => {
    const fields = [
        { path: 'item.subject', label: 'Subject', sample: 'Question about my order' },
        { path: 'item.body', label: 'Body', sample: 'Hello, I would like to know when my order ships, thanks a lot in advance.' },
    ];

    it('suggests one isAbout output per topic when a classifier is installed', () => {
        const s = suggestOutputs('split complaints from invoices', { fields, topics: true });
        expect(s.kind).toBe('topic');
        expect(s).toMatchObject({ field: { path: 'item.body' } });
        expect(s.rules).toEqual([
            { name: 'complaints', expr: 'isAbout(item.body, "complaints")' },
            { name: 'invoices', expr: 'isAbout(item.body, "invoices")' },
        ]);
    });

    it('uses the field the author named', () => {
        const s = suggestOutputs('split the subject into complaints and invoices', { fields, topics: true });
        expect(s.rules[0].expr).toBe('isAbout(item.subject, "complaints")');
    });

    it('without a classifier the sentence is not answered offline, as before', () => {
        const s = suggestOutputs('split complaints from invoices', { fields });
        expect(s.rules).toEqual([]);
        expect(s.problem).toBeTruthy();
    });

    it('exact rules still win: a file type is a file type', () => {
        const s = suggestOutputs('split pdf and word', { fields: [{ path: 'item.name', label: 'Name', sample: 'a.pdf' }], topics: true });
        expect(s.kind).toBe('fileType');
    });
});
