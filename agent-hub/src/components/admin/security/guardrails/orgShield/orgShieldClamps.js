/**
 * "Saved, with notes" — said precisely enough to act on.
 *
 * The server clamps settings the org's plan does not allow, persists the
 * clamped value, and reports which fields it touched in `clamped_fields`. The
 * page used to render that as one of two sentences: a specific one about
 * Tokenize, or "some settings were adjusted to your plan limits" for
 * everything else. The second is the problem — an admin who has just changed
 * four things on two panes is told that one of them did not stick, and not
 * which. So they either re-check all four or, far more often, assume it was
 * fine.
 *
 * Pure so the wording can be unit-tested without a save.
 */

/** Payload field → the label the admin saw on the control, and its pane. */
const CLAMP_LABELS = {
    piiDetectionAction: {
        key: 'admin.shield_clamp_action',
        en: 'Replace with placeholders — messages are stopped instead',
        tab: 'processing',
    },
    webSearchGuardEnabled: {
        key: 'admin.shield_clamp_web_guard',
        en: 'Protect web searches — switched back off',
        tab: 'outbound',
    },
    webSearchGuardPiiCategories: {
        key: 'admin.shield_clamp_web_guard_cats',
        en: 'the kinds withheld from web searches — emptied',
        tab: 'outbound',
    },
    toolPiiPolicy: {
        key: 'admin.shield_clamp_tool_policy',
        en: 'the kinds withheld from tools outside your organisation — emptied',
        tab: 'detection',
    },
};

/**
 * Clamps that read as a sentence of their own rather than as an item in the
 * "Your plan does not include: …" list. "Your own data" is one: on a plan
 * without it the server keeps the stored types and refuses every change
 * except removing a migrated one, so what the admin needs to hear is that
 * their edits there did not land, not which sub-setting was emptied.
 *
 * The sentence names the kinds of data, not the tab: the never-hidden list
 * on the same tab is saved on every plan.
 */
const CLAMP_SENTENCES = {
    customDataTypes: {
        key: 'shield_data.clamp_saved_types',
        en: 'Your own kinds of data can only be changed with Enterprise. Your changes to them were not saved.',
        loadKey: 'shield_data.clamp_load_types',
        loadEn: 'Your own kinds of data can only be changed with Enterprise.',
        tab: 'owndata',
    },
};

/**
 * @param {string[]} fields  `clamped_fields` from the save response
 * @param {Function} t
 * @returns {{ text: string, tabs: string[] }} the sentence, and which panes it
 *   concerns so the caller can offer a jump
 */
export function describeClamps(fields, t) {
    const known = (fields || []).map(f => CLAMP_LABELS[f]).filter(Boolean);
    const sentences = (fields || []).map(f => CLAMP_SENTENCES[f]).filter(Boolean);

    // A field the server clamped that this build has no label for — a newer
    // server against an older client. Say that plainly rather than silently
    // reporting a clean save.
    const unknown = (fields || []).length - known.length - sentences.length;

    const parts = known.map(entry => t(entry.key, entry.en));
    if (unknown > 0) {
        parts.push(t('admin.shield_clamp_other', '{n} other settings', { n: unknown }));
    }

    const extra = sentences.map(e => t(e.key, e.en));
    const tabs = [...new Set([...known, ...sentences].map(e => e.tab))];

    if (parts.length === 0 && extra.length === 0) {
        return { text: t('admin.shield_clamp_generic', 'Saved. Some settings were adjusted to your plan limits.'), tabs: [] };
    }
    if (parts.length === 0) {
        return {
            text: [t('shield_data.clamp_saved_lead', 'Saved, with notes.'), ...extra].join(' '),
            tabs,
        };
    }

    return {
        text: [t('admin.shield_clamp_lead',
            'Saved, with notes. Your plan does not include: {what}. Every other change did land.',
            { what: parts.join('; ') }), ...extra].join(' '),
        tabs,
    };
}

/** The same list, for the read path — the settings are already clamped on load. */
export function describeClampsOnLoad(fields, t) {
    const known = (fields || []).map(f => CLAMP_LABELS[f]).filter(Boolean);
    const extra = (fields || []).map(f => CLAMP_SENTENCES[f]).filter(Boolean).map(e => t(e.loadKey, e.loadEn));
    if (known.length === 0) {
        return extra.length
            ? extra.join(' ')
            : t('admin.shield_clamp_load_generic', 'Some settings are limited by your current plan.');
    }
    return [t('admin.shield_clamp_load',
        'Your plan does not include: {what}. What you see here is what is in force.',
        { what: known.map(e => t(e.key, e.en)).join('; ') }), ...extra].join(' ');
}

const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * A successful PUT's response → the message the page shows, and the result
 * the editor hands to its toast.
 *
 * Three ways a save lands "with notes", in the order they are reported: a
 * setting the plan clamped, one of the org's own types the server refused
 * (`typeErrors`), and a legacy custom term it refused (`termErrors`, kept for
 * one release). Each is a partial success: the valid rest was saved, and a
 * plain "Saved." would let an admin believe the refused part is in force.
 *
 * @returns {{ message: object, result: object, clampedAction: string|null }}
 */
export function describeSaveResult(data, t) {
    const clamped = listOf(data?.clamped_fields);
    const termErrors = listOf(data?.termErrors);
    const typeErrors = listOf(data?.typeErrors);
    const result = { ok: true, clamped, termErrors, typeErrors };
    if (clamped.length > 0) {
        const clamp = describeClamps(clamped, t);
        return {
            // A warning, not an error: the save DID happen. Painting
            // "Saved. Note: …" in red read as a failure.
            message: { type: 'warning', text: clamp.text, tabs: clamp.tabs },
            result,
            clampedAction: data?.config?.piiDetectionAction || null,
        };
    }
    if (typeErrors.length > 0) {
        return {
            message: {
                type: 'warning',
                text: t('shield_data.save_type_errors',
                    'Saved, with notes. {n} of your own types were refused and are not in force. They are marked under Your own data.',
                    { n: typeErrors.length }),
                tabs: ['owndata'],
            },
            result,
            clampedAction: null,
        };
    }
    if (termErrors.length > 0) {
        return {
            message: {
                type: 'warning',
                text: t('admin.shield_terms_rejected',
                    'Saved, with notes. {n} of your own words or patterns were refused and are NOT in force — the offending rows are marked below.',
                    { n: termErrors.length }),
            },
            result,
            clampedAction: null,
        };
    }
    return { message: { type: 'success', text: 'Saved.' }, result, clampedAction: null };
}

export default describeClamps;
