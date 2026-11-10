import { CHIP, CHIP_INFO, CHIP_SUCCESS, CHIP_WARNING } from '@/components/mcpLibrary/ui';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * A YouTrack issue's state, drawn with the chip recipes the support inbox uses
 * for its own statuses.
 *
 * Deliberately the same colour language as the ticket list, so a Fixed issue
 * and a Resolved ticket read as the same kind of "done" and an agent never has
 * to hold two colour languages in their head at once. YouTrack state names are
 * per-project, so anything unrecognised falls back to neutral rather than
 * guessing.
 */
const STATE_CHIP: Record<string, string> = {
    fixed: CHIP_SUCCESS,
    resolved: CHIP_SUCCESS,
    verified: CHIP_SUCCESS,
    done: CHIP_SUCCESS,
    'in progress': CHIP_INFO,
    'to verify': CHIP_INFO,
    open: CHIP_INFO,
    submitted: CHIP_INFO,
    reopened: CHIP_WARNING,
    'won\'t fix': `${CHIP} opacity-70`,
    duplicate: `${CHIP} opacity-70`,
};

interface IssueStateChipProps {
    state?: string | null;
    resolved?: boolean | null;
}

export default function IssueStateChip({ state, resolved }: IssueStateChipProps) {
    const { t } = useTranslation();
    // The style follows the English word; a translated fallback label keeps its colour.
    const key = state || (resolved ? 'Resolved' : 'Unknown');
    const label = state || (resolved ? t('support.issue_state_resolved', 'Resolved') : t('support.issue_state_unknown', 'Unknown'));
    return (
        <span className={`shrink-0 ${STATE_CHIP[key.toLowerCase()] || CHIP}`}>
            {label}
        </span>
    );
}
