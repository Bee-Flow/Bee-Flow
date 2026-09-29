const test = require('node:test');
const assert = require('node:assert');

const { InstallBody, UpdateBody, buildInstallConfig, resolveUpdateServices } = require('./installPlan');

// Deterministic secrets: the byte count is visible in the value.
const fakeSecret = (bytes) => `gen${bytes}`;

test('an empty body installs core, search and guard over http with generated secrets', () => {
    const { secrets, configEnv, profiles } = buildInstallConfig(InstallBody.parse({}), fakeSecret);
    assert.deepEqual(profiles, ['core', 'search', 'guard']);
    assert.equal(secrets.DB_PASSWORD, 'gen16');
    assert.equal(secrets.SESSION_SECRET, 'gen32');
    assert.equal(configEnv.DB_PASSWORD, secrets.DB_PASSWORD);
    assert.equal(configEnv.CORS_ORIGIN, 'http://localhost:5176,http://localhost:3001');
    assert.equal(configEnv.COOKIE_SECURE, 'false');
    assert.equal(configEnv.COOKIE_SAMESITE, 'lax');
    assert.equal(configEnv.SEARCH_PROVIDER, 'agent-search');
    assert.equal(configEnv.INIT_ADMIN_PASSWORD, undefined);
});

test('https makes the session cookie secure and cross-site', () => {
    const { configEnv } = buildInstallConfig(InstallBody.parse({
        serverProtocol: 'https', serverHost: 'api.example.test',
        clientProtocol: 'https', clientHost: 'app.example.test',
    }), fakeSecret);
    assert.equal(configEnv.COOKIE_SECURE, 'true');
    assert.equal(configEnv.COOKIE_SAMESITE, 'none');
    assert.equal(configEnv.CORS_ORIGIN, 'https://app.example.test,https://api.example.test');
});

test('secrets the operator supplied are kept; the rest are generated', () => {
    const { secrets } = buildInstallConfig(InstallBody.parse({ dbPassword: 'chosen' }), fakeSecret);
    assert.equal(secrets.DB_PASSWORD, 'chosen');
    assert.equal(secrets.MASTER_ENCRYPTION_KEY, 'gen32');
});

test('GPU and LLM add-ons follow their parent service', () => {
    const on = { enableSearchGpu: true, enableSearchLlm: true, enableGuardGpu: true };
    assert.deepEqual(
        buildInstallConfig(InstallBody.parse({ ...on, enableSearch: false, enableGuard: false }), fakeSecret).profiles,
        ['core'],
    );
    const { profiles, configEnv } = buildInstallConfig(InstallBody.parse({
        ...on, enableWhisperx: true, enablePii: true, enableLocalLlm: true,
    }), fakeSecret);
    assert.deepEqual(profiles, ['core', 'search', 'search-gpu', 'search-llm', 'guard', 'guard-gpu', 'whisperx', 'pii', 'local-llm']);
    assert.equal(configEnv.OLLAMA_URL, 'http://ollama:11434');
});

test('Azure, a generic provider, Bing and model tiers become their env vars', () => {
    const { configEnv } = buildInstallConfig(InstallBody.parse({
        deploymentType: 'azure', azureEndpoint: 'https://x.openai.azure.com', azureKey: 'k',
        aiProvider: 'mistral', genericKey: 'mk',
        bingKey: 'bk', bingMarket: 'nl-NL',
        msTenantId: 'tenant-1',
        tierConfig: { fast: { modelId: 'small' }, pro: { modelId: '' } },
    }), fakeSecret);
    assert.equal(configEnv.AZURE_OPENAI_ENDPOINT, 'https://x.openai.azure.com');
    assert.equal(configEnv.INIT_AZURE_API_KEY, 'k');
    assert.equal(configEnv.OFFICE_APPS_ENABLED, 'false');
    assert.equal(configEnv.MISTRAL_API_KEY, 'mk');
    assert.equal(configEnv.SEARCH_PROVIDER, 'bing');
    assert.equal(configEnv.BING_SEARCH_MARKET, 'nl-NL');
    assert.equal(configEnv.INIT_MS_TENANT_ID, 'tenant-1');
    assert.equal(configEnv.TIER_FAST_MODEL, 'small');
    assert.equal(configEnv.TIER_PRO_MODEL, undefined, 'an empty tier sets nothing');
});

test('the install body refuses values that would name an env var or break a type', () => {
    assert.equal(InstallBody.safeParse({ aiProvider: 'X; rm -rf /' }).success, false);
    assert.equal(InstallBody.safeParse({ tierConfig: { 'a b': { modelId: 'm' } } }).success, false);
    assert.equal(InstallBody.safeParse({ enableSearch: 'yes' }).success, false);
    assert.equal(InstallBody.safeParse({ serverProtocol: 'ftp' }).success, false);
    assert.equal(InstallBody.parse({ serverPort: 3001 }).serverPort, '3001');
});

test('update service names: container names map to compose services, shell syntax is refused', () => {
    assert.deepEqual(
        resolveUpdateServices(UpdateBody.parse({ services: ['beeflow-server', 'search-inference-gpu', 'beeflow-redis'] }).services),
        ['server', 'inference-gpu', 'beeflow-redis'],
    );
    assert.deepEqual(resolveUpdateServices(UpdateBody.parse({}).services), []);
    for (const bad of ['server; rm -rf /', '$(id)', 'a b', '-rf', '']) {
        assert.equal(UpdateBody.safeParse({ services: [bad] }).success, false, `accepted ${JSON.stringify(bad)}`);
    }
});
