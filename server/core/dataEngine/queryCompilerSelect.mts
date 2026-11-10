/**
 * The select list of a record read: which columns a list or a get-by-id
 * returns.
 *
 * Every column of the one table (`*`) unless the read names its columns
 * (`fields`, queryCompilerRelation.resolveFields): then those columns, each
 * once, in the order given. It lives in its own module so a change to what a
 * read returns is made here once, for compileRecordList and compileGetById
 * together, instead of in each compiler.
 */

/**
 * The select list of compileRecordList and compileGetById.
 * @param columns  quoted column names, or nothing for every column
 */
export function recordSelectList(columns?: readonly string[] | null): string {
    if (!columns || columns.length === 0) return '*';
    return columns.filter((c, i) => columns.indexOf(c) === i).join(', ');
}
