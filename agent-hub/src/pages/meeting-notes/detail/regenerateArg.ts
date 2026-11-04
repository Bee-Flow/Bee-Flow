import type { RegenerateArg } from '@/api/transcriptionsApi.types';
import type { SummaryTemplates } from './summaryTemplates.types';

/** How the server stamps a built-in template (server/core/meetingNotes/summaryStamp.js). */
const BUILTIN_STAMP_PREFIX = 'builtin:';

/**
 * What to regenerate a summary with when nobody picked a template: the
 * "Speakers updated, regenerate?" banner. That banner is about NAMES, not
 * about layout, so it rewrites the note with the template that wrote the text
 * that is there now (`summaryTemplateId`): a built-in key, or a saved
 * template. Sending a fixed 'general' silently replaced a sales-call layout
 * with the General one and stamped the note as such.
 *
 * Falls back to the reader's default template, then to General, when the
 * note carries no stamp (an old note, a one-off prompt) or when the template
 * list loaded and the saved template is no longer in it (the server would
 * answer 404 for it).
 */
export function regenerateArgForNote(
    summaryTemplateId: string | null | undefined,
    templates: SummaryTemplates | null | undefined,
): RegenerateArg {
    const id = typeof summaryTemplateId === 'string' ? summaryTemplateId.trim() : '';
    if (id.startsWith(BUILTIN_STAMP_PREFIX)) {
        const key = id.slice(BUILTIN_STAMP_PREFIX.length);
        if (key) return { template: key };
    } else if (id) {
        const custom = Array.isArray(templates?.custom) ? templates.custom : null;
        // No list yet: send it anyway, the server checks visibility itself.
        if (!custom || custom.some((tpl) => tpl && tpl.id === id)) return { templateId: id };
    }
    const fallback = templates?.defaultTemplateId;
    return fallback ? { templateId: fallback } : { template: 'general' };
}
