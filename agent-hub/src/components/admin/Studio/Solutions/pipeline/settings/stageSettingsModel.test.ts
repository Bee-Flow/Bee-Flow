import { describe, expect, it } from 'vitest';
import {
    applyNeedsApproval, bindingProblem, bindingStatus, canEditValue, confirmMatches, draftProblems, effectiveValue, gateOutcome,
    groupOf, groupRequirements, isSteering, neededByNames, parseHosts, policyProblems, readRequirements, readSettings, removeBody,
    settingsError, valueFromInput, valuePending, variableNameProblem,
    type Requirement,
} from './stageSettingsModel';

const req = (slot: string, kind: string, over: Partial<Requirement> = {}): Requirement => ({ slot, kind, label: slot, neededBy: [], bound: false, ...over });

describe('slot grouping', () => {
    it('groups by kind, tells seats from notify, and leaves empty groups out', () => {
        const list = [
            req('connection:cn_1', 'connection'), req('seats:aut_1:s1', 'approver_seats'), req('notify:aut_1', 'approver_seats'),
            req('table:orders', 'table'), req('kb:aut_1:knowledgeBaseIds:s2', 'knowledge_base'), req('slug:page_1', 'webpage_slug'),
        ];
        expect(groupOf(list[1])).toBe('approvers');
        expect(groupOf(list[2])).toBe('notify');
        expect(groupRequirements(list).map(g => [g.group, g.items.length])).toEqual([
            ['connections', 1], ['approvers', 1], ['notify', 1], ['data', 2], ['exposure', 1],
        ]);
        expect(groupRequirements([req('connection:cn_1', 'connection')]).map(g => g.group)).toEqual(['connections']);
    });

    it('names the parts a slot is needed by, falling back to the ref', () => {
        const parts = [{ ref: 'aut_1', kind: 'automation', name: 'Check VAT', entityId: 'e', active: true, retired: false, drift: false }];
        expect(neededByNames(req('x', 'table', { neededBy: ['aut_1', 'aut_9'] }), parts)).toEqual(['Check VAT', 'aut_9']);
    });

    it('reads requirements tolerantly, keeping owner-only fields only when sent', () => {
        const out = readRequirements({ release: { id: 'r1', seq: 3 }, requirements: [{ slot: 'a', kind: 'table', bound: true }, { nope: 1 }] });
        expect(out?.release).toEqual({ id: 'r1', seq: 3 });
        expect(out?.requirements).toHaveLength(1);
        expect('binding' in (out?.requirements[0] as object)).toBe(false);
        expect(readRequirements('nonsense')).toBeNull();
    });
});

describe('binding status: unknown is not empty', () => {
    it('a binding the caller cannot read is "bound", never "missing"', () => {
        const r = req('table:t', 'table', { bound: true });
        expect(bindingStatus(r, {})).toBe('bound');
        expect(effectiveValue(r, {})).toBeNull();
    });
    it('missing, edited and cleared come from the draft', () => {
        const r = req('table:t', 'table');
        expect(bindingStatus(r, {})).toBe('missing');
        expect(bindingStatus(r, { 'table:t': { datatableId: 'x' } })).toBe('changed');
        expect(bindingStatus(req('table:t', 'table', { bound: true }), { 'table:t': null })).toBe('cleared');
    });
});

describe('binding problems', () => {
    it('a Production connection needs hosts, UAT does not', () => {
        const c = req('connection:cn_1', 'connection');
        expect(bindingProblem(c, { connectionId: 'c1', allowedHosts: [] }, 'prd')).toBe('hosts_required');
        expect(bindingProblem(c, { connectionId: 'c1', allowedHosts: [] }, 'uat')).toBeNull();
        expect(bindingProblem(c, { connectionId: 'c1', allowedHosts: ['api.example.com'] }, 'prd')).toBeNull();
        expect(bindingProblem(c, { connectionId: '', allowedHosts: ['a.com'] }, 'prd')).toBe('connection_missing');
        expect(bindingProblem(c, { connectionId: 'c1', allowedHosts: ['not a host!'] }, 'uat')).toBe('hosts_invalid');
    });
    it('seats and notify need somebody, a slug needs the right letters', () => {
        expect(bindingProblem(req('seats:a:s', 'approver_seats'), {}, 'uat')).toBe('no_seat');
        expect(bindingProblem(req('seats:a:s', 'approver_seats'), { assignee: { userId: 'u2' } }, 'uat')).toBeNull();
        expect(bindingProblem(req('seats:a:s', 'approver_seats'), { stages: [{ key: 's1', approvers: [{ groupId: 'g1' }] }] }, 'uat')).toBeNull();
        expect(bindingProblem(req('notify:a', 'approver_seats'), { onError: { recipients: [] } }, 'uat')).toBe('no_recipient');
        expect(bindingProblem(req('notify:a', 'approver_seats'), { onError: { recipients: [{ type: 'user', id: 'u2' }] } }, 'uat')).toBeNull();
        expect(bindingProblem(req('slug:p', 'webpage_slug'), { slug: 'Bad Slug' }, 'uat')).toBe('slug_invalid');
        expect(bindingProblem(req('slug:p', 'webpage_slug'), { slug: 'my-page' }, 'uat')).toBeNull();
    });
    it('only edited slots are judged, clearing is always fine', () => {
        const list = [req('table:a', 'table'), req('table:b', 'table')];
        expect(draftProblems(list, { 'table:a': { datatableId: '' } }, 'uat')).toEqual([{ slot: 'table:a', problem: 'id_missing' }]);
        expect(draftProblems(list, { 'table:a': null }, 'uat')).toEqual([]);
    });
    it('parses hosts the way the server normalises them', () => {
        expect(parseHosts('API.Example.com, https://x.org/a:8080 ; api.example.com')).toEqual(['api.example.com', 'x.org']);
        expect(parseHosts('')).toEqual([]);
        expect(parseHosts('has space/ok, @@')).toBeNull();
    });
});

describe('the approval gate', () => {
    it('flags a policy with a stage nobody else sits in', () => {
        const owner = 'u_owner';
        expect(policyProblems({ stages: [{ key: 's1', approvers: [{ userId: owner }] }] }, owner)).toEqual([{ stageKey: 's1', why: 'owner_only' }]);
        expect(policyProblems({ stages: [{ key: 's1', approvers: [{ userId: 'u2' }] }, { key: 's2', approvers: [{ userId: owner }, { userId: 'u3' }] }] }, owner)).toEqual([]);
        expect(policyProblems({ stages: [{ key: 's1', approvers: [{ groupId: 'g1' }] }] }, owner)).toEqual([]);
        expect(policyProblems({ stages: [{ key: 's1', approvers: [null] }] }, owner)).toEqual([{ stageKey: 's1', why: 'empty' }]);
        expect(policyProblems(null, owner)).toEqual([{ stageKey: '', why: 'empty' }]);
    });
    it('a 202 is "approval requested", a 200 is saved', () => {
        expect(gateOutcome(202)).toBe('approval_requested');
        expect(gateOutcome(200)).toBe('saved');
    });
    it('redeploys of Production with the gate on need approval; UAT never does', () => {
        expect(applyNeedsApproval('prd', { requiresApproval: true })).toBe(true);
        expect(applyNeedsApproval('prd', { requiresApproval: false })).toBe(false);
        expect(applyNeedsApproval('uat', { requiresApproval: true })).toBe(false);
    });
});

describe('variables', () => {
    it('refuses secret-like names inline, with the reason', () => {
        expect(variableNameProblem('api_key')).toBe('secret');
        expect(variableNameProblem('Client_Secret')).toBe('secret');
        expect(variableNameProblem('authorization_header')).toBe('secret');
        expect(variableNameProblem('')).toBe('empty');
        expect(variableNameProblem('Tax Rate')).toBe('invalid');
        expect(variableNameProblem('tax_rate', ['tax_rate'])).toBe('duplicate');
        expect(variableNameProblem('tax_rate', ['other'])).toBeNull();
    });
    it('a steering value is editable only by the Solution owner; the rest by operators', () => {
        const steering = { type: 'url' as const, steering: false };
        const author = { type: 'text' as const, steering: true };
        const plain = { type: 'text' as const, steering: false };
        expect(isSteering(steering)).toBe(true);
        expect(canEditValue(steering, 'owner')).toBe(true);
        expect(canEditValue(steering, 'editor')).toBe(false);
        expect(canEditValue(author, 'editor')).toBe(false);
        expect(canEditValue(plain, 'editor')).toBe(true);
        expect(canEditValue(plain, 'viewer')).toBe(false);
        expect(canEditValue(plain, 'org_admin')).toBe(false);
    });
    it('a steering value that is not applied yet is pending', () => {
        const d = { type: 'email' as const, steering: false };
        expect(valuePending(d, { name: 'n', value: 'a@b.nl', appliedValue: null })).toBe(true);
        expect(valuePending(d, { name: 'n', value: 'a@b.nl', appliedValue: 'a@b.nl' })).toBe(false);
        expect(valuePending({ type: 'text', steering: false }, { name: 'n', value: 'x', appliedValue: null })).toBe(false);
        expect(valuePending(d, undefined)).toBe(false);
    });
    it('turns input into a typed value; empty clears', () => {
        expect(valueFromInput({ type: 'number' }, '12.5')).toBe(12.5);
        expect(valueFromInput({ type: 'boolean' }, 'true')).toBe(true);
        expect(valueFromInput({ type: 'text' }, '  ')).toBeNull();
        expect(valueFromInput({ type: 'text' }, ' hi ')).toBe('hi');
    });
});

describe('write errors', () => {
    const fail = (status: number, code: string | null, body: Record<string, unknown> | null = null) => ({ status, code, body });
    it('maps the CAS conflict', () => {
        expect(settingsError(fail(409, 'settings_stale', { details: { settingsVersion: 7 } }))).toEqual({ kind: 'stale', settingsVersion: 7 });
        expect(settingsError(fail(409, 'settings_stale'))).toEqual({ kind: 'stale', settingsVersion: null });
    });
    it('maps the other refusals the page words differently', () => {
        expect(settingsError(fail(400, 'binding_invalid', { details: { slot: 'connection:cn_1', why: 'hosts_required' } }))).toEqual({ kind: 'binding_invalid', slot: 'connection:cn_1', why: 'hosts_required' });
        expect(settingsError(fail(409, 'managed_part_not_deployed'))).toEqual({ kind: 'not_deployed' });
        expect(settingsError(fail(403, 'steering_owner_only', { details: { name: 'mail_to' } }))).toEqual({ kind: 'steering_owner_only', name: 'mail_to' });
        expect(settingsError(fail(400, 'approval_policy_needs_approver', { details: { stageKey: 's1' } }))).toEqual({ kind: 'policy_needs_approver', stageKey: 's1' });
        expect(settingsError(fail(400, 'variable_invalid', { details: { name: 'rate' } }))).toEqual({ kind: 'variable', code: 'variable_invalid', name: 'rate' });
        expect(settingsError(fail(403, null, { error: 'feature_locked' }))).toEqual({ kind: 'licence' });
        expect(settingsError(fail(403, 'insufficient_permissions'))).toEqual({ kind: 'forbidden' });
        expect(settingsError(fail(0, 'network'))).toEqual({ kind: 'network' });
        expect(settingsError(fail(500, null))).toEqual({ kind: 'other', code: null });
    });
});

describe('settings read and danger zone', () => {
    it('a body without a settings version is not a settings read', () => {
        expect(readSettings({ enabled: true })).toBeNull();
        const s = readSettings({ stage: 'prd', settingsVersion: 4, enabled: false, parts: [{ ref: 'a', kind: 'automation', active: true }, { nope: 1 }], approvalPolicy: { stages: [{ key: 's1' }] } });
        expect(s?.settingsVersion).toBe(4);
        expect(s?.parts).toHaveLength(1);
        expect(s?.approvalPolicy?.stages).toHaveLength(1);
        expect(s?.runAs).toEqual({ userId: null, name: null });
    });
    it('the typed name must match, and delete carries deleteData only as asked', () => {
        expect(confirmMatches(' Onboarding ', 'Onboarding')).toBe(true);
        expect(confirmMatches('onboarding', 'Onboarding')).toBe(false);
        expect(confirmMatches('', '')).toBe(false);
        expect(removeBody('detach', 'X', true)).toEqual({ confirm: 'X', mode: 'detach' });
        expect(removeBody('delete', 'X', false)).toEqual({ confirm: 'X', mode: 'delete', deleteData: false });
        expect(removeBody('delete', 'X', true)).toEqual({ confirm: 'X', mode: 'delete', deleteData: true });
    });
});
