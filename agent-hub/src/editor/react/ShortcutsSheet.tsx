/**
 * ShortcutsSheet — every keyboard shortcut of the editor, read from the same
 * catalogue the key handler uses (shortcuts.ts), with the keys this platform
 * shows (⌘ on Apple devices, Ctrl elsewhere).
 */
import { Fragment } from 'react';
import Modal from '../../components/shared/Modal';
import useTranslation from '../../hooks/useTranslation';
import { SHORTCUTS, keyLabel, isApplePlatform, type ShortcutDef } from './shortcuts';

interface Props {
    open: boolean;
    onClose: () => void;
}

const GROUPS: Array<{ id: ShortcutDef['group']; key: string; label: string }> = [
    { id: 'text', key: 'editor.shortcuts_group_text', label: 'Text' },
    { id: 'blocks', key: 'editor.shortcuts_group_blocks', label: 'Blocks' },
    { id: 'document', key: 'editor.shortcuts_group_document', label: 'Document' },
];

export default function ShortcutsSheet({ open, onClose }: Props) {
    const { t } = useTranslation();
    const apple = isApplePlatform();
    return (
        <Modal open={open} onClose={onClose} title={t('editor.shortcuts_title', 'Keyboard shortcuts')} size="md">
            <div className="grid gap-4 sm:grid-cols-2">
                {GROUPS.map((g) => (
                    <section key={g.id} aria-labelledby={`bf-shortcuts-${g.id}`}>
                        <h3 id={`bf-shortcuts-${g.id}`} className="text-[11px] font-semibold uppercase tracking-wide mb-1.5 text-[var(--text-tertiary)]">
                            {t(g.key, g.label)}
                        </h3>
                        <dl className="flex flex-col gap-1">
                            {SHORTCUTS.filter((s) => s.group === g.id).map((s) => (
                                <div key={s.labelKey} className="flex items-center justify-between gap-3 text-xs">
                                    <dt className="text-[var(--text-secondary)]">{t(s.labelKey, s.label)}</dt>
                                    <dd className="flex items-center gap-0.5 shrink-0">
                                        {s.keys.map((k, i) => (
                                            <Fragment key={`${k}-${i}`}>
                                                <kbd className="bf-kbd">{keyLabel(k, apple)}</kbd>
                                            </Fragment>
                                        ))}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </section>
                ))}
            </div>
        </Modal>
    );
}
