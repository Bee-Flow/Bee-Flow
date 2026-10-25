/// <reference path="./shims/untyped-modules.d.ts" />
// Ambient declarations for the JSDoc type check (scripts/typecheck.mjs).
// Types only: nothing here exists at runtime.

// The server clamps numeric options with `parseInt(limit, 10)` where `limit`
// may arrive as a number (a JS default) or a string (a query parameter).
// parseInt converts its argument with ToString first, so a number is a valid
// input at runtime; lib.es5 only declares the string overload.
declare function parseInt(string: string | number, radix?: number): number;

// Errors across the server carry a machine-readable `code` (and HTTP
// `status`) set after construction: `const e = new Error(msg); e.code = 'X';`.
// `statusCode` and `expose` are the http-errors fields Express's final
// handler reads. Declaring them here keeps that convention checkable without
// a cast at each throw site. All optional: a plain Error has none of them.
interface Error {
    code?: string;
    status?: number;
    statusCode?: number;
    expose?: boolean;
}

// App Studio's headless render (services/appStudioRender.js) passes callbacks
// to Playwright's page.evaluate / waitForFunction. They are serialised and run
// in the browser page, where `window` carries the preview bundle's mount flags.
// Declared here only so those callbacks type-check; the server has no window.
declare const window: { __bfMounted?: boolean; __bfMountError?: string };
// Files that opt in to the DOM lib (`/// <reference lib="dom" />`) get the real
// `window`; this merges the same flags into its `Window` interface.
interface Window { __bfMounted?: boolean; __bfMountError?: string }

// auth/opaqueRoutes.js caches the OPAQUE server setup on the global object.
declare var _opaqueServerSetup: string | undefined;
