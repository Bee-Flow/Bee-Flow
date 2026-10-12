/**
 * Curated catalogue of vendor-hosted (remote) MCP servers an ORGANISATION
 * admin may install from Settings → Organisation → MCP library.
 *
 * Why this list lives on the server, not in the SPA: the default org policy
 * ("official servers only", see ./policy.js) trusts an endpoint because it is
 * in THIS list. If the browser could say "this one is from the catalogue",
 * anyone could. So an install names a catalogue id, and the URL, the auth
 * scheme and the credential fields come from here.
 *
 * Every entry is a remote Streamable-HTTP endpoint run by the vendor itself.
 * Nothing here is ever spawned on the Bee Flow host: org admins never get to
 * run a process (that stays a server-admin action, core/mcpManager.js).
 *
 * Only servers that work with a key or without any authentication are
 * listed. Vendors whose hosted server is OAuth-only (Notion, Atlassian,
 * Sentry, ...) need a per-user OAuth flow this library does not have yet;
 * listing them would offer an install that cannot connect.
 *
 * Entry shape:
 *   id           stable id, ^[a-z0-9_]{2,40}$ (also the logo/i18n key)
 *   name         product name
 *   description  one sentence, what agents can do with it
 *   category     one of CATEGORIES
 *   url          the endpoint (https, public host)
 *   auth         { style: 'none' }
 *              | { style: 'bearer' | 'header', header?, credential: { key, label, help, helpUrl? } }
 *   homepage     vendor site (for the "Docs" link and the logo)
 *   docsUrl      the vendor's MCP documentation
 *   repository   GitHub repo (the SPA uses its owner avatar as the logo)
 *   selfHosted   true = `url` is a template; the admin enters their own
 *                instance URL. Such an entry is NOT an official endpoint, so
 *                it installs only when the policy allows custom URLs.
 *   safetyNote   optional least-privilege advice shown at install time
 */

const CATEGORIES = Object.freeze(['development', 'data', 'docs', 'payments', 'automation', 'observability']);

const REMOTE_CATALOG = Object.freeze([
    {
        id: 'github',
        name: 'GitHub',
        description: 'Repositories, issues, pull requests, code search and Actions on github.com.',
        category: 'development',
        url: 'https://api.githubcopilot.com/mcp/',
        auth: {
            style: 'bearer',
            credential: {
                key: 'token',
                label: 'Personal access token',
                help: 'A fine-grained personal access token, limited to the repositories agents may use.',
                helpUrl: 'https://github.com/settings/personal-access-tokens/new',
            },
        },
        homepage: 'https://github.com',
        docsUrl: 'https://github.com/github/github-mcp-server',
        repository: 'https://github.com/github/github-mcp-server',
        safetyNote: 'Give the token read-only repository access unless agents must open issues or pull requests.',
    },
    {
        id: 'linear',
        name: 'Linear',
        description: 'Find, create and update Linear issues, projects and comments.',
        category: 'development',
        url: 'https://mcp.linear.app/mcp',
        auth: {
            style: 'bearer',
            credential: {
                key: 'api_key',
                label: 'Linear API key',
                help: 'Create a personal API key under Settings → Security & access in Linear.',
                helpUrl: 'https://linear.app/settings/account/security',
            },
        },
        homepage: 'https://linear.app',
        docsUrl: 'https://linear.app/docs/mcp',
        repository: 'https://github.com/linear',
    },
    {
        id: 'supabase',
        name: 'Supabase',
        description: 'Explore Supabase projects, tables and logs, and run SQL against them.',
        category: 'data',
        url: 'https://mcp.supabase.com/mcp',
        auth: {
            style: 'bearer',
            credential: {
                key: 'access_token',
                label: 'Personal access token',
                help: 'Create one under Account → Access tokens in the Supabase dashboard.',
                helpUrl: 'https://supabase.com/dashboard/account/tokens',
            },
        },
        homepage: 'https://supabase.com',
        docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
        repository: 'https://github.com/supabase-community/supabase-mcp',
        safetyNote: 'Connect a development project, not production: the server can run SQL.',
    },
    {
        id: 'stripe',
        name: 'Stripe',
        description: 'Look up customers, payments, invoices and subscriptions in Stripe.',
        category: 'payments',
        url: 'https://mcp.stripe.com',
        auth: {
            style: 'bearer',
            credential: {
                key: 'secret_key',
                label: 'Restricted API key',
                help: 'Use a restricted key (rk_…) with only the permissions agents need, never your full secret key.',
                helpUrl: 'https://dashboard.stripe.com/apikeys',
            },
        },
        homepage: 'https://stripe.com',
        docsUrl: 'https://docs.stripe.com/mcp',
        repository: 'https://github.com/stripe/agent-toolkit',
        safetyNote: 'A restricted key with read permissions keeps agents from moving money.',
    },
    {
        id: 'huggingface',
        name: 'Hugging Face',
        description: 'Search models, datasets, Spaces and papers on the Hugging Face Hub.',
        category: 'data',
        url: 'https://huggingface.co/mcp',
        auth: {
            style: 'bearer',
            credential: {
                key: 'token',
                label: 'Access token',
                help: 'A read-only access token is enough.',
                helpUrl: 'https://huggingface.co/settings/tokens',
            },
        },
        homepage: 'https://huggingface.co',
        docsUrl: 'https://huggingface.co/settings/mcp',
        repository: 'https://github.com/huggingface',
    },
    {
        id: 'apify',
        name: 'Apify',
        description: 'Run Apify Actors to scrape websites and collect structured web data.',
        category: 'automation',
        url: 'https://mcp.apify.com',
        auth: {
            style: 'bearer',
            credential: {
                key: 'token',
                label: 'Apify API token',
                help: 'Find it under Settings → API & Integrations in Apify Console.',
                helpUrl: 'https://console.apify.com/settings/integrations',
            },
        },
        homepage: 'https://apify.com',
        docsUrl: 'https://docs.apify.com/platform/integrations/mcp',
        repository: 'https://github.com/apify/apify-mcp-server',
        safetyNote: 'Actor runs are billed to the Apify account that owns the token.',
    },
    {
        id: 'context7',
        name: 'Context7',
        description: 'Up-to-date library and framework documentation for coding questions.',
        category: 'docs',
        url: 'https://mcp.context7.com/mcp',
        auth: { style: 'none' },
        homepage: 'https://context7.com',
        docsUrl: 'https://github.com/upstash/context7',
        repository: 'https://github.com/upstash/context7',
    },
    {
        id: 'deepwiki',
        name: 'DeepWiki',
        description: 'Ask questions about public GitHub repositories and read their generated docs.',
        category: 'docs',
        url: 'https://mcp.deepwiki.com/mcp',
        auth: { style: 'none' },
        homepage: 'https://deepwiki.com',
        docsUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
        repository: 'https://github.com/CognitionAI',
    },
    {
        id: 'microsoft_learn',
        name: 'Microsoft Learn',
        description: 'Search and read official Microsoft and Azure documentation.',
        category: 'docs',
        url: 'https://learn.microsoft.com/api/mcp',
        auth: { style: 'none' },
        homepage: 'https://learn.microsoft.com',
        docsUrl: 'https://learn.microsoft.com/training/support/mcp',
        repository: 'https://github.com/MicrosoftDocs/mcp',
    },
    {
        id: 'cloudflare_docs',
        name: 'Cloudflare Docs',
        description: 'Search the Cloudflare developer documentation.',
        category: 'docs',
        url: 'https://docs.mcp.cloudflare.com/mcp',
        auth: { style: 'none' },
        homepage: 'https://developers.cloudflare.com',
        docsUrl: 'https://github.com/cloudflare/mcp-server-cloudflare',
        repository: 'https://github.com/cloudflare/mcp-server-cloudflare',
    },
    {
        id: 'aws_knowledge',
        name: 'AWS Knowledge',
        description: 'AWS documentation, API references and architecture guidance.',
        category: 'docs',
        url: 'https://knowledge-mcp.global.api.aws',
        auth: { style: 'none' },
        homepage: 'https://aws.amazon.com',
        docsUrl: 'https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server',
        repository: 'https://github.com/awslabs/mcp',
    },
    {
        id: 'openobserve',
        name: 'OpenObserve',
        description: 'Query logs, metrics and traces, and manage dashboards and alerts.',
        category: 'observability',
        url: 'https://openobserve.example.com/api/default/mcp',
        selfHosted: true,
        auth: {
            style: 'header',
            header: 'Authorization',
            credential: {
                key: 'authorization',
                label: 'Authorization header value',
                help: 'For example "Basic <base64 of user:password>" for a service account.',
            },
        },
        homepage: 'https://openobserve.ai',
        docsUrl: 'https://openobserve.ai/docs',
        repository: 'https://github.com/openobserve/openobserve',
    },
]);

const BY_ID = new Map(REMOTE_CATALOG.map(e => [e.id, e]));

function getCatalogEntry(id) {
    return (typeof id === 'string' && BY_ID.get(id)) || null;
}

/** Hosts of the OFFICIAL (non-self-hosted) endpoints, lower-cased. */
function officialHosts() {
    const hosts = new Set();
    for (const e of REMOTE_CATALOG) {
        if (e.selfHosted) continue;
        try { hosts.add(new URL(e.url).hostname.toLowerCase()); } catch (_) { /* a broken entry is simply not official */ }
    }
    return hosts;
}

/**
 * The catalogue as the SPA may see it: everything except nothing secret
 * (there is nothing secret in it), with the endpoint shown only for the
 * official entries so the admin can see where data goes before installing.
 */
function publicCatalog() {
    return REMOTE_CATALOG.map(e => ({
        id: e.id,
        name: e.name,
        description: e.description,
        category: e.category,
        url: e.url,
        selfHosted: !!e.selfHosted,
        host: (() => { try { return new URL(e.url).hostname; } catch (_) { return null; } })(),
        authStyle: e.auth.style,
        credential: e.auth.credential
            ? { key: e.auth.credential.key, label: e.auth.credential.label, help: e.auth.credential.help || null, helpUrl: e.auth.credential.helpUrl || null }
            : null,
        homepage: e.homepage || null,
        docsUrl: e.docsUrl || null,
        repository: e.repository || null,
        safetyNote: e.safetyNote || null,
    }));
}

module.exports = { REMOTE_CATALOG, CATEGORIES, getCatalogEntry, officialHosts, publicCatalog };
