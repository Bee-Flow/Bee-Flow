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
 * The same flag resolves lucide-react-native/icons/<name>: since 1.0 the
 * package exports each icon as its own subpath, which is how
 * src/shared/ui/icons/registry.generated.ts imports them without bundling the
 * barrel (Metro does not tree-shake; the barrel holds ~1,700 icons).
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = true;

// The expression engine is vendored verbatim as .mjs (src/shared/expr/vendor,
// byte-identical to agent-hub's). Expo's defaults list `mjs` today; this line
// keeps the bundle working if a default ever drops it.
if (!config.resolver.sourceExts.includes('mjs')) config.resolver.sourceExts.push('mjs');

module.exports = config;
