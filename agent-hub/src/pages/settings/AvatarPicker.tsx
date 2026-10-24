import React, { useState, useRef, useCallback } from 'react';
import { toast } from '../../components/shared/Toast';
import useOutsideDismiss from '../../hooks/useOutsideDismiss';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE } from '../../utils/helpers';
import { AvatarDisplay } from '../AdvancedSettings';
import type { PreferencesUser } from './PreferencesSection.types';
import { mutate, ApiError } from '../../api/mutate';

// ── Emoji picker data ────────────────────────────────────────────────────────
const EMOJI_CATEGORIES = [
    { label: '😀', emojis: ['😀', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🥶', '🤯'] },
    { label: '🧑', emojis: ['🧑', '👩', '👨', '🧔', '👱', '👮', '🕵️', '💂', '👷', '🤴', '👸', '🧙', '🧛', '🧟', '🧞', '🧜', '🧚', '👼', '🎅', '🤶', '🦸', '🦹', '🤺', '🏇', '⛷️', '🏂', '🏋️', '🤼', '🤸', '🤾'] },
    { label: '🐶', emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦅', '🦉', '🦋', '🐛', '🐌', '🐜', '🐝', '🐞', '🦎', '🐍', '🐢', '🦕'] },
    { label: '🌟', emojis: ['⚡', '🔥', '💧', '🌊', '🌈', '❄️', '🌪️', '🌙', '☀️', '⭐', '🌟', '💥', '🎯', '🏆', '🥇', '🎖️', '🏅', '🎗️', '💎', '🔮', '🪄', '🎲', '🎰', '🎭', '🎨', '🎬', '🔭', '🔬', '💡', '⚙️'] },
    { label: '🤖', emojis: ['🤖', '👾', '👻', '💀', '☠️', '👽', '🦄', '🐉', '🐲', '🦖', '🦕', '🦑', '🐙', '🦂', '🦠', '🧫', '🧪', '🌀', '🔑', '🗝️', '🔓', '🔐', '🔒', '🔏', '🛡️', '⚔️', '🪃', '🏹', '🪓', '🔧'] },
    { label: '🍎', emojis: ['🍎', '🍊', '🍋', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🫒', '🥑', '🍆', '🥦', '🌽', '🥕', '🧄', '🧅', '🫘', '🥜', '🌰', '🍞', '🥐', '🥖', '🧀', '🍔', '🍕'] },
];

interface AvatarPickerProps {
    user: PreferencesUser;
    onSaved: (avatar: string | null, avatarType: string | null) => void;
}

const AvatarPicker = ({ user, onSaved }: AvatarPickerProps) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState(0);
    const [saving, setSaving] = useState(false);
    const [customEmoji, setCustomEmoji] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    useOutsideDismiss(popoverRef, () => setOpen(false), { enabled: open, escape: false, defer: false });

    // One save path for the three actions. The new avatar is applied (and the
    // picker closed) only once the server stored it; a refusal or a network
    // error keeps the picker open and says the save failed.
    const save = useCallback(async (avatar: string | null, avatarType: string | null) => {
        setSaving(true);
        try {
            try {
                await mutate(`${API_BASE}/auth/update-profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatar, avatarType }),
            });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error(`HTTP ${err.status}`);
            }
            onSaved(avatar, avatarType);
            setOpen(false);
        } catch {
            toast.error(t('common.save_failed', 'Save failed'));
        } finally {
            setSaving(false);
        }
    }, [onSaved, t]);

    const pickEmoji = (emoji: string) => save(emoji, 'emoji');

    const handleImage = (e: React.ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';   // so picking the same file again after a failed save fires onChange
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => { save((ev.target as FileReader).result as string, 'url'); };
        reader.readAsDataURL(file);
    };

    const removeAvatar = () => save(null, null);

    return (
        <div className="relative" ref={popoverRef}>
            <button
                onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
                className="relative group cursor-pointer"
                type="button"
                aria-label={t('settings.avatar_alt', 'Avatar')}
                aria-expanded={open}
            >
                <AvatarDisplay user={user} size={64} />
                <div className="absolute inset-0 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity [background:rgba(0,0,0,0.4)]">
                    <svg fill="none" stroke="white" viewBox="0 0 24 24" className="w-[14px] h-[14px]">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                </div>
            </button>

            {open && (
                <div
                    className="absolute left-0 top-[72px] z-50 rounded-xl w-[300px] [background:var(--bg-card)] [border:1px_solid_var(--border-default)] [box-shadow:var(--shadow-lg)]"
                    onClick={e => e.stopPropagation()}
                >
                    <div className="flex items-center px-2 pt-2 pb-1 gap-0.5 [border-bottom:1px_solid_var(--border-subtle)]">
                        {EMOJI_CATEGORIES.map((cat, i) => (
                            <button key={i} onClick={() => setTab(i)} type="button"
                                className="flex-1 flex items-center justify-center py-1.5 rounded-md transition-colors text-base"
                                style={{ background: tab === i ? 'var(--bg-tertiary)' : 'transparent' }}>
                                {cat.label}
                            </button>
                        ))}
                    </div>
                    <div className="p-2 grid grid-cols-8 gap-0.5 max-h-[180px] [overflow-y:auto]">
                        {EMOJI_CATEGORIES[tab].emojis.map((em, i) => (
                            <button key={i} type="button" onClick={() => pickEmoji(em)}
                                className="text-xl w-8 h-8 flex items-center justify-center rounded-md hover:bg-[var(--bg-tertiary)] transition-colors leading-none cursor-pointer"
                                disabled={saving}>{em}
                            </button>
                        ))}
                    </div>
                    <div className="px-2.5 pb-2.5 pt-2 flex flex-col gap-2 [border-top:1px_solid_var(--border-subtle)]">
                        <div className="flex gap-1.5">
                            <input value={customEmoji} onChange={e => setCustomEmoji(e.target.value)}
                                placeholder={t('settings.avatar.paste_emoji', 'Paste any emoji…')}
                                className="flex-1 px-2.5 py-1.5 rounded-lg border outline-none text-sm [background:var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                                onKeyDown={e => { if (e.key === 'Enter' && customEmoji.trim()) pickEmoji(customEmoji.trim()); }}
                            />
                            <button onClick={() => customEmoji.trim() && pickEmoji(customEmoji.trim())} type="button"
                                disabled={!customEmoji.trim() || saving}
                                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-40 bg-[var(--accent-primary)]">{t('settings.avatar.use', 'Use')}</button>
                        </div>
                        <div className="flex items-center justify-between">
                            <div className="flex gap-1.5">
                                <button onClick={() => fileRef.current?.click()} type="button"
                                    className="text-xs px-2.5 py-1 rounded-md transition-colors bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{t('settings.avatar.upload_image', '📁 Upload image')}</button>
                                {user?.avatar && (
                                    <button onClick={removeAvatar} type="button" disabled={saving}
                                        className="text-xs px-2.5 py-1 rounded-md transition-colors hover:bg-red-500/10 [color:#f87171]!">{t('settings.avatar.remove', 'Remove')}</button>
                                )}
                            </div>
                            <button onClick={() => setOpen(false)} type="button"
                                className="text-xs px-2.5 py-1 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-muted)]">{t('settings.avatar.done', 'Done')}</button>
                        </div>
                        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleImage} />
                    </div>
                </div>
            )}
        </div>
    );
};

export default AvatarPicker;
