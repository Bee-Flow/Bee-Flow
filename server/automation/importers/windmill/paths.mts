/**
 * File names inside an uploaded Windmill export. A name is relative,
 * slash-separated and stays inside the export: an absolute path, a drive
 * letter, a NUL byte or a `..` segment is refused, never "cleaned up" into
 * something that might point elsewhere. Nothing is ever written to disk, so
 * the refusal is about what the converter reads, not where it would write.
 */

export class PathRefused extends Error {
    constructor(name: string) {
        super(`The export contains a file name that leaves the export: ${JSON.stringify(name.slice(0, 120))}.`);
        this.name = 'PathRefused';
    }
}

/** The normalised relative path, or throws PathRefused. Directory entries end without a slash. */
export function normalisePath(raw: string): string {
    if (raw.includes('\0')) throw new PathRefused(raw);
    const name = raw.split('\\').join('/');
    if (name.startsWith('/') || (name.length > 1 && name[1] === ':')) throw new PathRefused(raw);
    const out: string[] = [];
    for (const seg of name.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') throw new PathRefused(raw);
        out.push(seg);
    }
    return out.join('/');
}

/** `ref` resolved against the folder `dir`, refused when it climbs out of the export. */
export function resolveRelative(dir: string, ref: string): string {
    return normalisePath(dir ? `${dir}/${ref}` : ref);
}

/** The folder of a path ('' for a top-level file). */
export function dirname(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash);
}

/** A shared first folder every file sits under (a zip of the export folder), or ''. */
export function commonRoot(paths: string[]): string {
    if (paths.length === 0) return '';
    const first = paths[0].split('/')[0];
    if (!first || paths.some((p) => !p.startsWith(`${first}/`))) return '';
    if (first === 'f' || first === 'u' || first === 'g') return '';
    return first;
}
