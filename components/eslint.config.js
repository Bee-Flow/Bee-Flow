// ESLint for components/: the shared service floor
// (scripts/eslint-service-config.cjs, built on the server's hard-error rules
// in scripts/eslint/base.cjs). Run: npm run lint, or from the root
// node scripts/eslint-budget.mjs components.
//
// The console stays allowed: a component's stdout IS its output (one JSON
// object the server parses), so console.log is the protocol, not logging.
// Every component is CommonJS and runs as `node index.js < inputs.json`.
const globals = require('globals');
const { serviceConfig } = require('../scripts/eslint-service-config.cjs');

module.exports = serviceConfig(globals, { js: 'commonjs' });
