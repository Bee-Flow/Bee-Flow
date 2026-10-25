import type { Bag } from './resolveBinding.types';

/** Filter ops that carry no value — their entries pass through untouched. */
export const NO_VALUE_FILTER_OPS = new Set(['isNull', 'isNotNull']);

/**
 * Resolve a record/records binding's dynamic filter values against the live
 * scope: entries whose value is { kind:'formula', expr } are evaluated with
 * the shared engine (e.g. `currentUser.id`, `vars.filters.q`); everything
 * else is left alone. Rules (contract shared with the server-side validator):
 *
 *   • isNull / isNotNull entries have no value → pass through untouched;
 *   • an entry whose (resolved) value is undefined or null is OMITTED from
 *     the outgoing filter — '' / 0 / false are legit values and stay;
 *   • a filter left empty by omission is dropped entirely, so its cache key
 *     equals the no-filter key.
 *
 * Fast path: a binding needing no change is returned AS-IS (identity-stable,
 * memo-friendly). Non-record kinds and non-array (legacy object) filters pass
 * through unchanged. Never throws — a bad formula resolves to undefined and
 * the entry is omitted, because a half-configured filter is a normal state.
 *
 * NOTE: formula filters should stick to the stable scope roots (currentUser,
 * vars, forms, screen, today). `now` differs by milliseconds between the
 * fetch layer's scope and the renderer's, which would split their cache keys.
 */
/**
 * The descriptor fields of an AGGREGATE binding that may be authored as a
 * formula and resolved, client-side, before the fetch.
 *
 * This is what makes a report the VIEWER composed renderable. An aggregate
 * binding is a query descriptor — table, group-by, measures, sort, limit — and
 * with every part of it frozen into the app definition, a chart can only ever
 * ask the one question its author wrote. Letting those parts resolve from
 * `vars` means a saved report row can BE the question: pick a dimension and a
 * measure in the running app and the same chart answers it.
 *
 * This widens no trust boundary. POST /:id/data/query has always accepted an
 * inline descriptor straight from the client, and it re-derives everything that
 * matters server-side: the table must exist in the model, rlsGateway.canRead
 * must pass for the VIEWER's role, the viewer's access filter is ANDed into the
 * WHERE, and compileAggregate rejects a field that is not a real column, an
 * alias that is not an identifier, and any aggregate function outside its own
 * list. A descriptor assembled from a row in the app's own database is strictly
 * less exotic than what that endpoint already handles.
 *
 * Resolution happens BEFORE dataCacheKey is computed (see AppDataScope), so two
 * tiles asking different questions get different cache keys and refetch when
 * the viewer changes the question — the same way a dynamic filter value does.
 */
// `tableId` stays LITERAL on purpose: it is what anchors the validator's
// field-reference checks and the server's table-access gate to something an
// author declared. The QUESTION is dynamic; the table it is asked of is not.
export const AGGREGATE_SHAPE_FIELDS: Array<'groupBy' | 'aggregates' | 'sort' | 'limit'> = ['groupBy', 'aggregates', 'sort', 'limit'];

export const EMPTY: Bag = Object.freeze({ actionState: {}, dataState: {}, scope: undefined });
