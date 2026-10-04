/**
 * "Welke agent gaf dit antwoord?" — de regel boven een testchat-antwoord.
 *
 * Een testchat draait op het CONCEPT (A4). Een automatisering draait op de
 * GEPUBLICEERDE config (R2). Dat verschil is met opzet gemaakt — je test wat
 * je aan het maken bent — maar het is precies het soort verschil dat, als het
 * niet op het scherm staat, iemand laat denken dat hij net heeft gecontroleerd
 * wat er in productie gebeurt. Deze regel is dat scherm.
 *
 * ── HET LEEST DE SERVER, NOOIT DE AANVRAAG ──────────────────────────
 * De vorm komt uit het `test_chat`-event, dat de runtime opstelt uit de rij
 * die hij werkelijk laadde. De client mag zo'n label nooit uit zijn eigen
 * verzoek afleiden — dezelfde regel als bij "Test als" (chatStream stuurt daar
 * `test_as` om precies deze reden).
 *
 * ── ONBEKEND IS GEEN GERUSTSTELLING ─────────────────────────────────
 * `source: 'unknown'` betekent dat niemand kon zeggen welke config draaide.
 * Dan staat er niet "je concept" met een slag om de arm, maar de waarheid: dit
 * antwoord is niet toe te wijzen. Dat is de enige zin die dan waar is.
 */

import { FileText, HelpCircle, Send } from 'lucide-react';
import React from 'react';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

export default function TestChatNotice({ info, t = (k, d) => d }) {
    if (!info || info.active !== true) return null;

    const source = info.source;
    const published = Number(info.publishedVersion) || 0;
    const ahead = Number(info.unpublishedChanges) || 0;

    if (source === 'unknown') {
        return (
            <div data-testid="test-chat-notice" data-source="unknown"
                className="flex items-center gap-2 mb-2 text-[11px] text-amber-600 dark:text-amber-400">
                <HelpCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t('agent_studio.test.chat_source_unknown',
                    'Could not tell which version of this agent answered.')}</span>
            </div>
        );
    }

    // 'published' hoort hier eigenlijk niet te staan — een testchat vraagt om
    // het concept — maar als de projectie iets anders teruggaf is dát het
    // nieuws, niet een geruststellende zin over je concept.
    if (source === 'published') {
        return (
            <div data-testid="test-chat-notice" data-source="published"
                className="flex items-center gap-2 mb-2 text-[11px] text-amber-600 dark:text-amber-400">
                <Send className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t('agent_studio.test.chat_source_published',
                    'This answer came from the published agent, not from your draft.')}</span>
            </div>
        );
    }

    return (
        <div data-testid="test-chat-notice" data-source={source}
            className="flex items-center gap-2 mb-2 text-[11px] text-[var(--text-tertiary)]">
            <FileText className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
                {t('agent_studio.test.chat_source_draft', 'Answered by your draft.')}
                {' '}
                {published > 0
                    ? (
                        ahead > 0
                            // Meervoud met een eigen sleutel: "1 unpublished changes"
                            // is precies het soort slordigheid dat een zorgvuldig
                            // product onzorgvuldig laat lijken.
                            ? nOf(t, 'agent_studio.test.chat_source_live_ahead', ahead,
                                'Live is v{version}, with {count} unpublished change.',
                                'Live is v{version}, with {count} unpublished changes.',
                                { version: published })
                            : t('agent_studio.test.chat_source_live_same',
                                'Live is v{version} — the same as your draft.', { version: published })
                    )
                    : t('agent_studio.test.chat_source_never_published',
                        'Nothing is published yet, so this is also what people would get.')}
            </span>
        </div>
    );
}
