/**
 * Browser-state schema pass — the contract:
 *   - an old (pre-scoping) value SURVIVES the move into the user scope, and
 *     the bare key is GONE afterwards;
 *   - an unknown/corrupt shape yields the default and never a crash;
 *   - both passes are idempotent, and once-per-version for the heavy work;
 *   - build-stamped cache keys change with the build sha, while
 *     deploy-spanning keys (locale choice, consent, theme bootstrap) are
 *     never touched.
 *
 * Run: cd agent-hub && npx vitest run src/utils/storageMigrations.test.js
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APP_BUILD_SHA } from './appVersion';
import {
    STORAGE_SCHEMA_VERSION,
    DEVICE_SCHEMA_KEY,
    I18N_CACHE_PREFIX,
    I18N_LOCALES_CACHE_KEY,
    ICONPACK_CACHE_PREFIX,
    buildStampedCacheKey,
    sweepStaleBuildCaches,
    readDeviceJSON,
    runStorageMigrations,
    runUserStorageMigrations,
} from './storageMigrations';

const dump = () => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        out[k] = localStorage.getItem(k);
    }
    return out;
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('buildStampedCacheKey', () => {
    it('changes with the build sha — a deploy makes the cache cold by construction', () => {
        expect(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl', 'aaaaaaa'))
            .not.toBe(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl', 'bbbbbbb'));
    });

    it('embeds the current build sha by default', () => {
        expect(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl')).toBe(`beeflow_i18n_nl_${APP_BUILD_SHA}`);
    });
});

describe('sweepStaleBuildCaches', () => {
    it('removes other builds\' stamped caches and the old unstamped form, keeps the current build\'s', () => {
        localStorage.setItem(`${I18N_CACHE_PREFIX}nl`, '{"data":{}}'); // pre-U8 unstamped
        localStorage.setItem(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl', 'oldsha1'), '{"data":{}}');
        localStorage.setItem(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl', 'newsha2'), '{"data":{}}');
        localStorage.setItem(`${ICONPACK_CACHE_PREFIX}pack-1`, '{"data":{}}');
        localStorage.setItem(buildStampedCacheKey(ICONPACK_CACHE_PREFIX, 'pack-1', 'newsha2'), '{"data":{}}');

        sweepStaleBuildCaches('newsha2');

        expect(localStorage.getItem(`${I18N_CACHE_PREFIX}nl`)).toBeNull();
        expect(localStorage.getItem(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl', 'oldsha1'))).toBeNull();
        expect(localStorage.getItem(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl', 'newsha2'))).not.toBeNull();
        expect(localStorage.getItem(`${ICONPACK_CACHE_PREFIX}pack-1`)).toBeNull();
        expect(localStorage.getItem(buildStampedCacheKey(ICONPACK_CACHE_PREFIX, 'pack-1', 'newsha2'))).not.toBeNull();
    });

    it('never touches the available-locales gate — it has its own TTL and is not per-build', () => {
        localStorage.setItem(I18N_LOCALES_CACHE_KEY, '{"codes":["en","nl"],"at":1}');
        sweepStaleBuildCaches('newsha2');
        expect(localStorage.getItem(I18N_LOCALES_CACHE_KEY)).toBe('{"codes":["en","nl"],"at":1}');
    });

    it('is inert for the pinned headless runtime sha — it must not sweep the host app\'s caches', () => {
        localStorage.setItem(`${I18N_CACHE_PREFIX}nl_realsha`, '{"data":{}}');
        sweepStaleBuildCaches('headless');
        sweepStaleBuildCaches('');
        expect(localStorage.getItem(`${I18N_CACHE_PREFIX}nl_realsha`)).not.toBeNull();
    });
});

describe('runStorageMigrations (device pass)', () => {
    it('prunes dead device keys — corrupt values included — and stamps the schema version', () => {
        localStorage.setItem('modelAliases', '{not even json');
        localStorage.setItem('hiddenModels', '{"gpt-4o":true}');
        localStorage.setItem('reasoningEffort', 'max');

        runStorageMigrations();

        expect(localStorage.getItem('modelAliases')).toBeNull();
        expect(localStorage.getItem('hiddenModels')).toBeNull();
        expect(localStorage.getItem('reasoningEffort')).toBeNull();
        expect(localStorage.getItem(DEVICE_SCHEMA_KEY)).toBe(String(STORAGE_SCHEMA_VERSION));
    });

    it('does NOT prune keys the live UI still writes — sidebar collapse state waits for the user pass', () => {
        // Regression guard: Sidebar reads/writes all three sidebar_*_expanded
        // keys, so the device pass must leave the bare forms for the per-user
        // move instead of wiping a stored "collapsed".
        localStorage.setItem('sidebar_agents_expanded', '0');
        runStorageMigrations();
        expect(localStorage.getItem('sidebar_agents_expanded')).toBe('0');
    });

    it('sweeps stale build caches on every run, using the current build sha', () => {
        localStorage.setItem(`${I18N_CACHE_PREFIX}nl`, '{"data":{}}');
        localStorage.setItem(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl'), '{"data":{}}');
        runStorageMigrations();
        expect(localStorage.getItem(`${I18N_CACHE_PREFIX}nl`)).toBeNull();
        expect(localStorage.getItem(buildStampedCacheKey(I18N_CACHE_PREFIX, 'nl'))).not.toBeNull();
    });

    it('is idempotent — a second run changes nothing', () => {
        localStorage.setItem('modelAliases', '{}');
        localStorage.setItem('beeflow_locale', 'nl');
        runStorageMigrations();
        const after = dump();
        runStorageMigrations();
        expect(dump()).toEqual(after);
    });

    it('treats a corrupt version marker as unversioned and re-runs the ladder instead of crashing', () => {
        localStorage.setItem(DEVICE_SCHEMA_KEY, 'banana');
        localStorage.setItem('modelAliases', '{}');
        expect(() => runStorageMigrations()).not.toThrow();
        expect(localStorage.getItem('modelAliases')).toBeNull();
        expect(localStorage.getItem(DEVICE_SCHEMA_KEY)).toBe(String(STORAGE_SCHEMA_VERSION));
    });

    it('normalises a marker from a NEWER build (rollback) without crashing', () => {
        localStorage.setItem(DEVICE_SCHEMA_KEY, '999');
        expect(() => runStorageMigrations()).not.toThrow();
        expect(localStorage.getItem(DEVICE_SCHEMA_KEY)).toBe(String(STORAGE_SCHEMA_VERSION));
    });

    it('leaves deploy-spanning device keys exactly as they were', () => {
        localStorage.setItem('beeflow_locale', 'nl');
        localStorage.setItem('cookie_consent', 'accepted');
        localStorage.setItem('beeflow:theme:bootstrap', '{"mode":"dark"}');
        localStorage.setItem('cms.activeSiteId', 'site-1');

        runStorageMigrations();

        expect(localStorage.getItem('beeflow_locale')).toBe('nl');
        expect(localStorage.getItem('cookie_consent')).toBe('accepted');
        expect(localStorage.getItem('beeflow:theme:bootstrap')).toBe('{"mode":"dark"}');
        expect(localStorage.getItem('cms.activeSiteId')).toBe('site-1');
    });
});

describe('runUserStorageMigrations (per-user pass)', () => {
    it('moves a pre-scoping bare key into the user scope — the old value survives, the bare key is gone', () => {
        localStorage.setItem('lastUsedAgentId', 'agent-42');
        runUserStorageMigrations('u1');
        expect(localStorage.getItem('beeflow:u1:lastUsedAgentId')).toBe('agent-42');
        expect(localStorage.getItem('lastUsedAgentId')).toBeNull();
        expect(localStorage.getItem('beeflow:u1:storageSchema')).toBe(String(STORAGE_SCHEMA_VERSION));
    });

    it('never overwrites a value the user already stored scoped — the newer choice wins, the bare leftover still goes', () => {
        localStorage.setItem('beeflow:u1:chatHistoryMode', 'full');
        localStorage.setItem('chatHistoryMode', 'ask');
        runUserStorageMigrations('u1');
        expect(localStorage.getItem('beeflow:u1:chatHistoryMode')).toBe('full');
        expect(localStorage.getItem('chatHistoryMode')).toBeNull();
    });

    it('prunes retired scoped keys and leaves every live sidebar section alone', () => {
        localStorage.setItem('beeflow:u1:reasoningEffort', 'high');
        localStorage.setItem('beeflow:u1:sidebar_agents_expanded', '0');
        localStorage.setItem('beeflow:u1:sidebar_chats_expanded', '1');
        localStorage.setItem('beeflow:u1:sidebar_projects_expanded', '0');

        runUserStorageMigrations('u1');

        expect(localStorage.getItem('beeflow:u1:reasoningEffort')).toBeNull();
        // Sidebar still reads/writes 'agents' — a stored "collapsed" must
        // survive the pass, not bounce back to the default-open state.
        expect(localStorage.getItem('beeflow:u1:sidebar_agents_expanded')).toBe('0');
        expect(localStorage.getItem('beeflow:u1:sidebar_chats_expanded')).toBe('1');
        expect(localStorage.getItem('beeflow:u1:sidebar_projects_expanded')).toBe('0');
    });

    it('moves the bare sidebar collapse keys like any other pre-scoping preference', () => {
        localStorage.setItem('sidebar_agents_expanded', '0');
        runUserStorageMigrations('u1');
        expect(localStorage.getItem('beeflow:u1:sidebar_agents_expanded')).toBe('0');
        expect(localStorage.getItem('sidebar_agents_expanded')).toBeNull();
    });

    it('runs once per user per version — the marker stops re-imports', () => {
        runUserStorageMigrations('u1');
        // A bare key appearing AFTER the pass (some old tab, a restore) is not
        // silently re-imported later — the pass already ran for this version.
        localStorage.setItem('lastUsedAgentId', 'late-arrival');
        runUserStorageMigrations('u1');
        expect(localStorage.getItem('lastUsedAgentId')).toBe('late-arrival');
        expect(localStorage.getItem('beeflow:u1:lastUsedAgentId')).toBeNull();
    });

    it('a second account does not inherit what the first one claimed', () => {
        localStorage.setItem('defaultAgentId', 'agent-9');
        runUserStorageMigrations('u1');
        runUserStorageMigrations('u2');
        expect(localStorage.getItem('beeflow:u1:defaultAgentId')).toBe('agent-9');
        expect(localStorage.getItem('beeflow:u2:defaultAgentId')).toBeNull();
        expect(localStorage.getItem('defaultAgentId')).toBeNull();
    });

    it('moves the search-recents device key into the user scope (per-user data on a shared-browser key)', () => {
        localStorage.setItem('beeflow.search.recent', '["invoice","offboarding"]');
        runUserStorageMigrations('u1');
        expect(localStorage.getItem('beeflow:u1:beeflow.search.recent')).toBe('["invoice","offboarding"]');
        expect(localStorage.getItem('beeflow.search.recent')).toBeNull();
    });

    it('moves BOTH marketplace recents keys — agent_marketplace_recents was the one key the v1 list missed', () => {
        // Regression guard: AgentMarketplace reads this via scopedStorage, so a
        // pre-scoping install upgrading straight to this build must find its
        // recents in the scoped slot, not orphaned on the bare key.
        localStorage.setItem('agent_marketplace_recents', '["agent-1","agent-2"]');
        localStorage.setItem('kb_marketplace_recents', '["kb-1"]');
        runUserStorageMigrations('u1');
        expect(localStorage.getItem('beeflow:u1:agent_marketplace_recents')).toBe('["agent-1","agent-2"]');
        expect(localStorage.getItem('beeflow:u1:kb_marketplace_recents')).toBe('["kb-1"]');
        expect(localStorage.getItem('agent_marketplace_recents')).toBeNull();
        expect(localStorage.getItem('kb_marketplace_recents')).toBeNull();
    });

    it('is a no-op without a user id and never throws', () => {
        expect(() => runUserStorageMigrations(null)).not.toThrow();
        expect(() => runUserStorageMigrations('')).not.toThrow();
        expect(localStorage.length).toBe(0);
    });

    it('treats a corrupt per-user marker as unversioned — idempotent re-run, no crash', () => {
        localStorage.setItem('beeflow:u1:storageSchema', '{"v":');
        localStorage.setItem('formRecents', '{"f1":123}');
        expect(() => runUserStorageMigrations('u1')).not.toThrow();
        expect(localStorage.getItem('beeflow:u1:formRecents')).toBe('{"f1":123}');
        expect(localStorage.getItem('beeflow:u1:storageSchema')).toBe(String(STORAGE_SCHEMA_VERSION));
    });
});

describe('storage robustness — throwing localStorage', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('never destroys a bare value the copy could not land for (full quota / read-only storage)', () => {
        // Safari's old private mode and a full quota make setItem throw while
        // removeItem still works. The move must then LEAVE the bare key — the
        // marker can't persist in that state either, so the pass retries on
        // the next start instead of deleting the only copy of the preference.
        const store = new Map([['lastUsedAgentId', 'agent-42']]);
        vi.stubGlobal('localStorage', {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
            removeItem: (k) => { store.delete(k); },
            key: (i) => [...store.keys()][i] ?? null,
            get length() { return store.size; },
        });
        expect(() => runUserStorageMigrations('u1')).not.toThrow();
        expect(store.get('lastUsedAgentId')).toBe('agent-42'); // survived
    });

    it('never crashes when storage throws on every touch (blocked context)', () => {
        const denied = new Proxy({}, { get() { throw new DOMException('denied', 'SecurityError'); } });
        vi.stubGlobal('localStorage', denied);
        expect(() => runStorageMigrations()).not.toThrow();
        expect(() => runUserStorageMigrations('u1')).not.toThrow();
        expect(readDeviceJSON('x', 'fallback')).toBe('fallback');
    });
});

describe('readDeviceJSON', () => {
    it('returns the fallback on missing or corrupt JSON', () => {
        expect(readDeviceJSON('nope', { d: 1 })).toEqual({ d: 1 });
        localStorage.setItem('bad', '{oops');
        expect(readDeviceJSON('bad', 'fallback')).toBe('fallback');
    });

    it('lets a validator reject a wrong shape — valid JSON is not enough', () => {
        localStorage.setItem('shape', '["an","array"]');
        const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
        expect(readDeviceJSON('shape', {}, asObject)).toEqual({});
        localStorage.setItem('shape', '{"ok":true}');
        expect(readDeviceJSON('shape', {}, asObject)).toEqual({ ok: true });
    });
});
