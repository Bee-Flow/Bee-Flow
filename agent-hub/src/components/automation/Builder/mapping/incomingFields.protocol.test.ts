import { describe, expect, it } from 'vitest';
import { isSystemField, planIncomingFields } from './incomingFields';

describe('Technical details hold protocol noise only', () => {
    it('folds API annotations (@odata.*), keeps a content type in view', () => {
        for (const k of ['@odata.type', '@odata.etag', '@odata.mediaContentType', '@odata.context', '__typename', '$schema']) expect(isSystemField(k)).toBe(true);
        for (const k of ['content-type', 'contentType', 'mimeType', 'name', 'size']) expect(isSystemField(k)).toBe(false);
    });

    it('an attachment\'s fields: its content type is a field, its OData annotations are technical', () => {
        const f = (key: string) => ({ key, path: `loop.attachment[${JSON.stringify(key)}]` });
        const plan = planIncomingFields([f('name'), f('content-type'), f('size'), f('@odata.type'), f('@odata.mediaContentType')], () => false, true);
        expect(plan.shown.map(x => x.key)).toEqual(['name', 'content-type', 'size']);
        expect(plan.technical.map(x => x.key)).toEqual(['@odata.type', '@odata.mediaContentType']);
    });
});
