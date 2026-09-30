import { loopy } from '@/features/flow-editor/model/testing/fixtures';

import { issuesByStepFor } from './issues';

describe('issuesByStepFor', () => {
    it('gives a finding about a step inside a loop to that step, by its address', () => {
        const issue = { severity: 'error' as const, code: 'x', path: 'steps[loop_1].body.b_cond.expr', message: 'Broken' };
        const map = issuesByStepFor({ errors: [issue], warnings: [] }, loopy);
        expect(map.get('loop_1/b_cond')?.errors).toHaveLength(1);
        expect(map.get('loop_1')?.errors).toHaveLength(1);
        expect(map.get('loop_1/b_sw')).toBeUndefined();
    });
});
