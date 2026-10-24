// ESLint flat config for server/ — a correctness floor, not a style guide.
//
// Scope: only rules that catch real defects (undefined variables, duplicate
// keys, unreachable code, NaN comparisons, ...). Deliberately NO stylistic or
// formatting rules, so this config can exist without reformatting ~1200 files.
//
// Severity policy: every rule here is an error. Prefix an intentionally
// unused argument or binding with `_`; a destructuring that exists to drop
// keys (`const { secret, ...rest } = row`) is fine as it is.
//
// Run: npm run lint    (or: npx eslint .)

const globals = require('globals');
const { hardErrorRules } = require('../scripts/eslint/base.cjs');

const correctnessRules = {
    // Hard errors shared with the small services (scripts/eslint/base.cjs) —
    // the tree is clean under these; keep it that way. An undefined
    // identifier is a ReferenceError waiting for its branch (four shipped on
    // live routes before this was an error).
    ...hardErrorRules,
    // Server code logs through telemetry/log.js (request id, JSON in production).
    // The console stays where stdout IS the output: CLI scripts, migrations,
    // the runner and MCP child processes, and tests.
    'no-console': 'error',
    // A 5xx never echoes err.message: throw, or next(err), and let
    // core/http/terminalErrorHandler.js answer with a correlation id.
    // The selector matches err.message ANYWHERE under the `error` value (a
    // descendant, not a child), so a concatenation ('failed: ' + e.message),
    // a template literal or a fallback (e.message || 'x') is caught too; the
    // child-only selectors missed `'PDF generation failed: ' + err.message`.
    'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.property.name='json'][callee.object.callee.property.name='status'][callee.object.arguments.0.value>=500] > ObjectExpression > Property[key.name='error'] MemberExpression[property.name='message']",
        message: 'A 5xx must not echo err.message; throw or next(err) instead (core/http/terminalErrorHandler.js).',
    }],
    'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
        caughtErrors: 'none',
    }],
};

module.exports = [
    {
        ignores: [
            'node_modules/**',
            // Generated bundle (see the build:editor-md script) — never lint it.
            'core/markdown/editorSerialization.cjs',
            // The App Studio runtime bundle that `agent-hub npm run build:runtime`
            // stages for app_screenshot (gitignored). Linting it locally added ~280
            // errors that CI, which never has the file, does not see.
            'vendor/app-runtime/**',
        ],
    },
    {
        files: ['**/*.js', '**/*.cjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: correctnessRules,
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: correctnessRules,
    },
    {
        files: [
            'scripts/**',
            'migrations/**',
            'migrateDb.js',
            'pwt-runner/**',
            'terminal-runner/**',
            'mcpServers/**',
            'testUtils/**',
            '**/*.test.js',
            '**/*.cli.js',
            'telemetry/log.js',
        ],
        rules: { 'no-console': 'off' },
    },
    {
        // A route fetches URLs it was handed or that an admin configured: a bare
        // fetch() has no SSRF layer (private ranges, cloud metadata, DNS
        // rebinding, redirect hops). Use utils/ssrfGuard.safeFetch (user URLs),
        // core/http/configuredEndpointFetch.fetchConfiguredEndpoint (admin-set
        // provider URLs, private networks allowed) or, for a FIXED trusted host,
        // allow-list the file in the override below with a comment saying why.
        files: ['routes/**/*.js'],
        ignores: ['**/*.test.js'],
        rules: {
            'no-restricted-globals': ['error', {
                name: 'fetch',
                message: 'Bare fetch() in a route has no SSRF guard: use utils/ssrfGuard.safeFetch or core/http/configuredEndpointFetch (see eslint.config.js).',
            }],
        },
    },
    {
        // Fixed, hard-coded trusted hosts (or an operator-set internal service
        // URL from the environment): no user-controlled URL reaches these.
        files: [
            'routes/integrations/github.js',          // api.github.com
            'routes/integrations/githubSync.js',      // api.github.com (owner/repo are validated path segments)
            'routes/integrations/googleWorkspace.js', // Google OAuth token/userinfo endpoints (constants)
            'routes/integrations/linkedin.js',        // linkedin.com / api.linkedin.com
            'routes/integrations/microsoft365.js',    // login.microsoftonline.com / graph.microsoft.com
            'routes/integrations/withings.js',        // Withings OAuth token endpoint (constant)
            'routes/publicGithubStats.js',            // api.github.com
            'routes/search.js',                       // google.serper.dev
            'routes/templates.js',                    // SEARCH_SERVICE_URL, the operator's own search service (env)
            'routes/knowledgeBases/search.js',        // SEARCH_SERVICE_URL (env)
            'routes/projects/collab.testkit.js',      // test helper against a local test server
        ],
        rules: { 'no-restricted-globals': 'off' },
    },
    {
        // Functions these files hand to page.evaluate() / waitForFunction()
        // run inside the headless browser, where window and document exist.
        files: [
            'services/appStudioRender.js',
            'services/browserAgentDriver.js',
            'services/webpageRender.js',
            'routes/notebookExport.js',
            'cms/mcp/screenshot.js',
        ],
        languageOptions: {
            globals: { window: 'readonly', document: 'readonly' },
        },
    },
    {
        // Vite configs are authored as ES modules even in CommonJS packages
        // (Vite transpiles them at load time).
        files: ['**/vite.config.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: correctnessRules,
    },
];
