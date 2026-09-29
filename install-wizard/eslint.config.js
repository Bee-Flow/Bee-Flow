// ESLint for install-wizard/: the shared service floor
// (scripts/eslint-service-config.cjs). Run: npm run lint
const globals = require('globals');
const { serviceConfig } = require('../scripts/eslint-service-config.cjs');

module.exports = serviceConfig(globals, {
    extra: [{
        // The wizard UI: a classic browser script whose functions are called
        // from inline onclick/onchange handlers in the markup it renders, so
        // a top-level function is a global, not an unused binding.
        files: ['public/**/*.js'],
        languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
        rules: {
            'no-unused-vars': ['warn', { vars: 'local', argsIgnorePattern: '^_', caughtErrors: 'none' }],
        },
    }],
});
