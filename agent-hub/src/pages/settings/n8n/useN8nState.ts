import { useMemo, useRef, useState } from 'react';
import {
    filterConfigured, filterDiscovered, withInputs, workflowFromDiscovered,
    type DiscoveredWorkflow, type FlashMessage, type N8nDiagnostics, type N8nInput, type N8nWorkflow,
    type PermissionSummary, type TestResult,
} from './n8nModel';
import { errorMessage } from '@/utils/caughtError';
import { RefusedError, errorBody } from '@/api/mutate';
import { useTranslation } from '@/hooks/useTranslation';
import { apiFetch, apiRequest } from '@/api/typedRequest';

/**
 * The query of an /ai/n8n call for `orgId`: the organisation a platform admin chose in
 * the admin dashboard (sent as ?orgId=), or none for the caller's own.
 */
const orgQuery = (orgId: string | null) => (orgId ? { orgId } : undefined);

/** The status line's message, and clearing it after a while. */
export function useFlashMessage() {
    const [message, setMessage] = useState<FlashMessage | null>(null);
    // One pending clear at a time: the timer of an earlier message must not wipe a later one.
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearAfter = (ms: number) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { timer.current = null; setMessage(null); }, ms);
    };
    return { message, setMessage, clearAfter };
}
export type Flash = ReturnType<typeof useFlashMessage>;

type JsonSendKey = 'PUT /ai/n8n/workflows' | 'PUT /ai/n8n/config' | 'POST /ai/n8n/test' | 'PUT /ai/n8n/permissions' | 'POST /auth/groups';

/** An unchecked JSON write (the caller reads `res.ok`); the body is sent as built, whatever the schema type. */
const jsonSend = (key: JsonSendKey, orgId: string | null, body: unknown) => apiFetch(key, {
    query: key === 'POST /auth/groups' ? undefined : orgQuery(orgId),
    init: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
});

/** The configured workflows, discovery on the instance, and their editing. */
export function useN8nWorkflows({ setMessage, clearAfter }: Flash, orgId: string | null = null) {
    const [workflows, setWorkflows] = useState<N8nWorkflow[]>([]);
    const [discoveredWorkflows, setDiscoveredWorkflows] = useState<DiscoveredWorkflow[]>([]);
    const [discovering, setDiscovering] = useState(false);
    const [expandedWf, setExpandedWf] = useState<string | null>(null);
    const [wfSearch, setWfSearch] = useState('');
    const [saving, setSaving] = useState(false);

    const discoverWorkflows = async () => {
        setDiscovering(true);
        try {
            const res = await apiFetch('GET /ai/n8n/workflows', { query: orgQuery(orgId) });
            if (res.ok) {
                const data = await res.json();
                setDiscoveredWorkflows(data.workflows || []);
                setMessage({ type: 'success', text: `Found ${(data.workflows || []).length} webhook workflow(s)` });
            } else {
                const err = await res.json();
                setMessage({ type: 'error', text: err.error || 'Failed to fetch workflows' });
            }
        } catch {
            setMessage({ type: 'error', text: 'Connection failed — check URL and API key' });
        }
        setDiscovering(false);
        clearAfter(4000);
    };

    const persistWorkflows = async (wfs: N8nWorkflow[]) => {
        try {
            await jsonSend('PUT /ai/n8n/workflows', orgId, { workflows: wfs });
        } catch (e) { console.error('n8n auto-save failed:', e); }
    };

    const addWorkflow = (discovered: DiscoveredWorkflow) => {
        if (workflows.some(w => w.id === discovered.id)) {
            setMessage({ type: 'error', text: 'Workflow already added' });
            clearAfter(2000);
            return;
        }
        const updated = [...workflows, workflowFromDiscovered(discovered)];
        setWorkflows(updated);
        setExpandedWf(discovered.id);
        persistWorkflows(updated);
        setMessage({ type: 'success', text: `Added "${discovered.name}"` });
        clearAfter(2000);
    };

    const removeWorkflow = (id: string) => {
        const updated = workflows.filter(w => w.id !== id);
        setWorkflows(updated);
        persistWorkflows(updated);
    };
    const updateWorkflow = (id: string, updates: Partial<N8nWorkflow>) => {
        setWorkflows(prev => prev.map(w => w.id === id ? { ...w, ...updates } : w));
    };
    // Saved at once rather than with "Save All": the KB switch is a grant.
    const toggleKbIngestion = (id: string) => {
        const updated = workflows.map(w => w.id === id ? { ...w, allowKbIngestion: !w.allowKbIngestion } : w);
        setWorkflows(updated);
        persistWorkflows(updated);
    };
    const addInput = (wfId: string) => setWorkflows(prev => withInputs(prev, wfId, inputs => [...inputs, { name: '', type: 'string', description: '', required: true }]));
    const updateInput = (wfId: string, idx: number, updates: Partial<N8nInput>) =>
        setWorkflows(prev => withInputs(prev, wfId, inputs => { inputs[idx] = { ...inputs[idx], ...updates }; return inputs; }));
    const removeInput = (wfId: string, idx: number) =>
        setWorkflows(prev => withInputs(prev, wfId, inputs => { inputs.splice(idx, 1); return inputs; }));

    const saveWorkflows = async () => {
        setSaving(true);
        try {
            const res = await jsonSend('PUT /ai/n8n/workflows', orgId, { workflows });
            if (res.ok) setMessage({ type: 'success', text: 'Workflows saved' });
            else {
                const err = await res.json();
                setMessage({ type: 'error', text: err.error || 'Failed to save' });
            }
        } catch {
            setMessage({ type: 'error', text: 'Failed to save' });
        }
        setSaving(false);
        clearAfter(3000);
    };

    const filteredWorkflows = useMemo(() => filterConfigured(workflows, wfSearch), [workflows, wfSearch]);
    const filteredDiscovered = useMemo(() => filterDiscovered(discoveredWorkflows, wfSearch), [discoveredWorkflows, wfSearch]);

    return {
        workflows, setWorkflows, filteredWorkflows, filteredDiscovered, discovering, discoverWorkflows,
        expandedWf, setExpandedWf, wfSearch, setWfSearch, saving, setSaving,
        addWorkflow, removeWorkflow, updateWorkflow, toggleKbIngestion, addInput, updateInput, removeInput, saveWorkflows,
    };
}
export type N8nWorkflows = ReturnType<typeof useN8nWorkflows>;

/** The access-check diagnostics and "Enable for organisation". */
function useN8nDiagnostics({ setMessage, clearAfter }: Flash, orgId: string | null) {
    const [diagLoading, setDiagLoading] = useState(false);
    const [diag, setDiag] = useState<N8nDiagnostics | null>(null);
    const [enablingForOrg, setEnablingForOrg] = useState(false);

    const loadDiagnostics = async () => {
        setDiagLoading(true);
        try {
            const res = await apiRequest('GET /ai/n8n/diagnostics').catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) setDiag(await res.json());
            else setDiag({ ok: false, error: 'Failed to load diagnostics' });
        } catch (e) {
            setDiag({ ok: false, error: errorMessage(e) });
        }
        setDiagLoading(false);
    };

    const enableForOrg = async () => {
        setEnablingForOrg(true);
        try {
            let res: Response | undefined;
            try {
                res = await apiRequest('POST /ai/n8n/enable-for-org', { query: orgQuery(orgId) });
            } catch (apiErr) {
                if (!(apiErr instanceof RefusedError)) throw apiErr;
                const err = errorBody(apiErr) ?? {};
                setMessage({ type: 'error', text: err.error || 'Failed to enable' });
            }
            if (res) {
                const data = await res.json();
                setMessage({
                    type: 'success',
                    text: data.changed ? 'n8n enabled for this organisation' : (data.note || 'n8n was already enabled'),
                });
                await loadDiagnostics();
            }
        } catch {
            setMessage({ type: 'error', text: 'Request failed' });
        }
        setEnablingForOrg(false);
        clearAfter(3000);
    };

    return { diag, diagLoading, loadDiagnostics, enableForOrg, enablingForOrg };
}

/** The connection form: load, save and test the instance URL and API key. */
export function useN8nConnection(flash: Flash, wf: Pick<N8nWorkflows, 'setWorkflows' | 'setSaving'>, orgId: string | null = null) {
    const { t } = useTranslation();
    const { setMessage, clearAfter } = flash;
    const [loading, setLoading] = useState(true);
    const [n8nUrl, setN8nUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [hasApiKey, setHasApiKey] = useState(false);
    const [configured, setConfigured] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<TestResult | null>(null);
    const diagnostics = useN8nDiagnostics(flash, orgId);

    const loadConfig = async () => {
        setLoading(true);
        // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
        try {
            const res = await apiRequest('GET /ai/n8n/config', { query: orgQuery(orgId) }).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                setN8nUrl(data.n8nUrl || '');
                setHasApiKey(data.hasApiKey);
                setConfigured(data.configured);
                wf.setWorkflows(data.workflows || []);
            }
        } catch (e) { console.error(e); }
        setLoading(false);
    };

    const saveConnection = async () => {
        wf.setSaving(true);
        try {
            const res = await jsonSend('PUT /ai/n8n/config', orgId, apiKey ? { n8nUrl, apiKey } : { n8nUrl });
            if (res.ok) {
                // The server stores a key only when one was sent; another address without one drops the stored key.
                const { apiKeyCleared } = await res.json().catch(() => ({})) as { apiKeyCleared?: boolean };
                const keyKept = !!apiKey || (hasApiKey && !apiKeyCleared);
                setMessage(apiKeyCleared
                    ? { type: 'error', text: t('settings.n8n.key_cleared', 'Address saved. The stored API key belonged to the previous address and was removed: enter the API key again.') }
                    : { type: 'success', text: 'Connection saved' });
                setHasApiKey(keyKept);
                setConfigured(!!(n8nUrl && keyKept));
                setApiKey('');
                setTestResult(null); // invalidate previous test
            } else {
                const err = await res.json();
                setMessage({ type: 'error', text: err.error || 'Failed to save' });
            }
        } catch {
            setMessage({ type: 'error', text: 'Failed to save' });
        }
        wf.setSaving(false);
        clearAfter(3000);
    };

    const testConnection = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            // If the user typed new creds but hasn't hit Save, test those instead.
            const res = await jsonSend('POST /ai/n8n/test', orgId, {
                ...(n8nUrl ? { n8nUrl } : {}),
                ...(apiKey ? { apiKey } : {}),
            });
            setTestResult(await res.json());
        } catch (e) {
            setTestResult({ ok: false, error: errorMessage(e) });
        }
        setTesting(false);
    };

    return {
        loading, loadConfig, n8nUrl, setN8nUrl, apiKey, setApiKey, hasApiKey, configured,
        testing, testResult, saveConnection, testConnection, ...diagnostics,
    };
}
export type N8nConnection = ReturnType<typeof useN8nConnection>;

/** Who may let the AI modify workflows: load, grant/revoke, create-and-grant. */
export function useN8nPermissions({ setMessage, clearAfter }: Flash, orgId: string | null = null) {
    const [permLoading, setPermLoading] = useState(false);
    const [permSummary, setPermSummary] = useState<PermissionSummary | null>(null);

    const loadPermissions = async () => {
        setPermLoading(true);
        try {
            const res = await apiRequest('GET /ai/n8n/permissions', { query: orgQuery(orgId) }).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) setPermSummary(await res.json());
            else setPermSummary({ error: 'Failed to load permissions' });
        } catch (e) {
            setPermSummary({ error: errorMessage(e) });
        }
        setPermLoading(false);
    };

    const fail = (text: string, ms = 3000) => { setMessage({ type: 'error', text }); clearAfter(ms); return false; };

    const mutatePermission = async (permission: string, groupId: string, action: 'add' | 'remove') => {
        try {
            const res = await jsonSend('PUT /ai/n8n/permissions', orgId, { permission, groupId, action });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                return fail(err.error || 'Failed to update permission');
            }
            setMessage({ type: 'success', text: action === 'add' ? 'Group granted access' : 'Group access revoked' });
            clearAfter(2000);
            await loadPermissions();
            return true;
        } catch {
            return fail('Request failed');
        }
    };

    // Inline create-and-grant: POST /auth/groups then PUT the permission.
    // Removes the "create a group elsewhere, come back here to grant" hop.
    const createGroupAndGrant = async (name: string, permission: string) => {
        const trimmed = (name || '').trim();
        if (!trimmed) return fail('Group name required', 2500);
        try {
            const res = await jsonSend('POST /auth/groups', orgId, { name: trimmed, permissions: [permission], ...(orgId ? { organizationId: orgId } : {}) });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                return fail(err.error || 'Failed to create group');
            }
            setMessage({ type: 'success', text: `Group "${trimmed}" created and granted access` });
            clearAfter(2500);
            await loadPermissions();
            return true;
        } catch {
            return fail('Request failed');
        }
    };

    return { permLoading, permSummary, loadPermissions, mutatePermission, createGroupAndGrant };
}
