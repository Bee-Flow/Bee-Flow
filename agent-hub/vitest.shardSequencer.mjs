/**
 * CI shards run with `vitest --shard i/n`, but the files of shard i come from an
 * explicit list (VITEST_FILE_LIST, written by scripts/frontend-shards.mjs and
 * balanced by recorded duration) instead of vitest's hash split.
 *
 * Why keep --shard at all: a blob from a sharded run is merged as one part of a
 * whole. A blob from a plain run with a narrowed `include` counts every
 * untested source file again, so four merged blobs quadrupled the denominator
 * and the merged line coverage fell from ~65% to 35%.
 *
 * Only the selection changes; every spec vitest found is still a candidate, and
 * scripts/frontend-shards.mjs --check proves the lists cover each file once.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BaseSequencer } from 'vitest/node'

export default class ShardListSequencer extends BaseSequencer {
    async shard(files) {
        const listPath = process.env.VITEST_FILE_LIST
        if (!listPath) return super.shard(files)
        const wanted = new Set(JSON.parse(readFileSync(path.resolve(listPath), 'utf8')))
        const root = this.ctx.config.root
        return files.filter((spec) => wanted.has(path.relative(root, spec.moduleId).split(path.sep).join('/')))
    }
}
