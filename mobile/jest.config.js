/**
 * Tests live NEXT to the source they cover (`x.ts` ↔ `x.test.ts`), matching the
 * convention the rest of this monorepo uses — no central __tests__ tree.
 *
 * jest-expo's preset supplies the React Native module mocks; transformIgnore-
 * Patterns has to let the RN/Expo packages through Babel because they ship
 * untranspiled ESM.
 */
/* global __dirname */
const path = require('path');

// A few contract tests require server modules directly (../server/...). Those
// are plain CommonJS and must NOT go through Babel: babel-preset-expo injects
// `@babel/runtime` helper imports, which resolve from the SERVER directory —
// and the server's node_modules are not installed in the mobile CI job, so
// the suite died on "Cannot find module '@babel/runtime/helpers/…'". Listing
// the server tree here makes Jest load it as-is.
const SERVER_DIR = path.resolve(__dirname, '..', 'server').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
    preset: 'jest-expo',
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
    collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}'],
    transformIgnorePatterns: [
        SERVER_DIR,
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-marked|@noble/.*))',
    ],
};
