import { providersForIntegrations } from './integrationProviders.mts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

interface Task { id: string; userId: string; planId?: string | null; triggerKind?: string | null }
interface Plan { permissions?: { grants?: {app: string}[] } }
type ReadPlan = (id: string) => Promise<Plan | null>;

/** A scheduled, approved flow uses the apps in its plan. Other trigger kinds can need their own credentials. */
export async function scheduledProviders(item: Task, read: ReadPlan): Promise<string[] | null> {
    if (!item.planId || (item.triggerKind ?? 'schedule') !== 'schedule') return null;
    const grants = (await read(item.id))?.permissions?.grants;
    if (!Array.isArray(grants) || !grants.every(g => typeof g?.app === 'string')) return null;
    return providersForIntegrations(grants.map(g => g.app));
}

export interface ConnectionIssue { canResume: boolean; providers: string[] }

export async function taskConnectionIssue(item: Task): Promise<ConnectionIssue | undefined> {
    const needed = await scheduledProviders(item, id => require('../stores/coworkStore').getApprovedPlan(id));
    if (!needed) return undefined;
    if (!needed.length) return {canResume: true, providers: []};
    const stored: {provider: string; status: string}[] = await require('../stores/automationCredentialStore').listProvidersForUser(item.userId);
    const providers = needed.filter(id => !stored.some(row => row.provider === id && row.status === 'active'));
    return {canResume: providers.length === 0, providers};
}
