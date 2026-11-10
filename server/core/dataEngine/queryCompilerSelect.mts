/**
 * The select list of a record read: which columns a list or a get-by-id
 * returns.
 *
 * Today that is every column of the one table (`*`): there is no projection
 * and no read-time expression. It lives in its own module so a later change to
 * what a read returns is made here once, for compileRecordList and
 * compileGetById together, instead of in each compiler.
 */

/** The select list of compileRecordList and compileGetById. */
export function recordSelectList(): string {
    return '*';
}
