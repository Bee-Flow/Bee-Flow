import { useMemo, useRef, useState } from 'react';
import useAutomationApi from '@/hooks/useAutomationApi';
import { useTranslation } from '@/hooks/useTranslation';
import { matchCounts } from './routeIntents';
import { hostFromPreview, planTopicPreview } from './topicPreview';
import type { PreviewRule, TopicPreviewResponse } from './topicPreview';
import { errorStatus } from '@/utils/caughtError';

/**
 * "Check the sample rows" for "is about" rules: ask the topic classifier to
 * score the texts of the editor's sample rows, on a click and never on render
 * (the texts are sent to the server, so sending them is the author's call).
 *
 * The answer belongs to ONE question: these topics over these texts. When the
 * rules or the rows change it is dropped, the same stale-answer rule the rest
 * of Suggest outputs keeps.
 *
 * Returns the preview's `counts` too, for every suggestion: rules without
 * "is about" are counted over all sample rows as before; rules with it only
 * over the rows the classifier scored, and not at all until it has.
 */
interface Args {
    rules: PreviewRule[];
    rows: unknown[] | null;
    root?: unknown;
    itemVar?: string;
}

interface State {
    key: string;
    host: ReturnType<typeof hostFromPreview>;
    error: string;
    loading: boolean;
}

export default function useTopicPreview({ rules, rows, root = null, itemVar = 'item' }: Args) {
    const api = useAutomationApi();
    const { t } = useTranslation();
    const plan = useMemo(() => planTopicPreview(rules, rows, { root, itemVar }), [rules, rows, root, itemVar]);
    const key = plan ? JSON.stringify([plan.labels, plan.texts]) : '';
    const [state, setState] = useState<State>({ key: '', host: null, error: '', loading: false });

    // Which ask is the newest. An answer to an earlier one may arrive after it
    // (the rules changed, the author asked again): written to the state it
    // would take the newer answer's place under a key that no longer applies,
    // and the check just made would show nothing.
    const asked = useRef(0);
    const check = async () => {
        if (!plan || !plan.texts.length) return;
        const mine = ++asked.current;
        setState({ key, host: null, error: '', loading: true });
        try {
            const res = await api.previewTopics({ texts: plan.texts, labels: plan.labels }) as TopicPreviewResponse;
            if (asked.current !== mine) return;
            setState({ key, host: hostFromPreview(res), error: '', loading: false });
        } catch (e) {
            if (asked.current !== mine) return;
            const status = errorStatus(e);
            const error = status === 409
                ? t('automations.builder.topics.check_not_installed', 'No topic classifier is installed on this server, so these rules cannot be checked.')
                : t('automations.builder.topics.check_failed', 'The topic classifier did not answer. Try again in a moment.');
            setState({ key, host: null, error, loading: false });
        }
    };

    const fresh = state.key === key;
    const needed = !!plan && plan.texts.length > 0;
    const host = fresh ? state.host : null;
    const counts = useMemo(() => {
        if (!needed || !plan) return matchCounts(rules, rows, { root, itemVar });
        return host ? matchCounts(rules, plan.rows, { root, itemVar, host }) : null;
    }, [needed, host, rules, rows, plan, root, itemVar]);
    return {
        counts,
        topic: {
            /** There are "is about" rules and sample rows to check them against. */
            needed,
            loading: fresh && state.loading,
            error: fresh ? state.error : '',
            /** Rows the classifier's answer covers once checked, else null. */
            checkedRows: needed && counts ? counts.total : null,
            totalRows: Array.isArray(rows) ? rows.length : 0,
            check,
        },
    };
}
