import { describe, it, expect } from 'vitest';
import { engineSegments, enginePill, formatK, shortModelName, showsRates, MODEL_NAME_MAX } from './engineLine';
import EN from '../../../i18n/en-defaults';

/**
 * The engine line's wording, pinned as a table: every segment is a
 * measurement from the stream, and the line must never claim more than the
 * stream said. The two claims that matter most are negative ones — a cloud
 * model is never called "on this machine" or "nothing sent outside", and no
 * missing number ever surfaces as "undefined tok/s".
 *
 * `t` here is the real English catalogue with interpolation, so the strings
 * asserted are the ones a user reads.
 */
const t = (key, fallback, params) => {
    let s = typeof EN[key] === 'string' ? EN[key] : fallback;
    for (const [k, v] of Object.entries(params || {})) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    return s;
};

const localEngine = (over = {}) => ({
    modelId: 'qwen3.6-35b-a3b', local: true, providerType: 'llamacpp',
    lastUsage: null, readTokPerSec: null, writeTokPerSec: null, at: 1, ...over,
});
const cloudEngine = (over = {}) => ({
    modelId: 'claude-haiku-4-5', local: false, providerType: 'claude',
    lastUsage: null, readTokPerSec: null, writeTokPerSec: null, at: 1, ...over,
});
const reading = (progress) => ({ phase: 'reading', progress });
const writing = () => ({ phase: 'writing', progress: null });

const noJunk = (segs) => {
    expect(Array.isArray(segs)).toBe(true);
    for (const s of segs) {
        expect(typeof s).toBe('string');
        expect(s.length).toBeGreaterThan(0);
        expect(s).not.toMatch(/NaN|undefined|null|Infinity/);
    }
};

describe('formatK', () => {
    it('prints small counts as they are and larger ones with one decimal and a k', () => {
        expect(formatK(0)).toBe('0');
        expect(formatK(7)).toBe('7');
        expect(formatK(999)).toBe('999');
        expect(formatK(999.6)).toBe('1000');
        expect(formatK(1000)).toBe('1.0k');
        expect(formatK(12_400)).toBe('12.4k');
        expect(formatK(12_449)).toBe('12.4k');
        expect(formatK(28_000)).toBe('28.0k');
        expect(formatK(1_234_567)).toBe('1234.6k');
    });

    it('never prints NaN: anything that is not a positive finite number reads as 0', () => {
        for (const bad of [NaN, undefined, null, -5, Infinity, -Infinity, '12k', {}]) {
            expect(formatK(bad)).toBe('0');
        }
    });
});

describe('shortModelName', () => {
    it('keeps a bare id, strips provider prefixes and paths', () => {
        expect(shortModelName('qwen3.6-35b-a3b')).toBe('qwen3.6-35b-a3b');
        expect(shortModelName('local/qwen/qwen3.6-35b-a3b')).toBe('qwen3.6-35b-a3b');
        expect(shortModelName('scaleway/meta/llama-3.3-70b')).toBe('llama-3.3-70b');
        expect(shortModelName('  gpt-5-mini  ')).toBe('gpt-5-mini');
    });

    it(`cuts at ${MODEL_NAME_MAX} characters with an ellipsis, and gives nothing for nothing`, () => {
        const long = 'meta-llama/Llama-3.3-70B-Instruct-Turbo-FP8';
        const short = shortModelName(long);
        expect(short.length).toBeLessThanOrEqual(MODEL_NAME_MAX);
        expect(short.endsWith('…')).toBe(true);
        expect(short.startsWith('Llama-3.3-70B')).toBe(true);
        // Exactly the cap is not cut.
        expect(shortModelName('Llama-3.3-70B-Instruct')).toBe('Llama-3.3-70B-Instruct');
        expect(shortModelName(null)).toBeNull();
        expect(shortModelName('')).toBeNull();
        expect(shortModelName('///')).toBeNull();
        expect(shortModelName(undefined)).toBeNull();
    });
});

describe('enginePill', () => {
    it('says "On this machine" only when the server said local === true', () => {
        expect(enginePill({ engine: localEngine(), t })).toBe('On this machine');
        expect(enginePill({ engine: cloudEngine(), t })).toBeNull();
        expect(enginePill({ engine: localEngine({ local: null }), t })).toBeNull();
        expect(enginePill({ engine: localEngine({ local: 'true' }), t })).toBeNull();
        expect(enginePill({ engine: null, t })).toBeNull();
        expect(enginePill({ engine: undefined, t })).toBeNull();
    });
});

describe('engineSegments — who and where', () => {
    it('with nothing known: an empty array, never a placeholder', () => {
        expect(engineSegments({ engine: null, turn: null, t })).toEqual([]);
        expect(engineSegments({ engine: undefined, turn: undefined, t })).toEqual([]);
        expect(engineSegments({ engine: {}, turn: {}, t })).toEqual([]);
    });

    it('local model idle: name, then the privacy claim', () => {
        const segs = engineSegments({ engine: localEngine(), turn: null, t });
        expect(segs).toEqual(['qwen3.6-35b-a3b', 'nothing sent outside']);
    });

    it('cloud model: the name only — never "nothing sent outside"', () => {
        expect(engineSegments({ engine: cloudEngine(), turn: null, t })).toEqual(['claude-haiku-4-5']);
        // Unknown locality is treated like cloud: no claim without evidence.
        expect(engineSegments({ engine: cloudEngine({ local: null }), turn: null, t })).toEqual(['claude-haiku-4-5']);
        for (const engine of [cloudEngine(), cloudEngine({ local: null }), cloudEngine({ local: undefined })]) {
            const joined = engineSegments({ engine, turn: writing(), t }).join(' · ');
            expect(joined).not.toContain('nothing sent outside');
            expect(joined).not.toContain('On this machine');
        }
    });
});

describe('engineSegments — while reading', () => {
    it('reading with progress: "reading X of Y tokens" and, with a cache hit, "N remembered"', () => {
        const turn = reading({ total: 28_000, cache: 20_100, processed: 24_400, timeMs: 3000, at: 1 });
        expect(engineSegments({ engine: localEngine(), turn, t })).toEqual([
            'qwen3.6-35b-a3b', 'nothing sent outside', 'reading 24.4k of 28.0k tokens', '20.1k remembered',
        ]);
    });

    it('reading with progress but no cache: no "remembered" segment', () => {
        const turn = reading({ total: 28_000, cache: 0, processed: 1_200, timeMs: 300, at: 1 });
        expect(engineSegments({ engine: localEngine(), turn, t })).toEqual([
            'qwen3.6-35b-a3b', 'nothing sent outside', 'reading 1.2k of 28.0k tokens',
        ]);
    });

    it('while the live reading figure is up, the stale last-round rates stay off the line', () => {
        const engine = localEngine({ readTokPerSec: 1450, writeTokPerSec: 23 });
        const turn = reading({ total: 28_000, cache: 0, processed: 5_000, timeMs: 1, at: 1 });
        const segs = engineSegments({ engine, turn, t });
        expect(segs.join(' · ')).not.toContain('tok/s');
        expect(segs).toContain('reading 5.0k of 28.0k tokens');
        expect(showsRates({ engine, turn })).toBe(false);
    });

    it('reading without progress (cloud, or a runtime that reports none): nothing extra — the clock is enough', () => {
        expect(engineSegments({ engine: cloudEngine(), turn: reading(null), t })).toEqual(['claude-haiku-4-5']);
        // A progress object with no usable total is the same as none.
        expect(engineSegments({ engine: cloudEngine(), turn: reading({ total: 0, cache: 0, processed: 0 }), t })).toEqual(['claude-haiku-4-5']);
        expect(engineSegments({ engine: cloudEngine(), turn: reading({ total: NaN, cache: NaN, processed: NaN }), t })).toEqual(['claude-haiku-4-5']);
    });

    it('progress is only read in the reading phase — a leftover object during writing is ignored', () => {
        const turn = { phase: 'writing', progress: { total: 28_000, cache: 20_000, processed: 28_000 } };
        expect(engineSegments({ engine: localEngine(), turn, t })).toEqual(['qwen3.6-35b-a3b', 'nothing sent outside', 'writing…']);
    });
});

describe('engineSegments — writing and the last-round rates', () => {
    it('writing: "writing…", then the known rates', () => {
        expect(engineSegments({ engine: localEngine(), turn: writing(), t })).toEqual([
            'qwen3.6-35b-a3b', 'nothing sent outside', 'writing…',
        ]);
        expect(engineSegments({ engine: localEngine({ writeTokPerSec: 23 }), turn: writing(), t })).toEqual([
            'qwen3.6-35b-a3b', 'nothing sent outside', 'writing…', 'writes 23 tok/s',
        ]);
        expect(engineSegments({ engine: localEngine({ readTokPerSec: 1450, writeTokPerSec: 23 }), turn: writing(), t })).toEqual([
            'qwen3.6-35b-a3b', 'nothing sent outside', 'writing…', 'reads 1.5k tok/s', 'writes 23 tok/s',
        ]);
    });

    it('after a round, idle: the last-round rates, each only when known', () => {
        const both = localEngine({ readTokPerSec: 1450, writeTokPerSec: 23 });
        expect(engineSegments({ engine: both, turn: { phase: null, progress: null }, t })).toEqual([
            'qwen3.6-35b-a3b', 'nothing sent outside', 'reads 1.5k tok/s', 'writes 23 tok/s',
        ]);
        expect(showsRates({ engine: both, turn: null })).toBe(true);
        const readOnly = cloudEngine({ readTokPerSec: 900 });
        expect(engineSegments({ engine: readOnly, turn: null, t })).toEqual(['claude-haiku-4-5', 'reads 900 tok/s']);
        const writeOnly = cloudEngine({ writeTokPerSec: 61 });
        expect(engineSegments({ engine: writeOnly, turn: null, t })).toEqual(['claude-haiku-4-5', 'writes 61 tok/s']);
        expect(showsRates({ engine: cloudEngine(), turn: null })).toBe(false);
    });

    it('a zero, negative or non-finite rate is "not known", not "0 tok/s"', () => {
        for (const bad of [0, -3, NaN, Infinity, null, undefined, '23']) {
            const segs = engineSegments({ engine: cloudEngine({ readTokPerSec: bad, writeTokPerSec: bad }), turn: writing(), t });
            expect(segs).toEqual(['claude-haiku-4-5', 'writing…']);
        }
    });

    it('clamps a processed count that overshoots the total, and a cache larger than the total', () => {
        const turn = reading({ total: 1000, cache: 5000, processed: 9000 });
        expect(engineSegments({ engine: cloudEngine(), turn, t })).toEqual([
            'claude-haiku-4-5', 'reading 1.0k of 1.0k tokens', '1.0k remembered',
        ]);
    });

    it('takes a caller-supplied formatK', () => {
        const turn = reading({ total: 28_000, cache: 100, processed: 5_000 });
        const segs = engineSegments({ engine: cloudEngine(), turn, t, formatK: (n) => `<${n}>` });
        expect(segs).toEqual(['claude-haiku-4-5', 'reading <5000> of <28000> tokens', '<100> remembered']);
    });
});

describe('engineSegments — hygiene', () => {
    it('never yields an empty string, undefined, NaN or null — across every combination', () => {
        const engines = [null, undefined, {}, localEngine(), cloudEngine(), localEngine({ modelId: null }),
            localEngine({ readTokPerSec: 1450, writeTokPerSec: 23 }), cloudEngine({ readTokPerSec: NaN, writeTokPerSec: 0 })];
        const turns = [null, undefined, {}, reading(null), reading({ total: 28_000, cache: 20_100, processed: 24_400 }),
            reading({ total: 100, cache: 0, processed: 50 }), reading({}), writing(), { phase: null, progress: null },
            { phase: 'reading', progress: { total: 'x', cache: 'y', processed: 'z' } }];
        for (const engine of engines) for (const turn of turns) {
            noJunk(engineSegments({ engine, turn, t }));
            const pill = enginePill({ engine, t });
            expect(pill === null || (typeof pill === 'string' && pill.length > 0)).toBe(true);
        }
    });

    it('routes every sentence through t() — a keyed translator leaves only keys and the model name', () => {
        const keyed = (key) => `⟦${key}⟧`;
        const engine = localEngine({ readTokPerSec: 1450, writeTokPerSec: 23 });
        const idle = engineSegments({ engine, turn: null, t: keyed });
        expect(idle).toEqual(['qwen3.6-35b-a3b', '⟦automations.canvas.engine.offline⟧', '⟦automations.canvas.engine.reads⟧', '⟦automations.canvas.engine.writes⟧']);
        const live = engineSegments({ engine, turn: reading({ total: 10, cache: 4, processed: 6 }), t: keyed });
        expect(live).toEqual(['qwen3.6-35b-a3b', '⟦automations.canvas.engine.offline⟧', '⟦automations.canvas.engine.reading⟧', '⟦automations.canvas.engine.remembered⟧']);
        expect(engineSegments({ engine, turn: writing(), t: keyed })).toContain('⟦automations.canvas.engine.writing⟧');
        expect(enginePill({ engine, t: keyed })).toBe('⟦automations.canvas.engine.local⟧');
    });
});
