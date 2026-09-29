// "Ask this only once per run" — the tick shared by the integration_action and
// http_request editors, and the caller-side answer to whether it is available.

/**
 * "Ask this only once per run" — off unless ticked.
 *
 * CATALOG-FREE ON PURPOSE. It used to read `action.askOnceable` straight out of
 * builderCatalog, which meant only an integration_action could render it. The
 * http_request step has the same setting and no catalog entry at all, so the
 * caller now decides whether the tick is available and SAYS WHY — see
 * askOnceAvailability below and the http_request block in HttpRequestFields.
 *
 * The disabled REASON matters as much as the toggle. isSideEffect is
 * fail-closed, so every unlisted mcp_* and cint_* READ would otherwise be
 * disabled with "this action is a write", which is simply untrue.
 *
 * The word "cache" is deliberately absent from the label. In this product
 * "reuse" already means a reusable sub-flow (routines.node.call_layer.help),
 * a concept that suffers four names already; a fifth overload is not
 * affordable. cache/caching/ttl/memo live in search keywords only — the same
 * trick stepPalette uses for "cron".
 */
/**
 * Whether an integration_action may reuse its answer, and — when it may not —
 * the honest sentence saying why.
 *
 * `askOnceable === undefined` means the catalog has not said (an older server,
 * or an action it does not know): do not claim either way, leave the toggle
 * usable and let the validator have the last word.
 */
function askOnceAvailability(action, appLabel) {
    const askOnceable = action ? action.askOnceable : undefined;
    const isWrite = action ? action.sideEffect === true : false;
    if (askOnceable !== false) return { disabled: false, disabledReason: null };
    return {
        disabled: true,
        disabledReason: isWrite
            ? `This action changes something in ${appLabel || 'the app'}, so its answer cannot be reused.`
            : 'This look-up is checked fresh every time — either it changes by the minute, or its permissions are checked as it runs.',
    };
}

function AskOnceRow({ draft, set, disabled = false, disabledReason = null, label = 'Ask this app only once per run' }) {
    const on = !!draft.askOnce;
    // Shown whether or not the tick is disabled. It used to be
    // disabled-only, which silently swallowed the caution a WRITE method
    // now carries: the tick is enabled there on purpose, and the sentence
    // explaining what a cache hit costs is exactly the part the author
    // needs to read BEFORE ticking it.
    const reason = disabledReason;

    // The two are stored on ONE field so a definition cannot claim to reuse
    // between runs while not reusing within one: `askOnce: true` is the plain
    // tick, `{ acrossRuns: true }` is the tick plus the wider promise.
    const acrossRuns = !!(draft.askOnce && typeof draft.askOnce === 'object' && draft.askOnce.acrossRuns);
    // A ttlSeconds the definition already carries must survive this tick. No
    // editor writes one — the AI builder and hand-edited definitions do — and
    // now that the form actually persists askOnce, collapsing to a bare `true`
    // here would silently delete the author's own reuse window.
    const ttl = (draft.askOnce && typeof draft.askOnce === 'object' && Number.isFinite(Number(draft.askOnce.ttlSeconds)))
        ? { ttlSeconds: Number(draft.askOnce.ttlSeconds) }
        : null;
    const setAcrossRuns = (checked) => {
        if (checked) return set('askOnce', { acrossRuns: true, ...(ttl || {}) });
        return set('askOnce', ttl ? { ...ttl } : true);
    };

    return (
        <div className="pt-1 space-y-1.5">
            <label className={`flex items-start gap-2 text-xs ${disabled ? 'opacity-60' : ''}`}>
                <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={on}
                    disabled={disabled}
                    onChange={(e) => set('askOnce', e.target.checked ? true : undefined)}
                />
                <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-slate-500 dark:text-slate-400">
                        {reason || 'If this step asks the same thing more than once in a run — inside a loop, say — the first answer is used again instead of asking every time.'}
                    </span>
                </span>
            </label>

            {/* Only offered once the first is on: "keep it for the NEXT run"
                is meaningless for a step that asks fresh every time, and a
                nested tick that silently does nothing is worse than none. */}
            {on && (
                <label className="flex items-start gap-2 text-xs pl-5">
                    <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={acrossRuns}
                        onChange={(e) => setAcrossRuns(e.target.checked)}
                    />
                    <span>
                        <span className="font-medium">…and keep the answer for later runs too</span>
                        <span className="block text-slate-500 dark:text-slate-400">
                            {/* Two things a person must be able to see before ticking
                                this: the answer is STORED, and their administrator has
                                the final say. Neither is discoverable from the runtime
                                behaviour — a step that silently asked every time would
                                just look slow. */}
                            The answer is stored, encrypted, so the next run can use it instead of asking again.
                            Your administrator decides whether that is allowed, and for how long; until they
                            turn it on, this step asks every run.
                        </span>
                    </span>
                </label>
            )}
        </div>
    );
}

export { askOnceAvailability, AskOnceRow };
