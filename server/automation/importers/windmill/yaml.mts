/**
 * The one place the Windmill importer parses YAML (`flow.yaml`,
 * `*.schedule.yaml`, `*_trigger.yaml`, `*.resource.yaml`).
 *
 * eemeli/yaml v2 with the core schema (plain JSON types, no `!!js/*` or
 * `!!binary` constructors) and an alias cap: a document that expands one
 * anchor more than MAX_ALIAS_COUNT times is refused before it inflates (the
 * "billion laughs" shape). The only tag known beyond the core schema is
 * `!inline`, which the Windmill CLI may write for an inline script reference;
 * it resolves to the same `'!inline <file>'` string the quoted form gives, so
 * both spellings reach bundle.mts identically. Warnings (an unknown tag) are
 * collected, never printed.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const YAML = nodeRequire('yaml') as {
    parseDocument: (src: string, opts: Record<string, unknown>) => {
        errors: Array<{ message: string }>;
        warnings: Array<{ message: string }>;
        toJS: (opts: Record<string, unknown>) => unknown;
    };
};

export const MAX_ALIAS_COUNT = 100;

const INLINE_TAG = { tag: '!inline', resolve: (value: string) => `!inline ${value}` };

export class YamlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'YamlError';
    }
}

/** Parse one YAML document to plain data. Throws YamlError on a syntax error or an alias bomb. */
export function parseYaml(src: string): unknown {
    const doc = YAML.parseDocument(src, {
        schema: 'core',
        customTags: [INLINE_TAG],
        uniqueKeys: true,
        prettyErrors: false,
        logLevel: 'silent',
    });
    if (doc.errors.length > 0) throw new YamlError(firstLine(doc.errors[0].message));
    try {
        return doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
    } catch (e) {
        throw new YamlError(firstLine(e instanceof Error ? e.message : String(e)));
    }
}

function firstLine(message: string): string {
    const nl = message.indexOf('\n');
    return nl === -1 ? message : message.slice(0, nl);
}
