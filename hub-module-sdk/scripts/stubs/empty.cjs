// Empty stub used by build.mjs `bfmod.stub` to replace a dependency that is
// pulled in transitively but never actually reached at runtime (e.g. ssh2 via
// docker-modem, which is only used for ssh:// docker connections — the scanner
// talks to the unix socket). Aliasing the dep to this makes the bundle fully
// self-contained: `require('ssh2')` returns {} and `.Client` is undefined, which
// is safe because it is never invoked. Keeps the module installable on a light
// core that does not ship the dep in its own node_modules.
module.exports = {};
