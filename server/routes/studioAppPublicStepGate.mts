/**
 * The kind gate of the anonymous step route (POST /api/public-app/:token/actions/:id/step):
 * may a visitor of a public page post a step of this kind to the plain step executor?
 *
 * BASE kinds keep the answers the route has always given: a kind that does not run on the
 * server is a 400, a kind whose policy row says `public: 'refuse'` is a 403, every other
 * server kind goes on to the executor.
 *
 * A REGISTRY kind (componentSpecs/steps/<kind>.js) is closed unless its file opens it: it
 * passes only when its policy says `public: 'step'`. 'refuse' and 'browser' are a 403, and so
 * is 'stream': a streaming kind has its own endpoint and never reaches the plain executor. A
 * kind the catalogue does not know at all is the 400 it always was.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface StepMetaLike { side?: string; policy?: { public?: string } }
type MetaOf = (kind: unknown) => StepMetaLike | null;

const { DATA_MUTATING_STEP_KINDS } = nodeRequire('../appStudio/componentSpecs') as { DATA_MUTATING_STEP_KINDS: readonly string[] };
const registry = nodeRequire('../appStudio/componentSpecs/stepRegistry') as { stepMetaOf: MetaOf };
const { BASE_STEP_META } = nodeRequire('../appStudio/componentSpecs/stepMeta') as { BASE_STEP_META: Record<string, StepMetaLike> };

export interface StepRefusal { status: 400 | 403; error: string }

const NOT_SERVER: StepRefusal = Object.freeze({ status: 400, error: 'This step does not run on the server' });
const NOT_PUBLIC: StepRefusal = Object.freeze({ status: 403, error: 'This step is not available on a public app' });

export interface GateTables {
    /** The kinds the server executes (DATA_MUTATING_STEP_KINDS). */
    serverKinds: readonly string[];
    /** kind → its catalogue row, or null for a kind nobody declared. */
    metaOf: MetaOf;
    /** True for a kind of the frozen base catalogue. */
    isBaseKind: (kind: string) => boolean;
}

const LIVE: GateTables = {
    serverKinds: DATA_MUTATING_STEP_KINDS,
    metaOf: registry.stepMetaOf,
    isBaseKind: (kind) => Object.hasOwn(BASE_STEP_META, kind),
};

/**
 * Why a step of `kind` may not be posted by an anonymous visitor, or null when it may.
 * `tables` is the live catalogue unless a test passes its own.
 */
export function publicStepRefusal(kind: unknown, tables: GateTables = LIVE): StepRefusal | null {
    if (typeof kind !== 'string' || !tables.serverKinds.includes(kind)) return NOT_SERVER;
    const policy = tables.metaOf(kind)?.policy?.public;
    if (tables.isBaseKind(kind)) return policy === 'refuse' ? NOT_PUBLIC : null;
    return policy === 'step' ? null : NOT_PUBLIC;
}
