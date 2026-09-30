import {
    addGroup,
    addRule,
    childrenOf,
    isGroup,
    joinOf,
    newCondition,
    removeChild,
    setChild,
    setJoin,
} from './conditionOps';
import type { Rule } from './types';

const a: Rule = { parameter: 'a', operator: 'is_set' };
const b: Rule = { parameter: 'b', operator: 'equals', value: 1 };

describe('conditionOps', () => {
    it('tells a group from a rule and reads its join and children', () => {
        expect(isGroup(a)).toBe(false);
        expect(isGroup({ any: [a] })).toBe(true);
        expect(joinOf({ any: [a] })).toBe('any');
        expect(childrenOf({ all: [a, b] })).toEqual([a, b]);
    });

    it('starts a condition as one group with one rule', () => {
        expect(newCondition(a)).toEqual({ all: [a] });
    });

    it('switches all/any without touching the children', () => {
        expect(setJoin({ all: [a, b] }, 'any')).toEqual({ any: [a, b] });
    });

    it('replaces, drops and removes children the way the web does', () => {
        expect(setChild({ all: [a, b] }, 1, a)).toEqual({ all: [a, a] });
        expect(setChild({ any: [a, b] }, 0, null)).toEqual({ any: [b] });
        expect(setChild({ all: [a] }, 0, null)).toBeNull();
        expect(removeChild({ all: [a, b] }, 0)).toEqual({ all: [b] });
        expect(removeChild({ all: [a] }, 0)).toBeNull();
    });

    it('adds a rule or a nested group at the end, keeping the join', () => {
        expect(addRule({ any: [a] }, b)).toEqual({ any: [a, b] });
        expect(addGroup({ any: [a] }, b)).toEqual({ any: [a, { all: [b] }] });
    });

    it('edits a child group in place, however deep', () => {
        const nested = { all: [a, { any: [a, b] }] };
        const inner = childrenOf(nested)[1];
        if (!inner || !isGroup(inner)) throw new Error('expected a group');
        expect(setChild(nested, 1, setJoin(inner, 'all'))).toEqual({ all: [a, { all: [a, b] }] });
        expect(setChild(nested, 1, removeChild(removeChild(inner, 0) ?? inner, 0))).toEqual({ all: [a] });
    });
});
