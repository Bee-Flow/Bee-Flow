// The app's global stylesheets, read as text for the source-scan tests.
//
// Issue 245 split the old src/index.css in three: index.css keeps the base
// tokens (default dark :root and the light theme), themes.css holds the
// product-only token sets (bubble, PII, chart, --type-*, --kind-*) and the six
// alternate themes, and app.css holds the app's rules (keyframes included). A
// test that asks "is this token declared?" must read all three; a test that
// pins ORDER inside one block should read the one file the block lives in with
// readStylesheet().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const APP_STYLESHEETS = ['index.css', 'themes.css', 'app.css'] as const;

export type AppStylesheet = (typeof APP_STYLESHEETS)[number];

/** One stylesheet under src/, as text. */
export function readStylesheet(name: AppStylesheet): string {
    return fs.readFileSync(path.join(SRC, name), 'utf8');
}

/** index.css, themes.css and app.css joined, in that (load) order. */
export function readAppCss(): string {
    return APP_STYLESHEETS.map(readStylesheet).join('\n');
}
