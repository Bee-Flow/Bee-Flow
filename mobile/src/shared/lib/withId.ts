/**
 * Drop the rows a list reader defaulted to `id: ''`.
 *
 * shapeListOf (core/api/contract) keeps an object row that lacks its id, with
 * the id defaulted, so the caller decides whether such a row is renderable.
 * For a list screen it never is: a row without an id has no screen to open
 * and no key to render under.
 */
export function withId<T extends { id: string }>(rows: T[]): T[] {
    return rows.filter((row) => row.id !== '');
}
