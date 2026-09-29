import { resolveUrl } from './messageItemHelpers';
import useTranslation from '../../../hooks/useTranslation';

/**
 * The attachment chips under a message bubble. Lifted verbatim out of
 * MessageItem/index.jsx — the caller still owns the
 * `msg.attachments && msg.attachments.length > 0` gate.
 */
const MessageAttachments = ({ msg, isUser, setLightboxImage }) => {
    const { t } = useTranslation();
    return (
    <div className="mt-2 flex flex-wrap gap-2">
        {msg.attachments.map((att, i) => {
            const isImage = att.type?.startsWith('image/');
            const previewSrc = isImage ? (resolveUrl(att.url) || att.content) : null;
            return (
                <div key={i} className={`rounded-lg overflow-hidden text-xs border flex items-center gap-1.5 ${isUser ? 'bg-white/10 border-white/20' : 'bg-[var(--bg-primary)] border-[var(--border-subtle)]'}`}>
                    {previewSrc && (
                        <img src={previewSrc} alt={att.name} className="w-12 h-12 object-cover flex-shrink-0 cursor-pointer" onClick={() => setLightboxImage(previewSrc)} />
                    )}
                    <div className="px-2 py-1.5 min-w-0">
                        {att.url ? (
                            <a href={resolveUrl(att.url)} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline truncate block max-w-[200px]">{att.name || t('chat.msg.attachment', 'Attachment')}</a>
                        ) : (
                            <span className="font-medium truncate block max-w-[200px]">{att.name || t('chat.msg.attachment', 'Attachment')}</span>
                        )}
                    </div>
                </div>
            );
        })}
    </div>
    );
};

export default MessageAttachments;
