// Read the author's own code back and report the contract it implies.
//
// Deliberately a reader and not a parser: it matches the source as WRITTEN,
// so a name inside a comment or a string counts, and code that renames
// `main`'s parameters (`async function main(data, c)`) is invisible to it.
// That is the honest trade for a panel that costs nothing, answers while the
// server's analysis is still on its way, and cannot be out of date.
//
// `computedInputs` is the one thing a reader must not hide: `inputs[key]`
// with a variable key means the list of names is incomplete, and a panel
// that quietly showed a short list would be worse than one that says so.

const INPUT_DOT = /\binputs\s*\.\s*([A-Za-z_$][\w$]*)/g;
const INPUT_BRACKET = /\binputs\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
const INPUT_DESTRUCTURE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*inputs\b/g;
const INPUT_COMPUTED = /\binputs\s*\[\s*(?!['"])/;
const TOOL_DOT = /\bctx\s*\.\s*integrations\s*\.\s*([A-Za-z_$][\w$]*)/g;
const TOOL_BRACKET = /\bctx\s*\.\s*integrations\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
const USES_HTTP = /\bctx\s*\.\s*http\s*\(/;
const USES_SECRETS = /\bctx\s*\.\s*secrets\s*\(/;
const USES_LOG = /\bctx\s*\.\s*log\s*\(/;

export interface CodeContract {
    inputNames: string[];
    computedInputs: boolean;
    toolNames: string[];
    usesHttp: boolean;
    usesSecrets: boolean;
    usesLog: boolean;
}

function destructured(src: string, names: Set<string>): boolean {
    let rest = false;
    for (const m of src.matchAll(INPUT_DESTRUCTURE)) {
        for (const part of m[1].split(',')) {
            const name = part.split(':')[0].split('=')[0].trim();
            if (!name) continue;
            // `const { a, ...rest } = inputs` reads everything: the named ones are a floor.
            if (name.startsWith('...')) { rest = true; continue; }
            if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
    }
    return rest;
}

export function readCodeContract(code: unknown = ''): CodeContract {
    const src = typeof code === 'string' ? code : '';
    const inputNames = new Set<string>();
    for (const m of src.matchAll(INPUT_DOT)) inputNames.add(m[1]);
    for (const m of src.matchAll(INPUT_BRACKET)) inputNames.add(m[1]);
    const restDestructure = destructured(src, inputNames);
    const toolNames = new Set<string>();
    for (const m of src.matchAll(TOOL_DOT)) toolNames.add(m[1]);
    for (const m of src.matchAll(TOOL_BRACKET)) toolNames.add(m[1]);
    return {
        inputNames: [...inputNames].sort(),
        computedInputs: INPUT_COMPUTED.test(src) || restDestructure,
        toolNames: [...toolNames].sort(),
        usesHttp: USES_HTTP.test(src),
        usesSecrets: USES_SECRETS.test(src),
        usesLog: USES_LOG.test(src),
    };
}
