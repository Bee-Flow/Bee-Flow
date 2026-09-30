/** The two API roots the Compliance Center talks to (server/index.js mounts). */

export const COMPLIANCE = '/api/compliance';
export const DSR = '/api/dsr';

/** One path segment, encoded. */
export const seg = (id: unknown): string => encodeURIComponent(String(id ?? ''));

export const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
