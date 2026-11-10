// The avatar of an agent: an emoji from a small picker, a typed emoji, or an
// uploaded image (data URL, at most 512 KB). Split out of IdentitySection.
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { isImageAvatar, resolveAvatarSrc, DEFAULT_AGENT_EMOJI } from '@/utils/agentAvatar';
import { toast } from '@/components/shared/Toast';
import { FIELD_INPUT } from '@/components/shared/SettingsList';
import { QUIET_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import { useTranslation } from '@/hooks/useTranslation';

const EMOJI_CATEGORIES: Record<string, { label: string; title: string; emojis: string[] }> = {
    smileys: { label: '😀', title: 'Smileys', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😛', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤡', '🥹', '😏', '😌', '😔', '😴', '🤤', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '😵', '🤯', '🥳', '🤠', '😈', '👿', '👹', '👺', '💀', '👻', '👽', '🤖', '💩', '😺', '😸'] },
    people: { label: '👤', title: 'People', emojis: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '💪', '🦾', '🦿', '👨‍💻', '👩‍💻', '👨‍🔬', '👩‍🔬', '👨‍🎨', '👩‍🎨', '🧙‍♂️', '🧙‍♀️', '🦸‍♂️', '🦸‍♀️', '🥷', '🧑‍🚀', '👮', '🕵️', '💂', '🧑‍🍳', '🧑‍🏫', '🧑‍⚕️'] },
    animals: { label: '🐾', title: 'Animals', emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦗', '🕷️', '🦂', '🐢', '🐍', '🦎', '🐙', '🦑', '🐠', '🐟', '🐬', '🐳', '🦈'] },
    food: { label: '🍕', title: 'Food', emojis: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🧄', '🧅', '🥔', '🍞', '🥐', '🥖', '🥨', '🧀', '🥚', '🍳', '🥞', '🧇', '🥓', '🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🫔', '🥗', '🍜'] },
    travel: { label: '✈️', title: 'Travel', emojis: ['🚗', '🚕', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🛵', '🏍️', '🚲', '🛴', '🚂', '🚆', '🚇', '✈️', '🛫', '🛬', '🚀', '🛸', '🚁', '⛵', '🚢', '🏠', '🏡', '🏢', '🏣', '🏥', '🏦', '🏨', '🏩', '🏪', '🏫', '🏬', '🏭', '🗼', '🗽', '⛪', '🕌', '🛕', '🕍', '⛩️', '🕋', '⛲', '🌍'] },
    objects: { label: '💡', title: 'Objects', emojis: ['⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💽', '💾', '💿', '📀', '🎥', '📷', '📹', '🔍', '🔬', '🔭', '📡', '💡', '🔦', '🏮', '🪔', '📔', '📕', '📖', '📗', '📘', '📙', '📚', '📓', '📒', '📃', '📜', '📄', '📰', '🗞️', '📑', '🔖', '🏷️', '💰', '🪙', '💴', '💵', '💶', '💷', '💸', '💳', '🧾', '💹', '✉️'] },
    symbols: { label: '⚡', title: 'Symbols', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳'] },
    tech: { label: '🤖', title: 'Tech & Work', emojis: ['🤖', '🧠', '💡', '🔧', '🔨', '⚒️', '🛠️', '⚙️', '🧰', '📊', '📈', '📉', '💹', '🎯', '🚀', '⚡', '🔥', '💥', '✨', '🌟', '⭐', '🏆', '🥇', '🥈', '🥉', '🎖️', '🏅', '🎗️', '📝', '✏️', '🖊️', '🖋️', '📌', '📍', '📎', '🖇️', '📐', '📏', '🗂️', '📂', '📁', '🗃️', '🗄️', '🔒', '🔓', '🔐', '🔑', '🗝️', '🛡️', '⚔️'] }
};

interface AvatarPickerProps {
    avatar: string;
    setAvatar: Dispatch<SetStateAction<string>>;
    showEmojiPicker: boolean;
    setShowEmojiPicker: Dispatch<SetStateAction<boolean>>;
    emojiCategory: string;
    setEmojiCategory: Dispatch<SetStateAction<string>>;
    emojiPickerRef: RefObject<HTMLDivElement | null>;
}

/** Reads the chosen image as a data URL; refuses anything over 512 KB. */
function readImage(file: File, onLoad: (dataUrl: string) => void) {
    if (file.size > 512 * 1024) {
        toast.error('Image must be under 512KB');
        return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => onLoad((ev.target as FileReader).result as string);
    reader.readAsDataURL(file);
}

/** The popover: category tabs, the emoji grid, a typed emoji and the image upload. */
function EmojiPopover({ avatar, setAvatar, setShowEmojiPicker, emojiCategory, setEmojiCategory, emojiPickerRef }: Omit<AvatarPickerProps, 'showEmojiPicker'>) {
    const { t } = useTranslation();
    const currentEmojis = EMOJI_CATEGORIES[emojiCategory]?.emojis || EMOJI_CATEGORIES.smileys.emojis;
    return (
        <div ref={emojiPickerRef} className="absolute right-0 top-full z-50 mt-2 w-[400px] max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-xl">
            <div className="flex items-center gap-0.5 border-b border-[var(--border-default)] px-2 py-1.5">
                {Object.entries(EMOJI_CATEGORIES).map(([key, cat]) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setEmojiCategory(key)}
                        className={`flex-1 rounded-md py-1.5 text-sm transition-colors ${emojiCategory === key ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-secondary)]'}`}
                        title={cat.title}
                    >
                        {cat.label}
                    </button>
                ))}
            </div>
            <div className="grid grid-cols-8 gap-0.5 p-2">
                {currentEmojis.map(emoji => (
                    <button
                        key={emoji}
                        type="button"
                        onClick={() => { setAvatar(emoji); setShowEmojiPicker(false); }}
                        className={`flex h-9 w-9 items-center justify-center rounded-md text-xl transition-colors hover:bg-[var(--bg-tertiary)] ${avatar === emoji ? 'bg-[var(--bg-tertiary)] ring-2 ring-[var(--accent-primary)]' : ''}`}
                    >
                        {emoji}
                    </button>
                ))}
            </div>
            <div className="flex items-center gap-2 border-t border-[var(--border-default)] px-3 py-2">
                <input
                    type="text"
                    value={isImageAvatar(avatar) ? '' : avatar}
                    onChange={(e) => setAvatar(e.target.value.slice(-2) || DEFAULT_AGENT_EMOJI)}
                    className={`${FIELD_INPUT} flex-1 py-1 text-center text-xl`}
                    placeholder="🤖"
                    maxLength={2} />
                <input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                    className="hidden"
                    id="agent-avatar-upload"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        readImage(file, (dataUrl) => { setAvatar(dataUrl); setShowEmojiPicker(false); });
                        e.target.value = '';
                    }} />
                <button
                    type="button"
                    onClick={() => document.getElementById('agent-avatar-upload')?.click()}
                    className={SECONDARY_BTN}
                    title={t('agent_studio.identity_upload_an_image_as_avatar', 'Upload an image as avatar')}
                >
                    {t('agent_studio.identity_upload', '📷 Upload')}
                </button>
                <button type="button" onClick={() => setShowEmojiPicker(false)} className={QUIET_BTN}>
                    {t('agent_studio.identity_done', 'Done')}
                </button>
            </div>
        </div>
    );
}

/** The avatar tile (opens the picker) with the popover under it. */
export default function AvatarPicker(props: AvatarPickerProps) {
    const { t } = useTranslation();
    const { avatar, showEmojiPicker, setShowEmojiPicker } = props;
    return (
        <div className="relative flex items-center gap-3">
            <button
                type="button"
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] text-3xl transition-colors hover:bg-[var(--bg-tertiary)]"
                title={t('agent_studio.identity_click_to_change_avatar', 'Click to change avatar')}
            >
                {isImageAvatar(avatar) ? (
                    <img src={resolveAvatarSrc(avatar)} alt="" className="h-full w-full object-cover" />
                ) : (
                    avatar
                )}
            </button>
            <div className="min-w-0 text-xs">
                <p className="m-0 text-[var(--text-secondary)]">{t('agent_studio.identity_click_to_select_an_emoji_or_image', 'Click to select an emoji or image')}</p>
                <p className="m-0 mt-0.5 text-[var(--text-tertiary)]">{t('agent_studio.identity_supports_emoji_png_jpg_or_svg', 'Supports emoji, PNG, JPG, or SVG')}</p>
            </div>
            {showEmojiPicker && <EmojiPopover {...props} />}
        </div>
    );
}
