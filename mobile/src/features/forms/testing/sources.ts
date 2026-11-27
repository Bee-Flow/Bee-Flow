/**
 * Test-only: the originals the forms port is pinned to — the server's form
 * contract (plain CommonJS, loaded as-is: jest.config.js keeps server/ out of
 * Babel) and the web's forms modules (ES modules, through Babel), for the
 * lockstep tests beside the ports. Nothing in the app imports this file.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../../..');

export const serverPath = (rel: string): string => path.join(REPO, 'server', rel);
export const webPath = (rel: string): string => path.join(REPO, 'agent-hub/src', rel);

export const readServer = (rel: string): string => fs.readFileSync(serverPath(rel), 'utf8');
export const readWeb = (rel: string): string => fs.readFileSync(webPath(rel), 'utf8');

/**
 * server/index.js followed by every first-party composition file (`firstParty/<id>.js` of
 * server/ and of each modules/<id>/server/, joined by name, in name order): the twin of
 * server/testUtils/compositionText.js. A needle that looks for a mount or a registration
 * (`"app.use('/api/datatables'"`) reads this, so it is still found after the line moves out
 * of index.js into a module's composition file. Today that text is index.js alone.
 */
export function compositionText(): string {
    const roots = [path.join(REPO, 'server')];
    const modulesDir = path.join(REPO, 'modules');
    if (fs.existsSync(modulesDir)) {
        for (const id of fs.readdirSync(modulesDir).sort()) roots.push(path.join(modulesDir, id, 'server'));
    }
    const files = new Map<string, string>();
    for (const root of roots) {
        const dir = path.join(root, 'firstParty');
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (!/\.(?:c?js|mts)$/.test(name) || /\.(?:test|testkit)\./.test(name) || files.has(name)) continue;
            files.set(name, path.join(dir, name));
        }
    }
    const ordered = [...files.keys()].sort().map((name) => files.get(name) as string);
    return [serverPath('index.js'), ...ordered].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

export function requireServer<T>(rel: string): T {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(serverPath(rel)) as T;
}

export function requireWeb<T>(rel: string): T {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(webPath(rel)) as T;
}

/** A top-level `const NAME = <value>;` out of a source file, as its literal text. */
export function constText(src: string, name: string): string {
    const m = new RegExp(`\\bconst ${name}(?:: [^=]+)? = ([^;]+);`).exec(src);
    if (!m) throw new Error(`const ${name} is gone`);
    return (m[1] as string).trim();
}

/** An `export function NAME(…) { … }` (or a plain one) cut out of a source file, ready for `new Function`. */
export function functionText(src: string, name: string): string {
    const start = src.search(new RegExp(`(export )?function ${name}\\(`));
    if (start < 0) throw new Error(`function ${name} is gone`);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 2).replace(/^export /, '');
}
