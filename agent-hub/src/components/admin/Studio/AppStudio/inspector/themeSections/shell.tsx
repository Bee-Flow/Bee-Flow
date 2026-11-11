import { Plus, Trash2 } from 'lucide-react';
import Button from '@/components/shared/Button';
import FormField from '@/components/shared/FormField';
import Toggle from '@/components/shared/Toggle';
import useTranslation from '@/hooks/useTranslation';
import { SectionTitle } from '../AiBrowsingSettings';
import AssetRefField from '../assets/AssetRefField';
import { INPUT_CLS } from '../panels/kit';
import { useEditorChrome } from '../../editor/EditorChromeContext';
import { shellOptions, type ShellBrand, type ShellItem } from '../../runtime/shell/shellOptions';
import { updateNav } from '../../state/definitionOps';
import type { AppDefinition } from '../appDefinition';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';

/**
 * Theme panel: "Shell" — the shell options of definition.nav (schema 3,
 * runtime/shell/shellOptions.ts): a hidden top bar, the app's own links, a footer line and the
 * brand. The nav style itself (including "None") is the Navigation control above. A field
 * that is emptied removes its key, so an app whose shell options are all cleared is again the
 * app it was.
 */

const MAX_ITEMS = 10;
const URL_TARGET = '__url__';
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function newItemId(): string {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return `nvi_${[...bytes].map((b) => ID_CHARS[b % ID_CHARS.length]).join('')}`;
}

type NavPatch = Record<string, unknown>;

interface ItemRowProps {
    item: ShellItem & { url?: string };
    screens: Array<{ id: string; name?: string }>;
    disabled: boolean;
    onChange: (item: ShellItem) => void;
    onRemove: () => void;
}

function ItemRow({ item, screens, disabled, onChange, onRemove }: ItemRowProps) {
    const { t } = useTranslation();
    const target = item.screenId ?? URL_TARGET;
    const setTarget = (value: string) => {
        const { screenId: _s, url: _u, ...rest } = item;
        onChange(value === URL_TARGET ? { ...rest, url: '' } : { ...rest, screenId: value });
    };
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-default)] p-2" data-app-shell-item={item.id}>
            <div className="flex items-center gap-1.5">
                <input
                    className={INPUT_CLS}
                    value={item.label}
                    maxLength={40}
                    disabled={disabled}
                    aria-label={t('studio_apps_lk18.item_label', 'Link text')}
                    placeholder={t('studio_apps_lk18.item_label', 'Link text')}
                    onChange={(e) => onChange({ ...item, label: e.target.value })}
                />
                <Button size="sm" variant="ghost" icon={Trash2} disabled={disabled} onClick={onRemove} aria-label={t('studio_apps_lk18.item_remove', 'Remove link')} />
            </div>
            <select
                className={INPUT_CLS}
                value={target}
                disabled={disabled}
                aria-label={t('studio_apps_lk18.item_target', 'Opens')}
                onChange={(e) => setTarget(e.target.value)}
            >
                {screens.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
                <option value={URL_TARGET}>{t('studio_apps_lk18.item_web', 'A web address')}</option>
            </select>
            {target === URL_TARGET ? (
                <input
                    className={INPUT_CLS}
                    value={item.url ?? ''}
                    disabled={disabled}
                    spellCheck={false}
                    placeholder="https://"
                    aria-label={t('studio_apps_lk18.item_url', 'Web address')}
                    onChange={(e) => onChange({ ...item, url: e.target.value.trim() })}
                />
            ) : null}
        </div>
    );
}

function ItemsField({ definition, items, disabled, commit }: { definition: AppDefinition; items: ShellItem[]; disabled: boolean; commit: (patch: NavPatch) => void }) {
    const { t } = useTranslation();
    const screens = ((definition.screens || []) as Array<{ id: string; name?: string }>).filter((s) => s && typeof s.id === 'string');
    const stored = Array.isArray((definition.nav as { items?: unknown } | undefined)?.items) ? (definition.nav as { items: ShellItem[] }).items : items;
    const write = (next: ShellItem[]) => commit({ items: next.length ? next : null });
    const add = () => write([...stored, screens[0] ? { id: newItemId(), label: '', icon: null, screenId: screens[0].id } : { id: newItemId(), label: '', icon: null, url: '' }]);
    return (
        <FormField label={t('studio_apps_lk18.items', 'Links')} hint={t('studio_apps_lk18.items_hint', 'Shown after the screens. A web address opens in a new tab.')}>
            <div className="flex flex-col gap-2">
                {stored.map((item, i) => (
                    <ItemRow
                        key={item.id}
                        item={item}
                        screens={screens}
                        disabled={disabled}
                        onChange={(next) => write(stored.map((it, j) => (j === i ? next : it)))}
                        onRemove={() => write(stored.filter((_, j) => j !== i))}
                    />
                ))}
                <div>
                    <Button size="sm" variant="secondary" icon={Plus} disabled={disabled || stored.length >= MAX_ITEMS} onClick={add}>
                        {t('studio_apps_lk18.item_add', 'Add a link')}
                    </Button>
                </div>
            </div>
        </FormField>
    );
}

function BrandFields({ definition, brand, disabled, commit }: { definition: AppDefinition; brand: ShellBrand | null; disabled: boolean; commit: (patch: NavPatch) => void }) {
    const { t } = useTranslation();
    const appId = useEditorChrome()?.appId ?? null;
    const write = (next: ShellBrand) => {
        const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== null && v !== ''));
        commit({ brand: Object.keys(clean).length ? clean : null });
    };
    const current = brand || {};
    return (
        <>
            <FormField label={t('studio_apps_lk18.brand_name', 'Name in the shell')} hint={t('studio_apps_lk18.brand_name_hint', 'Empty shows the app name.')}>
                <input className={INPUT_CLS} value={current.name ?? ''} maxLength={60} disabled={disabled} aria-label={t('studio_apps_lk18.brand_name', 'Name in the shell')} onChange={(e) => write({ ...current, name: e.target.value })} />
            </FormField>
            <AssetRefField
                label={t('studio_apps_lk18.brand_logo', 'Logo in the shell')}
                hint={t('studio_apps_lk18.brand_logo_hint', 'Empty shows the logo of the design, or the app icon.')}
                value={current.logo ?? null}
                onChange={(logo) => write({ ...current, logo: logo ?? undefined })}
                appId={appId}
                definition={definition}
                placeholder="https://"
                disabled={disabled}
            />
            <Toggle
                checked={current.showName !== false}
                onChange={(next) => write({ ...current, showName: next ? undefined : false })}
                label={t('studio_apps_lk18.brand_show_name', 'Show the name next to the logo')}
                size="sm"
                disabled={disabled}
            />
        </>
    );
}

function ShellSection({ definition, onCommit, disabled }: ThemeSectionProps) {
    const { t } = useTranslation();
    const opts = shellOptions(definition as never);
    const commit = (patch: NavPatch) => {
        const def = updateNav(definition, patch);
        if (def !== definition) onCommit(def);
    };
    return (
        <div data-testid="app-shell-settings">
            <SectionTitle>{t('studio_apps_lk18.title', 'Shell')}</SectionTitle>
            <div className="flex flex-col gap-3">
                <Toggle
                    checked={opts.headerHidden}
                    onChange={(next) => commit({ header: next ? 'hidden' : null })}
                    label={t('studio_apps_lk18.header_hidden', 'Hide the top bar')}
                    description={t('studio_apps_lk18.header_hidden_hint', 'The screen starts at the top. A small corner keeps the screen menu and the user menu.')}
                    size="sm"
                    disabled={disabled}
                />
                <ItemsField definition={definition} items={opts.items} disabled={disabled} commit={commit} />
                <FormField label={t('studio_apps_lk18.footer', 'Footer line')} hint={t('studio_apps_lk18.footer_hint', 'Plain text under every screen, at most 120 characters.')}>
                    <input
                        className={INPUT_CLS}
                        value={typeof (definition.nav as { footerText?: unknown } | undefined)?.footerText === 'string' ? String((definition.nav as { footerText: string }).footerText) : ''}
                        maxLength={120}
                        disabled={disabled}
                        aria-label={t('studio_apps_lk18.footer', 'Footer line')}
                        onChange={(e) => commit({ footerText: e.target.value || null })}
                    />
                </FormField>
                <BrandFields definition={definition} brand={opts.brand} disabled={disabled} commit={commit} />
                <p className="text-[11px] text-[var(--text-secondary)]">{t('studio_apps_lk18.public_note', 'A public page shows none of this: it has no navigation of its own.')}</p>
            </div>
        </div>
    );
}

const entry: ThemeSectionEntry = { order: 20, Section: ShellSection };

export default entry;
