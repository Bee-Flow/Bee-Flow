/**
 * Every package with native code must be one Expo SDK 57 has tested.
 *
 * This test exists because of a specific, expensive failure. `react-native-opaque`
 * sat in dependencies unused: nothing imported it, and it was left behind after
 * being evaluated and rejected. Autolinking does not care what the JavaScript
 * imports — a package with an `android/` directory gets compiled — so Gradle
 * dutifully tried to build its 2023-era JSI adapter against React Native 0.86
 * and died in C++:
 *
 *     react-native-opaque/android/cpp-adapter.cpp
 *     jsi.h: no viable conversion from 'String' to 'Value'
 *
 * The APK could not be built at all, and the cause was invisible from the
 * TypeScript: no import, no type error, no lint warning. Only a full Android
 * build finds it, and a full Android build is the single most expensive check
 * this project has — twenty minutes of CI, and impossible to run locally in
 * environments (including the one this was written in) where dl.google.com is
 * unreachable and the SDK cannot be fetched.
 *
 * So the risk is characterised statically instead. A package is dangerous when
 * BOTH are true:
 *   - it ships native sources that get compiled into the app, and
 *   - its version is not governed by Expo's own SDK compatibility contract.
 *
 * That contract is `expo/bundledNativeModules.json`, the version map Expo tests
 * against the React Native release this SDK pins. Anything inside it is
 * version-matched by construction. Anything outside it, shipping C++, is the
 * exact profile of the package that broke the build.
 */

import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

const MOBILE = path.resolve(__dirname, '../..');
const NODE_MODULES = path.join(MOBILE, 'node_modules');

interface PackageJson {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    version?: string;
}

const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'package.json'), 'utf8')) as PackageJson;
const bundled = JSON.parse(
    fs.readFileSync(path.join(NODE_MODULES, 'expo/bundledNativeModules.json'), 'utf8'),
) as Record<string, string>;

const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

function installedVersion(name: string): string | null {
    try {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(NODE_MODULES, name, 'package.json'), 'utf8'),
        ) as PackageJson;
        return manifest.version ?? null;
    } catch {
        return null;
    }
}

/** Does this package compile native sources into the app? */
function shipsNativeCode(name: string): boolean {
    const androidDir = path.join(NODE_MODULES, name, 'android');
    if (!fs.existsSync(androidDir)) return false;
    // A build.gradle is what makes autolinking compile it at all.
    return (
        fs.existsSync(path.join(androidDir, 'build.gradle')) ||
        fs.existsSync(path.join(androidDir, 'build.gradle.kts'))
    );
}

/**
 * The narrower, sharper signal: C++ that must compile against React Native's
 * own headers. Kotlin against a stable Android API rarely breaks across an RN
 * bump; a JSI adapter routinely does, because jsi.h is not a stable ABI.
 */
function shipsCpp(name: string): boolean {
    const root = path.join(NODE_MODULES, name);
    const search = (dir: string, depth: number): boolean => {
        if (depth > 3 || !fs.existsSync(dir)) return false;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'build' || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (search(full, depth + 1)) return true;
            } else if (/\.(cpp|cc|mm)$/.test(entry.name) || entry.name === 'CMakeLists.txt') {
                return true;
            }
        }
        return false;
    };
    return search(path.join(root, 'android'), 0) || search(path.join(root, 'cpp'), 0);
}

/**
 * Packages allowed to ship native code without being in the SDK contract.
 *
 * `beeflow-argon2` is this repository's own local Expo module (mobile/modules/),
 * not an npm dependency, so it never appears here — it is listed for the reader,
 * not for the filter. Adding a real entry to this set means accepting that an
 * Expo SDK upgrade can break the APK with a C++ error, and should be argued for
 * in a commit message, not done quietly.
 */
const ALLOWED_UNGOVERNED = new Set<string>([]);

describe('native dependencies are governed by the Expo SDK contract', () => {
    it('read the SDK version map', () => {
        // If this file ever moves, every assertion below would pass vacuously.
        expect(Object.keys(bundled).length).toBeGreaterThan(50);
        expect(Object.keys(declared).length).toBeGreaterThan(10);
    });

    it('has no ungoverned package shipping C++ — the react-native-opaque failure mode', () => {
        const offenders = Object.keys(declared)
            .filter((name) => !bundled[name])
            .filter((name) => !ALLOWED_UNGOVERNED.has(name))
            .filter(shipsCpp);
        expect(offenders).toEqual([]);
    });

    it('installs every SDK-governed package at a version the SDK allows', () => {
        const drifted: string[] = [];
        for (const name of Object.keys(declared)) {
            const want = bundled[name];
            if (!want) continue;
            const installed = installedVersion(name);
            if (!installed) continue;
            // `satisfies`, not string equality: the SDK map uses ranges (~, ^)
            // and a patch inside the range is exactly what it permits.
            if (!semver.satisfies(installed, want, { includePrerelease: true })) {
                drifted.push(`${name}: SDK allows ${want}, installed ${installed}`);
            }
        }
        expect(drifted).toEqual([]);
    });

    it('declares every SDK-governed package at the range the SDK specifies', () => {
        // Catches a package.json edit that widens a range past what Expo tested,
        // which `npm install` would then happily resolve beyond.
        const widened: string[] = [];
        for (const [name, spec] of Object.entries(declared)) {
            const want = bundled[name];
            if (!want) continue;
            const wantRange = semver.validRange(want);
            const haveRange = semver.validRange(spec);
            if (!wantRange || !haveRange) continue;
            if (!semver.subset(haveRange, wantRange, { includePrerelease: true })) {
                widened.push(`${name}: declared ${spec}, SDK specifies ${want}`);
            }
        }
        expect(widened).toEqual([]);
    });
});

describe('dependencies that are installed but unused', () => {
    /**
     * The other half of the react-native-opaque story: it was not merely at a
     * bad version, it was not used at all. An unused dependency with native code
     * is pure liability — it cannot break at runtime because nothing calls it,
     * so the only way it can hurt you is by breaking the build.
     */
    const sourceRoots = [path.join(MOBILE, 'src'), path.join(MOBILE, 'app'), path.join(MOBILE, 'modules')];

    function allSource(): string {
        const parts: string[] = [];
        const walk = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) parts.push(fs.readFileSync(full, 'utf8'));
            }
        };
        sourceRoots.forEach(walk);
        for (const name of ['app.config.ts', 'metro.config.js', 'babel.config.js', 'jest.setup.js']) {
            const full = path.join(MOBILE, name);
            if (fs.existsSync(full)) parts.push(fs.readFileSync(full, 'utf8'));
        }
        return parts.join('\n');
    }

    /**
     * Packages that are legitimately never imported by name: config plugins
     * referenced from app.config.ts as strings, transitive peers React Native
     * requires, and tooling.
     */
    const NOT_IMPORTED_BY_NAME = new Set([
        'expo',
        'react',
        'react-dom',
        'react-native',
        'expo-router',
        'expo-build-properties',
        'expo-system-ui',
        'expo-splash-screen',
        'react-native-worklets',
        'react-native-screens',
        'react-native-safe-area-context',
        'expo-status-bar',
        'expo-font',
        'expo-share-intent',
        'expo-notifications',
        'expo-task-manager',
        'expo-dev-client',
        'expo-updates',
        // Declared dependencies of expo-router itself — the router imports
        // them, this app does not, and removing them breaks navigation.
        'expo-linking',
        'react-native-reanimated',
    ]);

    it('imports every dependency that ships native code', () => {
        const source = allSource();
        const unused = Object.keys(pkg.dependencies ?? {})
            .filter((name) => !NOT_IMPORTED_BY_NAME.has(name))
            .filter(shipsNativeCode)
            .filter((name) => !source.includes(name));
        // A native dependency nothing imports still gets compiled into the APK.
        // If one is genuinely needed without being imported, add it to
        // NOT_IMPORTED_BY_NAME with a reason rather than deleting this test.
        expect(unused).toEqual([]);
    });
});
