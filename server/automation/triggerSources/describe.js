/**
 * Prompt-facing descriptions of the declared trigger sources.
 *
 * The builder agent's tool schema used to spell the provider and event lists out
 * by hand, and they had rotted: the enum promised Nextcloud events
 * (talk.mention.received, task.due, share.accepted…) that no longer existed, so
 * the model was being invited to author triggers that could never fire.
 * Deriving the text means it cannot drift again.
 *
 * These are GLOBAL descriptions — TOOL_SCHEMAS is a shared singleton, so
 * anything per-user would leak between sessions. Per-user gating belongs in the
 * catalog block of the system prompt, which is built per request.
 */
const { listTriggerSources } = require('./index');

function describeSourcesForPrompt({ maxEventsPerProvider = 12 } = {}) {
    const sources = listTriggerSources({ includeHidden: false })
        .map(src => ({ src, events: (src.events || []).filter(e => !e.hidden) }))
        .filter(({ events }) => events.length > 0);

    const providerList = sources.map(({ src }) => src.id).join(' | ');

    const eventList = sources.map(({ src, events }) => {
        const ids = events.map(e => e.id);
        const shown = ids.slice(0, maxEventsPerProvider);
        const more = ids.length > shown.length ? ', …' : '';
        return `${src.id}.{${shown.join(', ')}${more}}`;
    }).join('; ');

    return { providerList, eventList };
}

module.exports = { describeSourcesForPrompt };
