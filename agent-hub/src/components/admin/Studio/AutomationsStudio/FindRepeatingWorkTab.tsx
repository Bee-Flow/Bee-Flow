import type { RepeatingSuggestion } from '../../../../api/queries/automation/repeating';
import RepeatingWorkPanel from './repeating/RepeatingWorkPanel';

interface FindRepeatingWorkTabProps {
    /** "Build this": a fresh builder that sends the pattern's brief at once. */
    onBuildSuggestion?: (s: RepeatingSuggestion) => void;
    /** "Adjust first": a fresh builder with the brief pre-filled, not sent. */
    onAskSuggestion?: (s: RepeatingSuggestion) => void;
}

/**
 * The "Find repeating work" tab of the automations launcher. The panel
 * records `opened` / `asked` itself when a card is clicked; the launcher's
 * callbacks open the builder (components/automation/index.jsx, which turns
 * the suggestion into the builder's brief and keeps its signature so the
 * builder can record `built`). Without a way into the builder there is
 * nothing to offer, so the tab renders nothing.
 */
export default function FindRepeatingWorkTab({ onBuildSuggestion, onAskSuggestion }: FindRepeatingWorkTabProps) {
    if (!onBuildSuggestion && !onAskSuggestion) return null;
    return <RepeatingWorkPanel onBuildSuggestion={onBuildSuggestion} onAskSuggestion={onAskSuggestion} />;
}
