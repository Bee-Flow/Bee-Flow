// ESLint for nc-login-mini/: the shared service floor
// (scripts/eslint-service-config.cjs). Run: npm run lint
const globals = require('globals');
const { serviceConfig } = require('../scripts/eslint-service-config.cjs');

module.exports = serviceConfig(globals);
