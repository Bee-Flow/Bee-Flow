import { messageContentToText } from '../../../utils/messageShape';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import MarkdownRenderer from '../../renderers/MarkdownRenderer';
import ActivityIndicator from './ActivityIndicator';
import useTranslation from '../../../hooks/useTranslation';

/**
 * The non-tool message body: error card, rendered markdown, or the streaming
 * activity indicator. Lifted verbatim out of MessageItem/index.jsx.
 */
const MessageContentBody = ({ msg, reasoningVisible, sessionSkills }) => {
    const { t } = useTranslation();
    // NOT String(msg.content): on block content that yields the
    // literal "[object Object],[object Object]" users reported
    // in BFSF-307. Always read content through the walker.
    const errText = messageContentToText(msg.content);
    // BFSF-349: a turn that failed AFTER some of its tools ran keeps the reply
    // so far and the "done before the error" line, rendered as the answer they
    // are; the card below them holds only the error, and only the error decides
    // what kind of card it is (a tool named "Cancel subscription" is no
    // subscription problem).
    const afterActions = !!msg.isError && msg.completedToolCount > 0
        && typeof msg.errorDetail === 'string' && !!msg.errorDetail && errText.endsWith(msg.errorDetail);
    const cardText = afterActions ? msg.errorDetail : errText;
    // The error card's TITLE, per kind. The ternary wraps the KEY, not the
    // sentence: a translation that only replaced the English text could not
    // carry the distinction between these cases.
    // There is deliberately no "Chat" + "type" branch any more (BFSF-184): it
    // matched every provider error relayed as `Chat error: ... {"type":...}`
    // and titled a prefill 400 "Chat Agent Limit Reached". The real per-type
    // limit reads "... monthly Chat message limit ..." and lands on the
    // `message limit` branch.
    const errorTitle = cardText && (
        cardText.includes('suspended')
            ? { key: 'chat.msg.err_sub_suspended', en: 'Subscription Suspended' }
            : cardText.includes('cancelled')
                ? { key: 'chat.msg.err_sub_cancelled', en: 'Subscription Cancelled' }
                : cardText.includes('message limit')
                    ? { key: 'chat.msg.err_message_limit', en: 'Monthly Message Limit Reached' }
                    : cardText.includes('token limit')
                        ? { key: 'chat.msg.err_token_limit', en: 'Monthly Token Limit Reached' }
                        : cardText.includes('cost limit')
                            ? { key: 'chat.msg.err_cost_limit', en: 'Monthly Cost Limit Reached' }
                            : (cardText.includes('limit') || cardText.includes('subscription'))
                                ? { key: 'chat.msg.err_sub_limit', en: 'Subscription Limit Reached' }
                                : { key: 'chat.msg.err_generic', en: 'Something went wrong' }
    );
    const errorCard = msg.isError && errText ? (
        <div className={`flex items-start gap-3 p-3 rounded-xl border ${cardText.includes('limit') || cardText.includes('subscription') || cardText.includes('suspended') || cardText.includes('cancelled')
            ? 'bg-orange-100 dark:bg-amber-900/30 border-orange-400 dark:border-amber-500/50'
            : 'bg-red-100 dark:bg-red-900/30 border-red-400 dark:border-red-500/50'
            }`}>
            <span className="text-lg flex-shrink-0 mt-0.5">{cardText.includes('limit') || cardText.includes('subscription') ? '⚠️' : '❌'}</span>
            <div>
                <div className={`font-semibold text-sm mb-0.5 ${cardText.includes('limit') || cardText.includes('subscription') || cardText.includes('suspended') || cardText.includes('cancelled')
                    ? 'text-orange-800 dark:text-amber-200' : 'text-red-800 dark:text-red-200'
                    }`}>
                    {afterActions
                        ? nOf(t, 'chat.msg.stopped_after_actions', msg.completedToolCount, 'Stopped after 1 action', 'Stopped after {count} actions')
                        : t(errorTitle.key, errorTitle.en)}
                </div>
                <div className={`text-xs ${cardText.includes('limit') || cardText.includes('subscription')
                    ? 'text-orange-700 dark:text-amber-300/90' : 'text-red-700 dark:text-red-300/90'
                    }`}>{cardText}</div>
            </div>
        </div>
    ) : null;
    if (errorCard && afterActions) {
        const before = errText.slice(0, errText.length - msg.errorDetail.length).trim();
        return (
            <>
                {before && <MarkdownRenderer content={before} isLoading={false} />}
                {errorCard}
            </>
        );
    }
    return errorCard || (msg.content ? (
        <MarkdownRenderer content={msg.images?.length > 0 ? errText.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim() : errText} isLoading={msg.isStreaming} />
    ) : msg.isStreaming && (!msg.thinking || !reasoningVisible) ? (
        // BFSF-263: keep the indicator during a reasoning-only
        // phase whenever the ThinkingPanel is NOT visible —
        // in Simple Mode and in embeds the extracted
        // reasoning populates msg.thinking while content
        // stays empty, and hiding the indicator would leave
        // a frozen empty bubble for the whole think phase.
        <ActivityIndicator msg={msg} sessionSkills={sessionSkills} />
    ) : null);
};

export default MessageContentBody;
