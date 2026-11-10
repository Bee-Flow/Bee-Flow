// @vitest-environment node
import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';
import { validateRowFilterExpr, VIEWER_LISTS } from './rowFilterSubset';
import { buildRowRule, conditionProblem, describeRowRule, parseRowRule, retypeCondition, serializeCondition, sourcesForCondition, withSource } from './rowRuleModel';
import { COMPARE_SOURCES } from './rowRuleModel.constants';
import { activeSlots, draftToRule, seedRuleSet, storedRule, withPerAction } from './rowRuleSet';
import { describeActionRules } from './rowRuleSetWords';
import type { TranslateFn } from '@/hooks/useTranslation';

// The server side the editor has to agree with: the gateway and its vocabulary.
const require = createRequire(import.meta.url);
const gateway = require('../../../../../../../server/appStudio/rlsGateway.js');
const vocabulary = require('../../../../../../../server/core/dataEngine/dataModel/vocabulary.js');

interface ViewerAttribute { key: string; list?: boolean }
const ATTRIBUTES: ViewerAttribute[] = vocabulary.VIEWER_ATTRIBUTES;

const table = {
    id: 't1',
    key: 'tasks',
    name: 'Tasks',
    fields: [
        { key: 'team', name: 'Team', type: 'text' },
        { key: 'status', name: 'Status', type: 'select', options: ['open', 'closed'] },
        { key: 'amount', name: 'Amount', type: 'number' },
        { key: 'tags', name: 'Tags', type: 'multiselect', options: ['a'] },
    ],
};
const t: TranslateFn = ((key: string, en?: unknown, params?: Record<string, unknown>) => String(en ?? key)
    .replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m))) as TranslateFn;
const cond = (patch: Record<string, unknown>) => ({ id: 'c', field: 'team', op: '==', source: 'value', value: '', valueType: 'string', ...patch });

describe('the viewer attributes the picker knows are the server\'s', () => {
    it('offers every attribute the server knows, and only those', () => {
        const offered = COMPARE_SOURCES.filter((s) => s.id !== 'value').map((s) => s.id.replace('viewer.', '')).sort();
        expect(offered).toEqual(ATTRIBUTES.map((spec) => spec.key).sort());
    });

    it('has the same lists as the server', () => {
        const lists = ATTRIBUTES.filter((spec) => spec.list).map((spec) => spec.key);
        expect([...VIEWER_LISTS]).toEqual(lists);
        expect(COMPARE_SOURCES.filter((s) => s.list).map((s) => s.id)).toEqual(lists.map((k) => `viewer.${k}`));
    });

    it('offers viewer.orgId for a new condition and keeps viewer.organizationId only where it is used', () => {
        expect(sourcesForCondition(cond({})).map((s) => s.id)).not.toContain('viewer.organizationId');
        expect(sourcesForCondition(cond({})).map((s) => s.id)).toContain('viewer.orgId');
        expect(sourcesForCondition(cond({ source: 'viewer.organizationId' })).map((s) => s.id)).toContain('viewer.organizationId');
    });
});

describe('a condition on the person\'s groups', () => {
    it('is written as membership and read back into the same condition', () => {
        const picked = withSource(cond({}), 'viewer.groups');
        expect(picked).toMatchObject({ op: 'in', source: 'viewer.groups' });
        expect(serializeCondition(picked)).toBe('record.team in viewer.groups');

        const expr = 'record.team in viewer.groups && record.status == "open"';
        const parsed = parseRowRule(expr, table);
        expect(parsed.ok).toBe(true);
        expect(parsed.conditions[0]).toMatchObject({ field: 'team', op: 'in', source: 'viewer.groups' });
        expect(buildRowRule(parsed)).toBe(expr);
        expect(describeRowRule(parsed, table)).toBe('Team is one of their groups and Status is “open”');
    });

    it('never writes a list as one value, or membership against one value', () => {
        expect(serializeCondition(cond({ op: '==', source: 'viewer.groups' }))).toBeNull();
        expect(serializeCondition(cond({ op: 'in', source: 'viewer.id' }))).toBeNull();
        expect(withSource(withSource(cond({}), 'viewer.groups'), 'viewer.email')).toMatchObject({ op: '==', source: 'viewer.email' });
    });

    it('keeps membership when the column changes, and names a column that does not fit', () => {
        const picked = withSource(cond({}), 'viewer.groups');
        const moved = retypeCondition(picked, { key: 'status', name: 'Status', type: 'select' });
        expect(moved).toMatchObject({ field: 'status', op: 'in', source: 'viewer.groups' });
        expect(conditionProblem(moved, table)).toBeNull();
        for (const field of ['amount', 'tags', 'created_at']) {
            expect(conditionProblem({ ...picked, field }, table)).toBe('Only a text or choice column can be compared with their groups.');
        }
        expect(conditionProblem({ ...picked, field: 'created_by' }, table)).toBeNull();
    });

    it('agrees with the server on what a rule may say', () => {
        const rules = [
            'record.team in viewer.groups',
            'record.status in viewer.groups || record.team == viewer.email',
            '!(record.created_by in viewer.groups)',
            'record.org_id == viewer.orgId',
            'record.amount in viewer.groups',
            'record.tags in viewer.groups',
            'record.created_at in viewer.groups',
            'record.team in viewer.email',
            'record.team in viewer.teams',
            'record.team in record.status',
            '"x" in viewer.groups',
            'record.team == viewer.groups',
            'record.nope in viewer.groups',
        ];
        for (const rule of rules) {
            expect(validateRowFilterExpr(rule, table).ok, rule).toBe(gateway.validateRowFilter(rule, table).ok);
        }
    });
});

describe('one rule, or a rule per action', () => {
    it('reads one stored rule as one draft and writes it back as text', () => {
        const set = seedRuleSet('record.team in viewer.groups', table);
        expect(set.perAction).toBe(false);
        expect(activeSlots(set)).toEqual(['all']);
        expect(storedRule(set)).toBe('record.team in viewer.groups');
        expect(storedRule(seedRuleSet(null, table))).toBeNull();
        expect(storedRule(seedRuleSet('   ', table))).toBeNull();
    });

    it('reads a rule per action into three drafts and writes back only the ones that hold a rule', () => {
        const stored = { read: 'record.status == "open"', update: 'record.team in viewer.groups' };
        const set = seedRuleSet(stored, table);
        expect(set.perAction).toBe(true);
        expect(activeSlots(set)).toEqual(['read', 'update', 'delete']);
        expect(draftToRule(set.delete)).toBe('');
        expect(storedRule(set)).toEqual(stored);
        expect(gateway.validateRowFilter(storedRule(set), table)).toEqual({ ok: true, errors: [] });
        // Every action emptied: there is no rule left to store.
        expect(storedRule(seedRuleSet({ read: '', update: ' ' }, table))).toBeNull();
    });

    it('leaves a stored value it cannot show exactly as it is', () => {
        for (const stored of [{ kind: 'binop', op: '==', a: {}, b: {} }, { read: 'record.team == "a"', create: 'x' }, { read: { kind: 'bool', v: true } }, ['x'], 7]) {
            const set = seedRuleSet(stored, table);
            expect(set.kept).toBe(true);
            expect(storedRule(set)).toBeUndefined();
        }
    });

    it('splitting one rule gives each action that same rule: nothing changes until one is edited', () => {
        const one = seedRuleSet('record.team in viewer.groups', table);
        const each = withPerAction(one, true, table);
        expect(storedRule(each)).toEqual({
            read: 'record.team in viewer.groups', update: 'record.team in viewer.groups', delete: 'record.team in viewer.groups',
        });
        expect(withPerAction(each, true, table)).toBe(each);
    });

    it('going back to one rule keeps the rule of the action on screen', () => {
        const each = seedRuleSet({ read: 'record.status == "open"', update: 'record.team in viewer.groups' }, table);
        expect(storedRule(withPerAction(each, false, table, 'update'))).toBe('record.team in viewer.groups');
        expect(storedRule(withPerAction(each, false, table))).toBe('record.status == "open"');
        expect(storedRule(withPerAction(each, false, table, 'delete'))).toBeNull();
    });

    it('says what the rules for changing and deleting come to', () => {
        const all = { read: 'all', create: true, update: 'all', delete: 'all' };
        const each = seedRuleSet({ read: 'record.status == "open"', update: 'record.team in viewer.groups' }, table);
        expect(describeActionRules(each, all, table, t)).toEqual([
            'They can change only the rows where Team is one of their groups.',
            'No row rule narrows which rows they can delete.',
        ]);
        const typed = seedRuleSet({ delete: '!(record.team in viewer.groups)' }, table);
        expect(describeActionRules(typed, all, table, t)).toEqual([
            'No row rule narrows which rows they can change.',
            'They can delete only the rows matching the rule written for deleting.',
        ]);
        // An action the role may not do gets no sentence; neither does one rule for all three.
        expect(describeActionRules(each, { ...all, update: 'none', delete: 'none' }, table, t)).toEqual([]);
        expect(describeActionRules(seedRuleSet('record.status == "open"', table), all, table, t)).toEqual([]);
    });
});
