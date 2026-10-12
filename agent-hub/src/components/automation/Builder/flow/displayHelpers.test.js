import { describe, it, expect } from 'vitest';
import { buildStepLabelMap, buildRunStepLabelMap, runStepLabel, resolveOwningStepId, humanizeIssueText, humanizeFieldKey, describeRuleExpr } from './displayHelpers';

const def = {
    trigger: { id: 'trg', label: 'Manual trigger' },
    steps: [
        { id: 'cond_7f748746', type: 'condition', label: 'If' },
        { id: 'a_af2f5b', type: 'integration_action', label: 'Search Gmail' },
        { id: 'noLabel1', type: 'wait' },
    ],
};

describe('buildStepLabelMap', () => {
    it('maps every trigger + step id to its label, falling back to id when unlabeled', () => {
        const m = buildStepLabelMap(def);
        expect(m.get('trg')).toBe('Manual trigger');
        expect(m.get('cond_7f748746')).toBe('If');
        expect(m.get('noLabel1')).toBe('noLabel1');
    });

    it('returns an empty map for a missing definition', () => {
        expect(buildStepLabelMap(null).size).toBe(0);
    });
});

describe('resolveOwningStepId', () => {
    it('finds the step id embedded in a validation record path', () => {
        expect(resolveOwningStepId({ path: 'steps[cond_7f748746].expr' }, def)).toBe('cond_7f748746');
    });

    it('prefers the LONGEST matching id so a short id cannot shadow a longer one', () => {
        const longDef = { trigger: null, steps: [{ id: 'a' }, { id: 'a_af2f5b' }] };
        expect(resolveOwningStepId({ path: 'steps[a_af2f5b].inputs.to' }, longDef)).toBe('a_af2f5b');
    });

    it('returns null when the path references no known step (or is missing)', () => {
        expect(resolveOwningStepId({ path: 'steps[gone].expr' }, def)).toBeNull();
        expect(resolveOwningStepId({}, def)).toBeNull();
        expect(resolveOwningStepId({ path: 'steps[cond_7f748746].expr' }, null)).toBeNull();
    });
});

describe('humanizeIssueText', () => {
    const labelById = buildStepLabelMap(def);

    it('replaces a known raw step id embedded in free text with its quoted label', () => {
        expect(humanizeIssueText('Step cond_7f748746: unknown type "foo".', labelById))
            .toBe('Step "If": unknown type "foo".');
        expect(humanizeIssueText('runPartial: step cond_7f748746 not found in definition', labelById))
            .toBe('runPartial: step "If" not found in definition');
    });

    it('does not partially match a longer id sharing a short id as a prefix', () => {
        // 'a_af2f5b' must not be matched by a hypothetical shorter id 'a' first.
        expect(humanizeIssueText('refers to a_af2f5b', labelById)).toBe('refers to "Search Gmail"');
    });

    it('leaves unknown ids (e.g. a stale reference to a deleted step) untouched', () => {
        expect(humanizeIssueText('refers to non-existent step "gone_123"', labelById))
            .toBe('refers to non-existent step "gone_123"');
    });

    it('is a no-op for empty text or an empty label map', () => {
        expect(humanizeIssueText('', labelById)).toBe('');
        expect(humanizeIssueText('Step cond_7f748746', new Map())).toBe('Step cond_7f748746');
        expect(humanizeIssueText(null, labelById)).toBe(null);
    });
});

describe('humanizeFieldKey', () => {
    it('renders a data field as a plain English label', () => {
        expect(humanizeFieldKey('subject')).toBe('Subject');
        expect(humanizeFieldKey('from_email')).toBe('From email');
        expect(humanizeFieldKey('messageId')).toBe('Message id');
        expect(humanizeFieldKey('')).toBe('');
    });

    it('keeps curated proper nouns', () => {
        expect(humanizeFieldKey('pdf')).toBe('PDF');
        expect(humanizeFieldKey('gmail_id')).toBe('Gmail id');
    });
});

describe('describeRuleExpr', () => {
    it('reads a rule as a sentence — never a raw path', () => {
        expect(describeRuleExpr('contains(item.subject, "isv")')).toBe('Subject contains “isv”');
        expect(describeRuleExpr('item.amount > 1000')).toBe('Amount greater than 1000');
        expect(describeRuleExpr('isEmpty(item.body)')).toBe('Body is empty');
    });

    it('joins multiple conditions with and / or', () => {
        // A saved text `==` keeps its case-sensitive meaning, and says so (R7).
        expect(describeRuleExpr('item.a > 1 && item.b == "x"')).toBe('A greater than 1 and B is exactly (same upper/lower case) “x”');
        expect(describeRuleExpr('item.a > 1 || item.b > 2')).toBe('A greater than 1 or B greater than 2');
    });

    it('says "and" / "or" in the reader\'s language', () => {
        const nl = { 'condition_node.join.and': 'en', 'condition_node.join.or': 'of' };
        const t = (key, en, vars = {}) => (nl[key] ?? en).replace(/\{(\w+)\}/g, (_, v) => String(vars[v] ?? ''));
        expect(describeRuleExpr('item.a > 1 && item.b > 2', null, t)).toBe('A greater than 1 en B greater than 2');
        expect(describeRuleExpr('item.a > 1 || item.b > 2', null, t)).toBe('A greater than 1 of B greater than 2');
    });

    it('names a formula it cannot show as rows "Custom rule", never its code', () => {
        const labels = new Map([['ai_1', 'Classify']]);
        expect(describeRuleExpr('len(steps.ai_1.output.tags) > 2', labels)).toBe('Custom rule');
        expect(describeRuleExpr('')).toBe('');
    });
});

describe('describeRuleExpr: is about', () => {
    it('reads an "is about" rule in words, sensitivity left out', () => {
        expect(describeRuleExpr('isAbout(item.body, "a complaint")')).toBe('Body is about “a complaint”');
        expect(describeRuleExpr('!isAbout(item.subject, "spam", 0.7)')).toBe('Subject is not about “spam”');
    });
});

describe('buildRunStepLabelMap (BFSF-457)', () => {
    const layered = {
        trigger: { id: 'trg', label: 'Start' },
        steps: [
            { id: 'cl_a', type: 'call_layer', layerKey: 'outer', label: 'Research' },
            { id: 's2', type: 'notification', label: 'Tell me' },
        ],
        layers: {
            outer: {
                trigger: { id: 'in1', label: 'Research input' },
                steps: [
                    { id: 'ai_1', type: 'ai', label: '1. Find keywords' },
                    { id: 'cl_b', type: 'call_layer', layerKey: 'inner', label: '2. Deeper' },
                ],
            },
            inner: { trigger: { id: 'in2' }, steps: [{ id: 'http_1', type: 'http_request', label: 'Ask the API' }] },
        },
    };

    it('keeps the top-level labels', () => {
        const m = buildRunStepLabelMap(layered);
        expect(m.get('trg')).toBe('Start');
        expect(m.get('cl_a')).toBe('Research');
        expect(m.get('s2')).toBe('Tell me');
    });

    it('labels a flowlet step under its recorded path', () => {
        const m = buildRunStepLabelMap(layered);
        expect(m.get('cl_a/in1')).toBe('Research input');
        expect(m.get('cl_a/ai_1')).toBe('1. Find keywords');
    });

    it('follows a flowlet inside a flowlet, one path segment per call', () => {
        const m = buildRunStepLabelMap(layered);
        expect(m.get('cl_a/cl_b/http_1')).toBe('Ask the API');
        expect(m.get('cl_a/cl_b/in2')).toBe('in2');
    });

    it('stops at a layer that calls itself', () => {
        const selfCalling = {
            steps: [{ id: 'c1', type: 'call_layer', layerKey: 'L' }],
            layers: { L: { trigger: { id: 't' }, steps: [{ id: 'c2', type: 'call_layer', layerKey: 'L', label: 'Again' }] } },
        };
        const m = buildRunStepLabelMap(selfCalling);
        expect(m.get('c1/c2')).toBe('Again');
        expect([...m.keys()].some(k => k.startsWith('c1/c2/'))).toBe(false);
    });

    it('skips a call whose layer is missing, and leaves buildStepLabelMap top-level only', () => {
        const m = buildRunStepLabelMap({ steps: [{ id: 'c1', type: 'call_layer', layerKey: 'gone' }] });
        expect([...m.keys()]).toEqual(['c1']);
        expect(buildStepLabelMap(layered).has('cl_a/ai_1')).toBe(false);
        expect(buildRunStepLabelMap(null).size).toBe(0);
    });
});

describe('runStepLabel', () => {
    const m = buildRunStepLabelMap({
        steps: [{ id: 'cb_1', type: 'call_block', blockId: 'b1', label: 'Shared step' }],
    });

    it('uses the known label', () => {
        expect(runStepLabel(m, 'cb_1')).toBe('Shared step');
    });

    it('reads an unknown nested id as "<call step label> › <inner id>"', () => {
        expect(runStepLabel(m, 'cb_1/ai_9')).toBe('Shared step › ai_9');
        expect(runStepLabel(m, 'cb_1/x/y')).toBe('Shared step › x › y');
    });

    it('returns an unknown top-level id as is', () => {
        expect(runStepLabel(m, 'nope')).toBe('nope');
        expect(runStepLabel(m, null)).toBe(null);
    });
});
