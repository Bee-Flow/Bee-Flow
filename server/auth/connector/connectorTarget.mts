/**
 * Where and how the server reaches an organisation's paired Nextcloud
 * connector for a SERVICE-level call (no Nextcloud user): the callback URL
 * the connector reported at pairing (`organizations.connector_callback_url`,
 * Nextcloud's AppAPI proxy in front of it) and the org's tenant key, which
 * signs the call (ncSigning.js signedConnectorHeaders, empty uid).
 *
 * Null when the org has no paired connector: no callback URL, no instance id
 * or no tenant key. Callers: appStudio/nextcloudMenuSync.js (the app menu
 * push) and automation/importers/windmill/sources/ncInventory.mts (the
 * Windmill inventory). Per-user tool traffic goes through
 * integrations/nextcloudClient.js instead.
 *
 * Reads the raw column names: `getOrganization` spreads the row without
 * camelCase aliases for these (the camelCase forms are accepted for callers
 * that hand in an already-normalised org, e.g. tests).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type OrgRow = Record<string, unknown> | null | undefined;

export interface ConnectorTarget {
    callbackUrl: string;
    tenantKey: string;
}

export async function resolveConnectorTarget(orgId: string): Promise<ConnectorTarget | null> {
    const userStore = nodeRequire('../../stores/userStore') as { getOrganization: (id: string) => Promise<OrgRow> };
    const configStore = nodeRequire('../../stores/configStore') as { getSecret: (key: string) => Promise<string | null | undefined> };
    const org = await userStore.getOrganization(orgId);
    if (!org) return null;
    const callbackUrl = org.connector_callback_url || org.connectorCallbackUrl || null;
    const ncInstanceId = org.nc_instance_id || org.ncInstanceId || null;
    if (!callbackUrl || !ncInstanceId) return null;
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${orgId}`);
    if (!tenantKey) return null;
    return { callbackUrl: String(callbackUrl).replace(/\/+$/, ''), tenantKey };
}
