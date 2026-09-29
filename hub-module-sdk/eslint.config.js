// ESLint for hub-module-sdk/: the shared service floor
// (scripts/eslint-service-config.cjs). Run: npm run lint
//
// Two module systems live here: the SDK is ESM ("type": "module"), a module
// under modules/ is CommonJS (esbuild bundles it to entry.cjs). Frontends
// (JSX, Vite) are not linted yet.
import globals from 'globals';
import shared from '../scripts/eslint-service-config.cjs';

const { serviceConfig, correctnessRules } = shared;

export default serviceConfig(globals, {
    js: 'module',
    ignores: ['dist/**', '**/frontend/**', 'modules/*/server/entry.cjs'],
    extra: [{
        files: ['modules/**/*.js'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
        rules: correctnessRules,
    }],
});
