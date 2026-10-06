/**
 * Tests live NEXT to the source they cover (`x.ts` ↔ `x.test.ts`), matching the
 * convention the rest of this monorepo uses — no central __tests__ tree.
 *
 * jest-expo's preset supplies the React Native module mocks; transformIgnore-
 * Patterns has to let the RN/Expo packages through Babel because they ship
 * untranspiled ESM.
 */
/* global __dirname */
const jestExpoPreset = require('jest-expo/jest-preset');
const path = require('path');

// A few contract tests require server modules directly (../server/...). Those
// are plain CommonJS and must NOT go through Babel: babel-preset-expo injects
// `@babel/runtime` helper imports, which resolve from the SERVER directory —
// and the server's node_modules are not installed in the mobile CI job, so
// the suite died on "Cannot find module '@babel/runtime/helpers/…'". Listing
// the server tree here makes Jest load it as-is. One exception: the shared
// expression engine (server/shared/expr/*.mjs) is ESM, and server modules such
// as fieldDiff.js require it, so it goes through Babel like the vendored copy;
// its helper imports resolve through the @babel/runtime mapper below.
const SERVER_DIR = path.resolve(__dirname, '..', 'server').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(?!shared/expr/)';

// `.mjs` goes through the same Babel as `.ts`/`.js`: the expression engine is
// vendored verbatim as .mjs (src/shared/expr/vendor), and the preset's
// transform only matches `[jt]sx?`.
//
// Differential lockstep tests require agent-hub modules and run them beside
// their mobile port (ARCHITECTURE.md, "Sharing logic with the web app"). Those
// are ES modules, so they DO go through Babel, with the preset's own options;
// the `@babel/runtime` helpers that injects are then resolved from this
// package (`modulePaths` and the mapper below), since agent-hub's
// node_modules are not installed here. `@shared/*` is agent-hub's Vite alias
// for its src/shared.
const PRESET_BABEL = jestExpoPreset.transform['\\.[jt]sx?$'];

module.exports = {
    preset: 'jest-expo',
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    transform: { '\\.mjs$': PRESET_BABEL },
    // `@/*` mirrors the path in tsconfig.json; Metro reads tsconfig itself.
    // The Lucide line: the icon registry imports each icon's own ESM module,
    // a path the package's `exports` does not list (metro.config.js explains
    // why); tests load the CommonJS twin of the same file.
    // The last three serve the differential lockstep tests, which require a
    // web module from ../agent-hub and run it beside its port: Babel gives
    // that file `@babel/runtime` helper imports, and the web's dagre layout
    // imports `@dagrejs/dagre` — neither resolves from agent-hub/, which has
    // no node_modules in the mobile job, so both resolve to this package's.
    // `@shared/*` is the web's Vite alias for agent-hub/src/shared.
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^lucide-react-native/dist/esm/icons/(.*)$': '<rootDir>/node_modules/lucide-react-native/dist/cjs/icons/$1',
        '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
        '^@dagrejs/dagre$': '<rootDir>/node_modules/@dagrejs/dagre',
        '^@shared/(.*)$': '<rootDir>/../agent-hub/src/shared/$1',
    },
    modulePaths: ['<rootDir>/node_modules'],
    testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
    collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}'],
    // `standard-navigation` is expo-router's navigation core; it ships ESM, so
    // without it here no test can import a component that calls useRouter.
    // `marked` ships ESM only, and the Markdown renderer (shared/markdown) lexes
    // with it: any test that reaches it (a feature index does) loads it.
    transformIgnorePatterns: [
        SERVER_DIR,
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|marked|@noble/.*|standard-navigation))',
    ],
};
