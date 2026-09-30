import { accessChecks, cleanSlug, matchDiscovered, matchWorkflows, n8nStatus, serializeWorkflow, workflowFrom, workflowSlug } from './n8n';
import type { N8nWorkflow } from './n8nTypes';

const found = { id: 'wf1', name: 'Send Invoice — NL!', webhookNodes: [{ path: 'invoice', method: 'GET' }] };

describe('n8n workflows', () => {
    it('slugs a name the way addWorkflow does', () => {
        expect(workflowSlug('  Send Invoice — NL! ')).toBe('send_invoice_nl');
        expect(workflowSlug('x'.repeat(80))).toHaveLength(50);
        expect(cleanSlug('Send-me_2!')).toBe('endme_2');
    });

    it('configures a discovered workflow with the web’s defaults, and stores its outputs', () => {
        const wf = workflowFrom(found);
        expect(wf).toMatchObject({ id: 'wf1', slug: 'send_invoice_nl', webhookPath: 'invoice', httpMethod: 'GET', enabled: true, inputs: [], allowKbIngestion: false });
        expect(wf.description).toBe('Run n8n workflow: Send Invoice — NL!');
        expect(serializeWorkflow(wf)).toMatchObject({ outputs: [{ name: 'result', type: 'string', description: 'Workflow output' }] });
        expect(workflowFrom({ id: 'w2', name: 'No hook', webhookNodes: [] })).toMatchObject({ webhookPath: '', httpMethod: 'POST' });
    });

    it('sends back the fields the phone does not edit, under the edited ones', () => {
        const wf: N8nWorkflow = { ...workflowFrom(found), raw: { id: 'wf1', slug: 'old', timeout: 30 }, slug: 'new' };
        const out = serializeWorkflow(wf);
        expect(out).toMatchObject({ timeout: 30, slug: 'new' });
        expect(out).not.toHaveProperty('raw');
    });

    it('searches name, slug and description; discovered ones by name', () => {
        const a = { ...workflowFrom(found), description: 'Bills customers' };
        const b = { ...workflowFrom({ id: 'b', name: 'Other', webhookNodes: [] }) };
        expect(matchWorkflows([a, b], 'BILLS')).toEqual([a]);
        expect(matchWorkflows([a, b], 'send_inv')).toEqual([a]);
        expect(matchWorkflows([a, b], ' ')).toEqual([a, b]);
        expect(matchDiscovered([found], 'invoice')).toEqual([found]);
        expect(matchDiscovered([found], 'bills')).toEqual([]);
    });
});

describe('n8n status and access', () => {
    it('lets the last test win over the stored credentials', () => {
        expect(n8nStatus(false, null)).toEqual({ kind: 'unconfigured' });
        expect(n8nStatus(true, null)).toEqual({ kind: 'configured' });
        expect(n8nStatus(true, { ok: true, activeWebhookCount: 3, status: 200, error: null })).toEqual({ kind: 'connected', count: 3 });
        expect(n8nStatus(true, { ok: false, activeWebhookCount: null, status: 401, error: 'x'.repeat(100) })).toEqual({ kind: 'failed', error: 'x'.repeat(80) });
    });

    it('lists the four checks in the web’s order, with a fix on the failing ones', () => {
        const rows = accessChecks({ orgConfigured: true, orgEnabled: false, orgSource: 'org_list', userPasses: true, userReason: 'ok', canModify: false, tools: [] });
        expect(rows.map((r) => [r.id, r.ok, r.fix])).toEqual([
            ['credentials', true, null],
            ['org_enabled', false, 'enable_for_org'],
            ['user_can_use', true, null],
            ['can_modify', false, 'permissions'],
        ]);
        expect(rows[1]?.detail).toBe('org_list');
    });
});
