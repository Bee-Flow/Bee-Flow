/**
 * The wizard's decisions, without Docker: what a POST /api/install body turns
 * into (secrets, the env handed to docker compose, the compose profiles), and
 * which compose services a POST /api/update names.
 *
 * Public: InstallBody, UpdateBody (zod schemas for the two request bodies),
 * buildInstallConfig(input, generateSecret), resolveUpdateServices(names).
 *
 * Invariant: nothing that reaches a shell comes from the request unchecked.
 * The install body only ever becomes env values; update service names are
 * spliced into an `sh -c` command line, so UpdateBody admits container-name
 * characters only.
 */

const { z } = require('zod');

const str = (max = 2048) => z.string().max(max);

const InstallBody = z.object({
    // Network
    serverProtocol: z.enum(['http', 'https']).optional(),
    serverHost: str(255).optional(),
    clientProtocol: z.enum(['http', 'https']).optional(),
    clientHost: str(255).optional(),
    serverPort: z.union([str(5), z.number().int()]).transform(String).optional(),
    clientPort: z.union([str(5), z.number().int()]).transform(String).optional(),
    // AI
    deploymentType: str(32).optional(),
    // Becomes part of an env var NAME (<PROVIDER>_API_KEY).
    aiProvider: z.string().regex(/^[A-Za-z0-9_]{0,32}$/, 'aiProvider must be a provider id').optional(),
    azureEndpoint: str().optional(),
    azureKey: str().optional(),
    azureVersion: str(64).optional(),
    azureModels: str().optional(),
    genericKey: str().optional(),
    officeAppsEnabled: z.boolean().optional(),
    // Search
    searchProvider: str(32).optional(),
    bingKey: str().optional(),
    bingMarket: str(16).optional(),
    serperKey: str().optional(),
    // Microsoft SSO
    msClientId: str(255).optional(),
    msClientSecret: str().optional(),
    msTenantId: str(255).optional(),
    // Services
    enableSearch: z.boolean().optional(),
    enableSearchGpu: z.boolean().optional(),
    enableSearchLlm: z.boolean().optional(),
    enableGuard: z.boolean().optional(),
    enableGuardGpu: z.boolean().optional(),
    enableWhisperx: z.boolean().optional(),
    enablePii: z.boolean().optional(),
    enableLocalLlm: z.boolean().optional(),
    // Secrets (auto-generated if empty)
    adminPassword: str(1024).optional(),
    dbPassword: str(1024).optional(),
    sessionSecret: str(1024).optional(),
    masterEncryptionKey: str(1024).optional(),
    servicesApiKey: str(1024).optional(),
    hfToken: str(1024).optional(),
    // Model tiers: { fast: { modelId } , ... }; the key becomes TIER_<KEY>_MODEL.
    tierConfig: z.record(
        z.string().regex(/^[A-Za-z0-9_]{1,32}$/, 'a tier name must be a plain identifier'),
        z.object({ modelId: str(255).optional() }).passthrough(),
    ).nullable().optional(),
});

// Container or compose service names (docker's charset). They are joined into
// an `sh -c` command, so anything else — `;`, `$(`, a space — is refused.
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const UpdateBody = z.object({
    services: z.array(z.string().regex(SERVICE_NAME, 'not a container name')).max(50).optional(),
});

// Container names (what the UI lists) → compose service names.
const CONTAINER_TO_SERVICE = {
    'beeflow-server':       'server',
    'beeflow-agent-hub':    'agent-hub',
    'search-api':           'search-api',
    'search-inference-gpu': 'inference-gpu',
    'beeflow-guard':        'guard-service',
    'whisperx-service':     'whisperx',
    'beeflow-pii':          'pii-service',
};

function resolveUpdateServices(services = []) {
    return services.map((s) => CONTAINER_TO_SERVICE[s] || s).filter(Boolean);
}

/**
 * Turn a validated install body into { secrets, configEnv, profiles }.
 * `generateSecret(bytes)` supplies every secret the body left empty.
 */
function buildInstallConfig(input, generateSecret) {
    const {
        // Network
        serverProtocol = 'http',
        serverHost = 'localhost:3001',
        clientProtocol = 'http',
        clientHost = 'localhost:5176',
        serverPort = '3001',
        clientPort = '5176',
        // AI
        deploymentType = '',
        aiProvider = '',
        azureEndpoint = '',
        azureKey = '',
        azureVersion = '2024-04-01-preview',
        azureModels = '',
        genericKey = '',
        officeAppsEnabled = false,
        // Search
        searchProvider = 'agent-search',
        bingKey = '',
        bingMarket = '',
        serperKey = '',
        // Microsoft SSO
        msClientId = '',
        msClientSecret = '',
        msTenantId = 'common',
        // Services
        enableSearch = true,
        enableSearchGpu = false,
        enableSearchLlm = false,
        enableGuard = true,
        enableGuardGpu = false,
        enableWhisperx = false,
        enablePii = false,
        enableLocalLlm = false,
        // Secrets (auto-generated if empty)
        adminPassword = '',
        dbPassword = '',
        sessionSecret = '',
        masterEncryptionKey = '',
        servicesApiKey = '',
        hfToken = '',
        // Model tiers
        tierConfig = null,
    } = input;

    // ── 1. Generate secrets ──────────────────────────────
    const secrets = {
        DB_PASSWORD:           dbPassword          || generateSecret(16),
        SESSION_SECRET:        sessionSecret       || generateSecret(32),
        MASTER_ENCRYPTION_KEY: masterEncryptionKey || generateSecret(32),
        SERVICES_API_KEY:      servicesApiKey      || generateSecret(32),
        RUSTFS_SECRET_KEY:     generateSecret(16),
        SEARCH_DB_PASSWORD:    generateSecret(16),
    };

    // ── 2. Core config env object ─────────────────────────
    // These are picked up by docker-compose.install.yml
    // via the standard ${VAR} substitution mechanism.
    const configEnv = {
        // Server
        SERVER_PORT:           serverPort,
        SERVER_PROTOCOL:       serverProtocol,
        SERVER_PUBLIC_HOST:    serverHost,
        INTERNAL_SERVER_HOST:  'server',

        // Client
        CLIENT_PORT:           clientPort,
        CLIENT_PROTOCOL:       clientProtocol,
        CLIENT_PUBLIC_HOST:    clientHost,
        VITE_API_URL:          '',

        // Database
        DB_USER:               'beeflow',
        DB_PASSWORD:           secrets.DB_PASSWORD,
        DB_NAME:               'beeflow_core',

        // Object storage (RustFS)
        RUSTFS_ACCESS_KEY:     'beeflow',
        RUSTFS_SECRET_KEY:     secrets.RUSTFS_SECRET_KEY,

        // Secrets
        SESSION_SECRET:        secrets.SESSION_SECRET,
        MASTER_ENCRYPTION_KEY: secrets.MASTER_ENCRYPTION_KEY,
        OPAQUE_SERVER_SETUP:   '',

        // Feature flags
        ENABLE_TASKS:          'true',
        ENABLE_MONITORING:     'true',

        // CORS
        CORS_ORIGIN:           `${clientProtocol}://${clientHost},${serverProtocol}://${serverHost}`,

        // Cookie
        COOKIE_SECURE:   serverProtocol === 'https' ? 'true' : 'false',
        COOKIE_SAMESITE: serverProtocol === 'https' ? 'none' : 'lax',

        // Services
        SERVICES_API_KEY: secrets.SERVICES_API_KEY,

        // Search DB
        SEARCH_DB_USER:     'search',
        SEARCH_DB_PASSWORD: secrets.SEARCH_DB_PASSWORD,
        SEARCH_DB_NAME:     'search_kb',

        // HuggingFace (GPU models)
        HF_TOKEN: hfToken || '',
    };

    // ── 3. Azure OpenAI vars ─────────────────────────────
    if (deploymentType === 'azure') {
        if (azureEndpoint) configEnv.AZURE_OPENAI_ENDPOINT    = azureEndpoint;
        if (azureKey)      configEnv.AZURE_OPENAI_API_KEY     = azureKey;
        configEnv.AZURE_OPENAI_API_VERSION = azureVersion;
        if (azureModels)   configEnv.AZURE_OPENAI_MODELS      = azureModels;
        configEnv.OFFICE_APPS_ENABLED = String(officeAppsEnabled);
    }

    // ── 4. Generic AI provider vars ──────────────────────
    if (aiProvider && aiProvider !== 'azure' && genericKey) {
        configEnv.AI_PROVIDER = aiProvider;
        configEnv[`${aiProvider.toUpperCase()}_API_KEY`] = genericKey;
    }

    // ── 5. Search provider vars ──────────────────────────
    if (bingKey || searchProvider === 'bing') {
        configEnv.SEARCH_PROVIDER = 'bing';
        if (bingMarket) configEnv.BING_SEARCH_MARKET = bingMarket;
    } else if (searchProvider === 'agent-search') {
        configEnv.SEARCH_PROVIDER = 'agent-search';
        if (serperKey) {
            configEnv.SERPER_API_KEY        = serperKey;
            configEnv.SEARCH_SERPER_API_KEY = serperKey;
        }
    }

    // ── 6. Model tier vars ───────────────────────────────
    if (tierConfig) {
        for (const [key, val] of Object.entries(tierConfig)) {
            if (val && val.modelId) {
                configEnv[`TIER_${key.toUpperCase()}_MODEL`] = val.modelId;
            }
        }
    }

    // ── 7. INIT_* vars consumed by boot-init.js ──────────
    // The server reads these on first boot and configures admin
    // account, Microsoft SSO, Azure OpenAI, Bing search, etc.
    // directly via internal DB/store calls (no HTTP, no timing issues).
    if (adminPassword)  configEnv.INIT_ADMIN_PASSWORD   = adminPassword;
    if (msClientId)     configEnv.INIT_MS_CLIENT_ID     = msClientId;
    if (msClientSecret) configEnv.INIT_MS_CLIENT_SECRET = msClientSecret;
    if (msTenantId && msTenantId !== 'common') configEnv.INIT_MS_TENANT_ID = msTenantId;
    if (deploymentType === 'azure') {
        if (azureEndpoint) configEnv.INIT_AZURE_ENDPOINT    = azureEndpoint;
        if (azureKey)      configEnv.INIT_AZURE_API_KEY     = azureKey;
        if (azureVersion)  configEnv.INIT_AZURE_API_VERSION = azureVersion;
        if (azureModels)   configEnv.INIT_AZURE_MODELS      = azureModels;
    }
    if (bingKey) configEnv.INIT_BING_SEARCH_KEY = bingKey;
    // Point the server at the bundled Ollama. ensureLocalProviders reads
    // this on boot and registers the runtime, so its models are selectable
    // under Admin → AI → Chat Models without any further setup.
    if (enableLocalLlm) configEnv.OLLAMA_URL = 'http://ollama:11434';

    // ── 8. Determine profiles ────────────────────────────
    const profiles = ['core'];
    if (enableSearch)                    profiles.push('search');
    if (enableSearch && enableSearchGpu) profiles.push('search-gpu');
    if (enableSearch && enableSearchLlm) profiles.push('search-llm');
    if (enableGuard)                     profiles.push('guard');
    if (enableGuard && enableGuardGpu)   profiles.push('guard-gpu');
    if (enableWhisperx)                  profiles.push('whisperx');
    if (enablePii)                       profiles.push('pii');
    if (enableLocalLlm)                  profiles.push('local-llm');

    return { secrets, configEnv, profiles };
}

module.exports = { InstallBody, UpdateBody, buildInstallConfig, resolveUpdateServices, CONTAINER_TO_SERVICE };
