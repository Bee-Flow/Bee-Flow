import type { SseHandlerMap } from '../handlerTypes';
import type { KbSource } from '../../types';

/**
 * What makes two citations the same passage, as the server's own turn dedup
 * reads it (toolRound/sideChannels.js): the chunk or live table row it quotes,
 * else its title, section and opening text. The opening text ALONE is not it:
 * the chunks of one table all start with the same header row and a source
 * without text has none, so a later search in the turn lost every such source.
 */
function sourceKey(s: KbSource): string {
    if (s.chunkId != null) return `chunk:${String(s.chunkId)}`;
    if (s.datatableId != null && s.rowId != null) return `row:${String(s.datatableId)}:${String(s.rowId)}`;
    return `text:${String(s.title ?? '')}::${String(s.section ?? '')}::${(s.content || '').slice(0, 100)}`;
}

/**
 * What lands on the reply next to its text: maps, media, files, knowledge-base
 * sources, used memories and the rule attribution of a test chat.
 */
export const answerPartHandlers: SseHandlerMap = {
    map_embed(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        setMessages(prev => prev.map(m =>
            m.id === assistantMsgId ? {
                ...m,
                mapEmbeds: [...(m.mapEmbeds || []), data]
            } : m
        ));
    },

    image(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        if (data.data && data.mimeType) {
            setMessages(prev => prev.map(m =>
                m.id === activeIdRef.current ? {
                    ...m,
                    images: [...(m.images || []), {
                        data: data.data,
                        mimeType: data.mimeType,
                    }]
                } : m
            ));
        }
    },

    audio(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        if (data.url) {
            setMessages(prev => prev.map(m =>
                m.id === activeIdRef.current ? {
                    ...m,
                    audioFiles: [...(m.audioFiles || []), {
                        url: data.url,
                        mimeType: data.mimeType || 'audio/mpeg',
                        source: data.source || 'elevenlabs',
                    }]
                } : m
            ));
        }
    },

    file(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        // A file a tool built (a deck): the card under the reply — shown
        // whether or not the model remembers to write the link.
        if (data && (data.url || data.webUrl)) {
            setMessages(prev => prev.map(m =>
                m.id === activeIdRef.current ? { ...m, files: [...(m.files || []), data] } : m
            ));
        }
    },

    video(ctx, data, ids) {
        const { setMessages } = ctx;
        const { activeIdRef } = ids;
        if (data.url && data.mimeType) {
            setMessages(prev => prev.map(m =>
                m.id === activeIdRef.current ? {
                    ...m,
                    videoFiles: [...(m.videoFiles || []), {
                        url: data.url,
                        mimeType: data.mimeType,
                    }]
                } : m
            ));
        }
    },

    kb_sources(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        if (data.sources) {
            const sources = data.sources;
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                // Merge with what the turn already has; a passage is cited once.
                const existing = m.kbSources || [];
                const seen = new Set(existing.map(sourceKey));
                const newSources = sources.filter(s => !seen.has(sourceKey(s)));
                return { ...m, kbSources: [...existing, ...newSources] };
            }));
        }
    },

    // The memories this turn drew on. Sent once, only when non-empty.
    memory_used(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        if (Array.isArray(data?.items) && data.items.length > 0) {
            const items = data.items;
            setMessages(prev => prev.map(m => (
                m.id === assistantMsgId ? { ...m, memoryUsed: items } : m
            )));
        }
    },

    // The attribution pass of a TEST CHAT (A4): which `doesNot` rules of the
    // role this answer visibly followed. An OPINION, not minutes, so the chip
    // row shows it separately (see AnswerChips.jsx).
    //
    // Only a non-empty list lands. An empty or unreadable payload would
    // otherwise wipe an earlier verdict, and "nothing shows now" could be read
    // as "nothing was followed": exactly the claim the pass must not make.
    rule_attribution(ctx, data, ids) {
        const { setMessages } = ctx;
        const { assistantMsgId } = ids;
        if (Array.isArray(data?.rules) && data.rules.length > 0) {
            setMessages(prev => prev.map(m => (
                m.id === assistantMsgId
                    ? { ...m, ruleAttribution: { rules: data.rules } }
                    : m
            )));
        }
    },
};
