import { describe, expect, it } from 'vitest';
import { usedByDownstream } from './usedBy';

/**
 * "Used by" names the field a step reads by the key its path ENDS in, read
 * as the runtime reads the path: `verdict["reason code"]` is "Reason code",
 * not "Verdict"; a name/value entry is its name.
 */
const definition = {
    trigger: { id: 't1', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'http', type: 'http_request', label: 'Ask the ERP' },
        {
            id: 'reply', type: 'ai_step', label: 'Reply',
            prompt: 'Why: {{steps.http.output.body.data.payload.items[0].meta.ai.verdict["reason code"]}} — {{steps.http.output.headers[name="Subject"].value}}',
        },
    ],
    edges: [{ from: 't1', to: 'http' }, { from: 'http', to: 'reply' }],
};

describe('Used by, over quoted keys and entries', () => {
    it('labels a field by the key it ends in', () => {
        const [entry] = usedByDownstream(definition, 'http');
        expect(entry.fields).toEqual(['Reason code', 'Subject']);
        expect(entry.leaves).toEqual(['reason code', 'Subject']);
    });
});
