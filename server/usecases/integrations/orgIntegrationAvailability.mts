/**
 * Which integrations are AVAILABLE to one organisation, for the admin
 * dashboard (GET /auth/organizations/:orgId/integration-availability).
 *
 * The rule: a setting for an integration renders only when the integration is
 *
 *     configured on this server
 *   ∧ in the organisation's ceiling (plan / licence ∩ its access menu ∩ the
 *     legacy per-org allow-list)
 *   ∧ where it matters, bound to the organisation (Nextcloud),
 *
 * and, for a platform module, the module is on. Per-group grants decide only
 * whether a MEMBER may use it, never whether an admin setting shows, so they
 * are not read here.
 *
 * Everything is answered for the CHOSEN organisation, never from the viewer's
 * session: a platform admin who picks organisation X gets X's plan, X's
 * Nextcloud binding and X's GitHub sync.
 *
 * The answer carries booleans and ids only: no name, address, e-mail, URL or
 * configuration value, and nothing personal (decision record: personal data
 * does not leave Bee Flow; this one never leaves the server's own admin UI
 * either, but it is built from an allow-list of fields all the same).
 */

import { createRequire } from 'node:module';
import {
    resolveOrgEntitlementSnapshot,
    unionKindArrays,
    type OrgEntitlementSnapshot,
} from '../../core/entitlements/orgEntitlementSnapshot.mts';
import {
    FAMILIES,
    FAMILY_IDS,
    SERVER_REQUIREMENT,
    type FamilyId,
    type FamilySpec,
    type ServerSignals,
    type SwitchFacts,
} from './integrationFamilySpecs.mts';

export { FAMILY_IDS, GOOGLE_CAPABILITIES, MICROSOFT_CAPABILITIES, type FamilyId } from './integrationFamilySpecs.mts';

const nodeRequire = createRequire(import.meta.url);

// ── Shapes ──────────────────────────────────────────────────────────────

export type UnavailableReason = 'not_configured' | 'not_in_plan' | 'not_granted_to_org' | 'module_off' | 'not_bound';

export interface FamilyAvailability {
    serverConfigured: boolean;
    inCeiling: boolean;
    available: boolean;
    reason?: UnavailableReason;
}

export interface IntegrationAvailability {
    serverConfigured: boolean;
    inCeiling: boolean;
    available: boolean;
    /** not_configured, not_in_plan, not_granted_to_org (a Nextcloud app the org switched off too) or not_bound. */
    reason?: UnavailableReason;
}

export interface OrgIntegrationAvailability {
    orgId: string;
    /** The chosen organisation is the viewer's own. */
    homeOrg: boolean;
    /** The entitlement resolver could not read the plan: every ceiling reads as closed. */
    degraded: boolean;
    families: Record<FamilyId, FamilyAvailability>;
    nextcloud: { bound: boolean; instanceId?: string; apps: string[]; pairingAvailable: boolean };
    microsoft: { directoryConnected: boolean };
    github: { syncConfigured: boolean };
    signIn: { password: boolean; google: boolean; microsoft: boolean; ssoLicensed: boolean };
    /** Per catalogue integration id. */
    integrations: Record<string, IntegrationAvailability>;
}

/** Whether an integration capability is set up on this server, per id. */
export type ServerConfiguredMap = Record<string, { serverConfigured: boolean; reason?: 'not_configured' }>;

/** Who asks: only their home organisation is read, to answer `homeOrg`. */
export interface AvailabilityViewer { organizationId?: string | null }

// ── Collaborators (a test passes its own; the real ones load on first use) ──

interface AuthConfig { providers?: { google?: { clientId?: string; clientSecret?: string }; microsoft?: { clientId?: string; clientSecret?: string; tenantId?: string } } }
interface OrgRow { id: string; nc_instance_id?: string | null; enabledIntegrations?: unknown; [k: string]: unknown }

export interface AvailabilityDeps {
    loadAuthConfig?: () => Promise<AuthConfig>;
    getSecret?: (key: string) => Promise<unknown>;
    getConfig?: (key: string) => Promise<unknown>;
    imageGenerationAvailable?: () => Promise<boolean>;
    /** A web search provider is set up (integrations/webSearchAvailability.js). */
    webSearchAvailable?: () => Promise<boolean>;
    isModuleActive?: (moduleId: string) => Promise<boolean>;
    hasLicenseFeature?: (orgId: string, feature: string) => Promise<boolean>;
    getOrganization?: (orgId: string) => Promise<OrgRow | null>;
    snapshot?: (orgId: string) => Promise<OrgEntitlementSnapshot>;
    orgAllowList?: (org: OrgRow) => Promise<string[] | null>;
    ncScopeDoc?: (orgId: string) => Promise<{ integrations?: Record<string, { mode?: string }> } | null>;
    azureSyncBinding?: () => Promise<{ syncOrganizationId?: unknown; syncTenantId?: unknown } | null>;
    githubSyncConfig?: (orgId: string) => Promise<{ repoOwner?: string; repoName?: string } | null>;
    env?: NodeJS.ProcessEnv;
}

const configStore = () => nodeRequire('../../stores/configStore.js') as { getConfig(k: string): Promise<unknown>; getSecret(k: string): Promise<unknown> };
const bestEffort = () => nodeRequire('../../utils/bestEffort.js') as { fallback<T>(label: string, err: unknown, value: T): T };

const REAL: Required<Omit<AvailabilityDeps, 'env'>> = {
    loadAuthConfig: () => (nodeRequire('../../auth/permissions.js') as { loadConfig(): Promise<AuthConfig> }).loadConfig(),
    getSecret: (key) => configStore().getSecret(key),
    getConfig: (key) => configStore().getConfig(key),
    imageGenerationAvailable: () => (nodeRequire('../../core/media/imageModels.mts') as { isImageGenerationAvailable(): Promise<boolean> }).isImageGenerationAvailable(),
    webSearchAvailable: async () => (await (nodeRequire('../../integrations/webSearchAvailability.js') as { webSearchProviderStatus(): Promise<{ available: boolean }> }).webSearchProviderStatus()).available,
    isModuleActive: (id) => (nodeRequire('../../modules/index.js') as { isModuleActive(id: string): Promise<boolean> }).isModuleActive(id),
    hasLicenseFeature: (orgId, feature) => (nodeRequire('../../license/index.js') as { hasFeature(scope: string, f: string): Promise<boolean> }).hasFeature(orgId, feature),
    getOrganization: (orgId) => (nodeRequire('../../stores/userStore.js') as { getOrganization(id: string): Promise<OrgRow | null> }).getOrganization(orgId),
    snapshot: (orgId) => resolveOrgEntitlementSnapshot(orgId),
    // The runtime gates' reading of the legacy allow-list: the org column
    // overrides when it is set, else the global default, else no restriction.
    orgAllowList: async (org) => {
        const { resolveOrgAllowList } = nodeRequire('../../core/integrations/enabledIntegrations.js') as {
            resolveOrgAllowList(org: OrgRow, opts: { overrideWhen: 'truthy'; parse: 'lenient'; whenUnset: null }): Promise<unknown>;
        };
        const list = await resolveOrgAllowList(org, { overrideWhen: 'truthy', parse: 'lenient', whenUnset: null });
        return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : null;
    },
    ncScopeDoc: async (orgId) => (nodeRequire('../../core/integrations/ncScope.js') as { getOrgScopeDoc(id: string): Promise<{ integrations?: Record<string, { mode?: string }> } | null> }).getOrgScopeDoc(orgId),
    azureSyncBinding: () => (nodeRequire('../../integrations/azureGroupSync.js') as { getSyncBinding(): Promise<{ syncOrganizationId?: unknown; syncTenantId?: unknown } | null> }).getSyncBinding(),
    // GitHub sync belongs to the module "int_saas": without it there is no sync config (null, as unconfigured).
    githubSyncConfig: async (orgId) => {
        const { optionalFeatureModule } = nodeRequire('../../core/featureModules.js') as { optionalFeatureModule(name: 'stores/githubSyncStore'): { getOrgSyncConfig(id: string): Promise<{ repoOwner?: string; repoName?: string } | null> } | null };
        const store = optionalFeatureModule('stores/githubSyncStore');
        return store ? store.getOrgSyncConfig(orgId) : null;
    },
};

const { HttpError } = nodeRequire('../../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { INTEGRATION_CATALOG } = nodeRequire('../../core/entitlements/capabilityRegistry.js') as { INTEGRATION_CATALOG: ReadonlyArray<{ id: string }> };
const { NC_INTEGRATION_IDS } = nodeRequire('../../core/integrations/ncIntegrationCatalog.js') as { NC_INTEGRATION_IDS: readonly string[] };
const { groupSyncView } = nodeRequire('../orgAzureSyncView.js') as {
    groupSyncView(input: { orgId: string; status: null; settings: null; binding: unknown; microsoft: unknown }): { directoryConfigured: boolean };
};

// ── Reads ───────────────────────────────────────────────────────────────

function withDeps(deps: AvailabilityDeps) {
    return { ...REAL, ...deps } as Required<Omit<AvailabilityDeps, 'env'>> & { env?: NodeJS.ProcessEnv };
}

/** A read that fails counts as "not there": every caller here reports a boolean. */
async function safely<T>(label: string, read: () => Promise<T>, fallbackValue: T): Promise<T> {
    try { return await read(); } catch (err) { return bestEffort().fallback(`usecases/integrations/orgIntegrationAvailability:${label}`, err, fallbackValue); }
}

const filled = (v: unknown) => typeof v === 'string' ? v.trim() !== '' : !!v;

async function readServerSignals(d: ReturnType<typeof withDeps>, env: NodeJS.ProcessEnv): Promise<{ signals: ServerSignals; auth: AuthConfig }> {
    const auth = await safely('auth-config', () => d.loadAuthConfig(), {} as AuthConfig);
    const secret = (key: string) => safely(`secret:${key}`, () => d.getSecret(key), null);
    const google = auth.providers?.google;
    const microsoft = auth.providers?.microsoft;
    // LinkedIn and Withings fall back to the environment, as their connect routes do.
    const pair = async (idKey: string, secretKey: string, idEnv: string, secretEnv: string) =>
        filled((await secret(idKey)) || env[idEnv]) && filled((await secret(secretKey)) || env[secretEnv]);
    const signals: ServerSignals = {
        google: filled(google?.clientId) && filled(google?.clientSecret),
        microsoft: filled(microsoft?.clientId) && filled(microsoft?.clientSecret),
        mapsKey: filled(await secret('google_maps_api_key')),
        linkedin: await pair('linkedin_client_id', 'linkedin_client_secret', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'),
        withings: await pair('withings_client_id', 'withings_client_secret', 'WITHINGS_CLIENT_ID', 'WITHINGS_CLIENT_SECRET'),
        imageGen: await safely('image-gen', () => d.imageGenerationAvailable(), false),
        transcription: filled(await secret('mistral_api_key')),
        googleApiKey: filled(await secret('google_api_key')),
        elevenlabs: filled(await secret('elevenlabs_api_key')),
        webSearch: await safely('web-search', () => d.webSearchAvailable(), false),
    };
    return { signals, auth };
}

/** Every integration id the catalogues know: the built-in catalogue, then the Nextcloud family. */
function catalogueIds(): string[] {
    return [...new Set([...INTEGRATION_CATALOG.map(i => i.id), ...NC_INTEGRATION_IDS])];
}

function serverConfiguredFrom(signals: ServerSignals, ids: readonly string[]): ServerConfiguredMap {
    const out: ServerConfiguredMap = {};
    for (const id of ids) {
        const need = SERVER_REQUIREMENT[id];
        const ok = need ? need(signals) : true;
        out[id] = ok ? { serverConfigured: true } : { serverConfigured: false, reason: 'not_configured' };
    }
    return out;
}

/**
 * Whether each integration capability is set up on this server (Google and
 * Microsoft apps, Maps, LinkedIn, Withings, image and video generation,
 * transcription, ElevenLabs, web search).
 * An id that needs nothing on the server (a per-user key, a per-org address)
 * is configured. `ids` defaults to every catalogue integration id.
 */
export async function serverConfiguredMap(ids?: readonly string[], deps: AvailabilityDeps = {}): Promise<ServerConfiguredMap> {
    const d = withDeps(deps);
    const { signals } = await readServerSignals(d, deps.env ?? process.env);
    return serverConfiguredFrom(signals, ids ?? catalogueIds());
}

/**
 * A matrix payload (GET group-access, org-availability) with
 * `serverConfigured: { [capId]: { serverConfigured, reason? } }` for each of
 * its integration rows. Additive: when the flags cannot be read the payload
 * goes out as it always did, without the key.
 */
export async function withServerConfigured<P extends { capabilities: ReadonlyArray<{ id: string; kind: string }> }>(payload: P, deps: AvailabilityDeps = {}): Promise<P & { serverConfigured?: ServerConfiguredMap }> {
    const ids = payload.capabilities.filter(c => c.kind === 'integration').map(c => c.id);
    const map = await safely('matrix-server-configured', () => serverConfiguredMap(ids, deps), null);
    return map ? { ...payload, serverConfigured: map } : payload;
}

// ── The ceiling ─────────────────────────────────────────────────────────

interface Ceiling {
    /** In the org's plan / licence ceiling. */
    inPlan(id: string): boolean;
    /** In the plan, the org's access menu and (for an integration) the legacy allow-list. */
    inCeiling(id: string): boolean;
}

function ceilingOf(snap: OrgEntitlementSnapshot, allowList: string[] | null): Ceiling {
    const plan = new Set(unionKindArrays(snap.ceiling));
    const menu = new Set(unionKindArrays(snap.orgAvailable));
    const integrationIds = new Set(snap.orgAvailable.integration || []);
    const allowed = allowList ? new Set(allowList) : null;
    return {
        inPlan: (id) => plan.has(id),
        inCeiling: (id) => menu.has(id) && (!integrationIds.has(id) || !allowed || allowed.has(id)),
    };
}

interface FamilyFacts {
    signals: ServerSignals; switches: SwitchFacts; moduleOn: (id: string) => boolean; ceiling: Ceiling; bound: boolean;
    licensed: (feature: string) => boolean;
}

/** Nextcloud is exempt from the plan, a licence family follows its licence, the rest any of its capabilities. */
function familyInCeiling(spec: FamilySpec, facts: FamilyFacts): boolean {
    if (spec.needsBinding) return true;
    if (spec.licenseFeature) return facts.licensed(spec.licenseFeature);
    return spec.capabilities.some(id => facts.ceiling.inCeiling(id));
}

function familyOf(spec: FamilySpec, facts: FamilyFacts): FamilyAvailability {
    const serverConfigured = spec.serverConfigured ? spec.serverConfigured(facts.signals) : true;
    const inCeiling = familyInCeiling(spec, facts);
    let reason: UnavailableReason | undefined;
    if ((spec.module && !facts.moduleOn(spec.module)) || (spec.switchedOn && !spec.switchedOn(facts.switches))) reason = 'module_off';
    else if (!serverConfigured) reason = 'not_configured';
    // A licence family has no capability rows, so it reads as not_in_plan.
    else if (!inCeiling) reason = spec.capabilities.some(id => facts.ceiling.inPlan(id)) ? 'not_granted_to_org' : 'not_in_plan';
    else if (spec.needsBinding && !facts.bound) reason = 'not_bound';
    return reason ? { serverConfigured, inCeiling, available: false, reason } : { serverConfigured, inCeiling, available: true };
}

/** One entry per catalogue integration id. A Nextcloud app is exempt from the plan; the binding and the org's own switch decide it. */
function integrationsOf(configured: ServerConfiguredMap, ceiling: Ceiling, nextcloud: OrgIntegrationAvailability['nextcloud']): Record<string, IntegrationAvailability> {
    const ncApps = new Set(nextcloud.apps);
    const out: Record<string, IntegrationAvailability> = {};
    for (const id of catalogueIds()) {
        const isNc = NC_INTEGRATION_IDS.includes(id);
        const serverConfigured = configured[id].serverConfigured;
        const inCeiling = isNc || ceiling.inCeiling(id);
        let reason: UnavailableReason | undefined;
        if (!serverConfigured) reason = 'not_configured';
        else if (!inCeiling) reason = ceiling.inPlan(id) ? 'not_granted_to_org' : 'not_in_plan';
        else if (isNc && !nextcloud.bound) reason = 'not_bound';
        else if (isNc && !ncApps.has(id)) reason = 'not_granted_to_org';
        out[id] = reason ? { serverConfigured, inCeiling, available: false, reason } : { serverConfigured, inCeiling, available: true };
    }
    return out;
}

const ENABLED_UNLESS_FALSE = (v: unknown) => v !== false && v !== 'false';

async function readNextcloud(d: ReturnType<typeof withDeps>, org: OrgRow): Promise<OrgIntegrationAvailability['nextcloud']> {
    const instanceId = typeof org.nc_instance_id === 'string' && org.nc_instance_id ? org.nc_instance_id : null;
    // Pairing has no server switch to read: an organisation admin (or a platform
    // admin for any organisation) may mint a code on every server
    // (POST /auth/admin/nc-bindings/generate-pairing-code), and the connector
    // redeems it whatever the provisioning mode, which governs only an unknown
    // Nextcloud creating a new organisation (auth/connector/provisioning.js).
    // The one condition is that the organisation is not bound yet.
    if (!instanceId) return { bound: false, apps: [], pairingAvailable: true };
    // The org's own Nextcloud switches (the NC integrations panel). No document
    // yet means nobody chose: every family is on.
    const doc = await safely('nc-scope', () => d.ncScopeDoc(org.id), null);
    const scoped = doc?.integrations || null;
    const apps = NC_INTEGRATION_IDS.filter(id => !scoped || (scoped[id]?.mode ?? 'all') !== 'off');
    return { bound: true, instanceId, apps, pairingAvailable: false };
}

async function readMicrosoftDirectory(d: ReturnType<typeof withDeps>, orgId: string, auth: AuthConfig): Promise<boolean> {
    const binding = await safely('azure-binding', () => d.azureSyncBinding(), null);
    return groupSyncView({ orgId, status: null, settings: null, binding, microsoft: auth.providers?.microsoft }).directoryConfigured;
}

/**
 * The integration availability of organisation `orgId`. 404 when it does not
 * exist. Never throws for a signal it cannot read: that signal reads as "not
 * there" (and a resolver that could not read the plan sets `degraded`).
 */
export async function resolveOrgIntegrationAvailability(orgId: string, viewer: AvailabilityViewer = {}, deps: AvailabilityDeps = {}): Promise<OrgIntegrationAvailability> {
    const d = withDeps(deps);
    const env = deps.env ?? process.env;
    const org = await d.getOrganization(orgId);
    if (!org) throw new HttpError(404, 'org_not_found', 'Organisation not found');

    const [snap, allowList, { signals, auth }] = await Promise.all([
        d.snapshot(orgId),
        safely('allow-list', () => d.orgAllowList(org), null),
        readServerSignals(d, env),
    ]);
    const ceiling = ceilingOf(snap, allowList);

    const moduleIds = [...new Set(Object.values(FAMILIES).map(f => f.module).filter((m): m is string => !!m))];
    // A module state that cannot be read counts as on, as the module gate's own ticks do.
    const moduleStates = new Map(await Promise.all(moduleIds.map(async (id) => [id, await safely(`module:${id}`, () => d.isModuleActive(id), true)] as const)));
    const switches: SwitchFacts = {
        meetingNotesEnv: env.ENABLE_MEETING_NOTES !== 'false',
        projectsConfig: ENABLED_UNLESS_FALSE(await safely('projects-flag', () => d.getConfig('feature_projects_enabled'), null)),
    };

    // A licence that cannot be read counts as absent (fail closed, like the route gate).
    const features = [...new Set(Object.values(FAMILIES).map(f => f.licenseFeature).filter((f): f is string => !!f))];
    const licences = new Map(await Promise.all(features.map(async (f) => [f, await safely(`licence:${f}`, () => d.hasLicenseFeature(orgId, f), false)] as const)));

    const nextcloud = await readNextcloud(d, org);
    const facts = {
        signals, switches, moduleOn: (id: string) => moduleStates.get(id) !== false, ceiling, bound: nextcloud.bound,
        licensed: (f: string) => licences.get(f) === true,
    };
    const families = Object.fromEntries(FAMILY_IDS.map(id => [id, familyOf(FAMILIES[id], facts)])) as Record<FamilyId, FamilyAvailability>;

    const integrations = integrationsOf(serverConfiguredFrom(signals, catalogueIds()), ceiling, nextcloud);

    const githubSync = await safely('github-sync', () => d.githubSyncConfig(orgId), null);
    return {
        orgId,
        homeOrg: !!viewer.organizationId && viewer.organizationId === orgId,
        degraded: snap.degraded === true,
        families,
        nextcloud,
        microsoft: { directoryConnected: await readMicrosoftDirectory(d, orgId, auth) },
        github: { syncConfigured: filled(githubSync?.repoOwner) && filled(githubSync?.repoName) },
        signIn: {
            password: env.ALLOW_PASSWORD_LOGIN !== 'false',
            google: signals.google,
            microsoft: signals.microsoft,
            ssoLicensed: await safely('sso-licence', () => d.hasLicenseFeature(orgId, 'sso_saml'), false),
        },
        integrations,
    };
}
