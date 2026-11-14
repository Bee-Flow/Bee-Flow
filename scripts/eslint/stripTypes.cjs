// An ESLint processor for TypeScript sources that Node runs by stripping the
// types (`.mts` in server/): it hands ESLint the same text Node executes, the
// file with every type replaced by spaces. Lines and columns are unchanged, so
// a message points at the source as written, and no TypeScript parser is
// needed: the package's JavaScript rules apply as they are.
//
// Only erasable syntax survives stripping (no enums, no parameter properties),
// which is what server/scripts/typecheck.mjs already requires of these files
// (`erasableSyntaxOnly`). A file that does not strip is reported as one
// message at its first line instead of crashing the run.
//
// Usage, in a flat config:
//   { files: ['**/*.mts'], processor: stripTypes }
// The stripped text is linted under the name `<file>.mts/0.mjs`, so the
// config blocks that match `**/*.mjs` are the ones that apply to it.

const { stripTypeScriptTypes } = require('node:module');

/** What Node would run for this TypeScript source. */
function strip(text) {
    // Node marks the API experimental and says so once per process on stderr;
    // a lint run is not the place for that line.
    const emit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
        const name = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
        if (name === 'ExperimentalWarning' && String(warning).includes('stripTypeScriptTypes')) return;
        emit.call(process, warning, ...rest);
    };
    try {
        return stripTypeScriptTypes(text);
    } finally {
        process.emitWarning = emit;
    }
}

/** Texts that could not be stripped, by file name, for postprocess to report. */
const failures = new Map();

const stripTypes = {
    meta: { name: 'beeflow-strip-types', version: '1' },
    preprocess(text, filename) {
        try {
            failures.delete(filename);
            return [{ text: strip(text), filename: '0.mjs' }];
        } catch (err) {
            failures.set(filename, err instanceof Error ? err.message : String(err));
            return [{ text: '', filename: '0.mjs' }];
        }
    },
    postprocess(messages, filename) {
        const failure = failures.get(filename);
        if (failure === undefined) return messages.flat();
        failures.delete(filename);
        return [{ ruleId: null, fatal: true, severity: 2, line: 1, column: 1, message: `The types could not be stripped: ${failure.split('\n')[0]}` }];
    },
    supportsAutofix: false,
};

module.exports = { stripTypes, strip };
