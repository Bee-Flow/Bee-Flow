/**
 * Metro config.
 *
 * The only non-default here is `unstable_enablePackageExports`. @noble/hashes
 * and @noble/ciphers — the crypto primitives that stand in for WebCrypto, which
 * React Native does not have — ship ESM-only subpath exports
 * ("./hkdf", "./aes"). Without package-exports resolution Metro cannot see
 * them and the crypto module fails to bundle, which is a build error rather
 * than something you would discover at runtime.
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = true;

module.exports = config;
