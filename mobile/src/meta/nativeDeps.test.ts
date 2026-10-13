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

    /**
     * Source text with comments removed. A guard that searched the raw text let
     * `expo-blur` through for months: nothing imported it, but a comment in
     * theme/tokens.ts mentioned the name, and a substring match is satisfied by
     * a comment. Only code (an import, a require, a plugin string) counts.
     * `//` after a `:` is left alone so URLs inside strings survive.
     */
    function stripComments(text: string): string {
        return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    }

    /**
     * Is the package named as a real module specifier: `from 'name'`, a bare
     * `import 'name'`, `import('name')`, `require('name')`, `jest.mock('name')`
     * or `jest.requireActual('name')`, optionally with a subpath ('name/sub')?
     * A string that merely equals the name (a label, a map key) does not count.
     */
    function isImported(source: string, name: string): boolean {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(
            `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*|\\bjest\\s*\\.\\s*(?:mock|requireActual|requireMock|doMock)\\s*\\(\\s*)['"\`]${escaped}(?:/[^'"\`]*)?['"\`]`,
        ).test(source);
    }

    /** The text of app.config's top-level `plugins: [ ... ]`, brackets balanced, nested entries included. */
    function pluginsBlock(config: string): string {
        const open = /\bplugins\s*:\s*\[/.exec(config);
        if (!open) return '';
        const start = open.index + open[0].length;
        let depth = 1;
        for (let i = start; i < config.length; i++) {
            if (config[i] === '[') depth++;
            else if (config[i] === ']' && --depth === 0) return config.slice(start, i);
        }
        return config.slice(start);
    }

    /** Is the package named in app.config's `plugins` list, bare or as ['name', {...}]? */
    function isConfigPlugin(config: string, name: string): boolean {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`['"\`]${escaped}(?:/[^'"\`]*)?['"\`]`).test(pluginsBlock(config));
    }

    function read(full: string): string {
        return fs.existsSync(full) ? stripComments(fs.readFileSync(full, 'utf8')) : '';
    }

    /** Shipping code (tests excluded) and the build configs that import. */
    function allSource(): string {
        const parts: string[] = [];
        const walk = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                // Tests (and their mocks) do not ship in the APK: a package only a test
                // names is still dead weight in the build.
                else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name))
                    parts.push(read(full));
            }
        };
        sourceRoots.forEach(walk);
        for (const name of ['app.config.ts', 'metro.config.js', 'babel.config.js']) parts.push(read(path.join(MOBILE, name)));
        return parts.join('\n');
    }

    const appConfig = () => read(path.join(MOBILE, 'app.config.ts'));

    /**
     * Native packages that are legitimately never imported by name or listed in
     * app.config's plugins. Keep this to the ones the test would flag without
     * them: an entry that is already imported or a plugin only hides a future
     * unused dependency.
     *
     * Both are declared dependencies of expo-router itself: the router imports
     * them, this app does not, and removing them breaks navigation.
     */
    const NOT_IMPORTED_BY_NAME = new Set(['expo-linking', 'react-native-screens']);

    it('the guard sees code, not comments (expo-blur regression)', () => {
        const source = stripComments("// uses 'expo-blur' here\n/* import 'expo-blur' */\nimport x from 'expo-image';");
        expect(isImported(source, 'expo-blur')).toBe(false);
        expect(isImported(source, 'expo-image')).toBe(true);
        expect(isImported("require(\"expo-image/build/x\")", 'expo-image')).toBe(true);
    });

    it('a string that is not a specifier does not count as an import', () => {
        const source = "const label = 'expo-blur';\nconst map = { 'expo-blur': 1 };\nimport a from 'expo-blur-extra';";
        expect(isImported(source, 'expo-blur')).toBe(false);
        expect(isImported("jest.mock('expo-blur', () => ({}))", 'expo-blur')).toBe(true);
        expect(isImported("await import('expo-blur')", 'expo-blur')).toBe(true);
        expect(isImported("import 'expo-blur';", 'expo-blur')).toBe(true);
    });

    it('finds a config plugin in the plugins list, bare or nested, and nowhere else', () => {
        const config = "name: 'expo-x',\nplugins: [\n 'expo-a',\n ['expo-b', { k: 1 }],\n],\nother: ['expo-c']";
        expect(isConfigPlugin(config, 'expo-a')).toBe(true);
        expect(isConfigPlugin(config, 'expo-b')).toBe(true);
        expect(isConfigPlugin(config, 'expo-c')).toBe(false);
        expect(isConfigPlugin(config, 'expo-x')).toBe(false);
    });

    it('imports every dependency that ships native code', () => {
        const source = allSource();
        const config = appConfig();
        const unused = Object.keys(pkg.dependencies ?? {})
            .filter((name) => !NOT_IMPORTED_BY_NAME.has(name))
            .filter(shipsNativeCode)
            .filter((name) => !isImported(source, name) && !isConfigPlugin(config, name));
        // A native dependency nothing imports still gets compiled into the APK.
        // If one is genuinely needed without being imported, add it to
        // NOT_IMPORTED_BY_NAME with a reason rather than deleting this test.
        expect(unused).toEqual([]);
    });
});
