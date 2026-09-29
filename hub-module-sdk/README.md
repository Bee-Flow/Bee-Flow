# hub-module-sdk

Build, pack and sign **Bee Flow Hub modules** — signed `.bfmod` packages that a
Bee Flow install downloads, verifies and loads at runtime (server code + a
pre-built frontend, one trust root).

A `.bfmod` is a ZIP:

```
manifest.json      module descriptor (see MANIFEST.schema.json)
integrity.json     { algo:"sha256", files:{ "<relpath>": "<hex>" } }
signature.jws      compact RS256 JWS binding module id+version+integrity hash
server/entry.cjs   built CommonJS server entry -> exports createModule(host)
frontend/index.js  built ESM frontend entry (react family externalised) [optional]
frontend/index.css injected when the module UI mounts                    [optional]
assets/…           anything else the module ships                        [optional]
```

`integrity.json` hashes **every packaged file except `signature.jws` and
`integrity.json` itself**. `signature.jws`'s payload carries the sha256 of the
`integrity.json` bytes, so the single signature transitively vouches for every
file. The product verifier is `server/modules/packageVerify.js` — the pack/sign
logic here is pinned to it (a round-trip test in the product enforces it).

## manifestVersion 2 (Module Hub 3.1)

mv2 is additive over mv1 and unlocks the **permission manifest**:

- `permissions: []` — the host-API grants your module needs (`db`, `ai`,
  `usage:write`, `limits:read`, `storage:read`, `webpages:write`, `email:send`,
  `license:read`, `config`, `http:<host>` / `http:*.domain` / `http:*`,
  `env:docker`, `env:files`). Empty/absent = core-only surface (express,
  middleware, log, dataDir, isModuleActive, net). The operator sees this list
  verbatim in a consent dialog at install/update; your module receives ONLY
  the granted sub-objects on `host`. A non-empty list requires
  `hostApiVersion: 3`.
- `config` is **namespaced** for mv2: keys go through a `module_<id>_` prefix
  (mv1's instance-wide `stores.configStore` is not exposed to mv2 modules).
- mv2 capability ids must be module-own: `<id>` or `<id>_…`; `kind: "core"` is
  forbidden.
- `server.native`, `server.restart: "auto"|"never"|"always"`,
  `server.schemaVersion`, `server.streamingRoutes[]` — see MANIFEST.schema.json.
  Packages with native addons (or `restart:"always"`) are STAGED on update and
  activate at the next product restart.
- `createModule(host)` must return the FLAT contract:
  `{ router, initDBs?, tick?, tickIntervalMs?, dispose? }` (see `template/`).
- Sign with `--license-class free` to make a module freely sideloadable on
  air-gapped installs (absent ⇒ paid: sideload requires an offline `.bfgrant`).

mv1 packages keep working unchanged (full legacy host surface).

## Install

```bash
cd hub-module-sdk
npm install          # esbuild + jszip
```

`vite` is **not** an SDK dependency — the frontend is built by shelling out to
`npx vite build` in your module's `frontend/` dir. Add `vite` +
`@vitejs/plugin-react` as devDependencies of your module (or build inside a
workspace that already provides them, e.g. the monorepo).

## Author a module

Copy `template/` and edit:

- `module.manifest.json` — id (`^[a-z][a-z0-9_]{2,40}$`), version (semver),
  `hostApiVersion`, capabilities, `server.entry`, optional `frontend`.
- `server/src/index.js` — `export function createModule(host)` returning
  `{ stores, router, workers, dispose }`. Everything you need is injected via
  `host` (hostApiVersion:1 surface — see `template/test/hostMock.js`). Do **not**
  `require()` product internals.
- `frontend/src/App.jsx` — default-export the Studio component. `react`,
  `react-dom`, `react-dom/client`, `react/jsx-runtime` are externalised by
  `vite.config.js`; the host provides the one React instance. NO purple.

## Build → pack → sign

```bash
# 1. compile: module.manifest.json -> manifest.json, esbuild server,
#    vite lib-build frontend
node scripts/build.mjs ../path/to/my-module

# 2. compute integrity.json + zip -> <id>-<version>.bfmod
node scripts/pack.mjs ../path/to/my-module

# 3. sign with your RSA private key (RSA-2048, PKCS8 private / SPKI public,
#    e.g. openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/private.pem)
node scripts/sign.mjs ../path/to/my-module/example_module-1.0.0.bfmod ./keys/private.pem
```

`sign.mjs` prints the `kid` (`sha256(SPKI public PEM).slice(0,16)`) and the
package sha256. The install verifies the signature against the package trust
root resolved by that `kid` (bundled key / `MODULES_PUBLIC_KEY` / JWKS).

## Contracts (pinned — do not drift)

**Package signature JWS** payload:

```json
{
  "iss": "license.beeflow.nl/modules",
  "module_id": "<manifest.id>",
  "version": "<manifest.version>",
  "integrity_sha256": "<hex sha256 of integrity.json bytes>",
  "iat": 0,
  "min_app_version": "<manifest.minAppVersion>",
  "host_api_version": 1
}
```

Header `{ alg:"RS256", typ:"JWT", kid }`, signed RSA-SHA256 / PKCS#1 v1.5.

**hostApiVersion** is the hard compatibility gate: the loader refuses a module
whose `hostApiVersion` it does not implement. Bump it only when the injected
`host` surface changes shape.
