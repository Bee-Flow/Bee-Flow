/**
 * Metro config.
 *
 * `unstable_enablePackageExports`: @noble/hashes and @noble/ciphers — the
 * crypto primitives that stand in for WebCrypto, which React Native does not
 * have — ship ESM-only subpath exports ("./hkdf", "./aes"). Without
 * package-exports resolution Metro cannot see them and the crypto module fails
 * to bundle, which is a build error rather than something you would discover
 * at runtime.
 *
 * The Lucide resolver: src/shared/ui/icons/registry.generated.ts imports each
 * icon's own module (`lucide-react-native/dist/esm/icons/<name>.js`), because
 * the package barrel re-exports all ~1,670 icons and Metro does not
 * tree-shake. `exports` lists only the barrel, so those paths are resolved to
 * the file here — without this, Metro warns once per icon and then falls back
 * to exactly the same file.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = true;

// The expression engine is vendored verbatim as .mjs (src/shared/expr/vendor,
// byte-identical to agent-hub's). Expo's defaults list `mjs` today; this line
// keeps the bundle working if a default ever drops it.
if (!config.resolver.sourceExts.includes('mjs')) config.resolver.sourceExts.push('mjs');

const LUCIDE_ICON = /^lucide-react-native\/(dist\/esm\/icons\/[a-z0-9-]+\.js)$/;
// require.resolve lands on dist/cjs/lucide-react-native.js; the package root is two up.
const LUCIDE_ROOT = path.resolve(path.dirname(require.resolve('lucide-react-native')), '../..');
const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
    const icon = LUCIDE_ICON.exec(moduleName);
    if (icon) return { type: 'sourceFile', filePath: path.join(LUCIDE_ROOT, icon[1]) };
    return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
