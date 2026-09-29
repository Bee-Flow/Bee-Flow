// The real googleapis typings are ~60 MB of .d.ts (compute/alpha.d.ts alone is
// 10 MB). Loading them put the server typecheck at the 2 GB heap limit of a CI
// runner for a handful of call sites, so the typecheck maps the package here
// (server/jsconfig.json "paths"). The runtime is untouched: this file is types
// only, for tsc.
export const google: any;
export type Auth = any;
declare const _default: { google: any };
export default _default;
