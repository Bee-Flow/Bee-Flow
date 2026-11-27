import { useToolCatalogQuery } from '@/api/queries/agentWizardFacts';
import { useMyCoworkPolicy } from '@/api/coworkPolicy';
import { useReadableTables } from '@/api/coworkStart';
import { useEntitlements } from '../licensing/EntitlementsContext';

export type ExampleId = 'meetings' | 'mail' | 'files' | 'alert';
interface App { id: string; label: string; available: boolean | null }
const mailApps = new Set(['gmail', 'outlook', 'outlook-readonly', 'nextcloud-mail']);

function eligibleExamples(apps: App[], hasMail: boolean, hasTables: boolean, canWrite: boolean) {
    const ids = new Set<ExampleId>();
    if (apps.some(app => app.id === 'fireflies')) ids.add('meetings');
    if (hasMail) ids.add('mail');
    if (hasTables) ids.add('alert');
    if (canWrite && apps.some(app => app.id === 'nextcloud')) ids.add('files');
    return ids;
}

export function useExampleAccess(enabled: boolean) {
    const catalog = useToolCatalogQuery<App>(enabled);
    const policy = useMyCoworkPolicy();
    const allowed = policy.isSuccess && !policy.data.unreadable ? policy.data.unattendedApps : [];
    const permits = (id: string) => allowed === null || !!allowed?.includes(id);
    const apps = catalog.isSuccess && !catalog.data.degraded
        ? catalog.data.apps.filter(app => app.available === true && permits(app.id)) : [];
    const canReadTables = useEntitlements().can('datatables') && permits('datatables');
    const tableQuery = useReadableTables(enabled && canReadTables);
    const tables = canReadTables && tableQuery.isSuccess ? tableQuery.data : [];
    const writable = tables.filter(table => !table.managedKind && (table.grade === 'owner' || table.grade === 'editor'));
    const mail = apps.filter(app => mailApps.has(app.id));
    const ids = eligibleExamples(apps, mail.length > 0, tables.length > 0, writable.length > 0 && policy.data?.readOnly === false);
    return { ids, mail, tables, writable };
}
export type ExampleAccess = ReturnType<typeof useExampleAccess>;
