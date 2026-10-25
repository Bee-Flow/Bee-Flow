import {
    Activity, AppWindow, Bell, BellRing, Bot, Calendar, ClipboardList, Clock, FilePen, FilePlus, FileUp,
    LogIn, Mail, MousePointer2, Share2, Tag, Webhook, Zap,
    type LucideIcon,
} from 'lucide-react';
import type { TriggerLike } from './triggerLabels';

/**
 * The one place that knows what a trigger LOOKS like: kind → lucide glyph,
 * and a finer glyph per (provider, event) for app events. The canvas trigger
 * card, the automations overview and the sidebar all draw from this map, so
 * a schedule is the same clock everywhere. Names stay in ./triggerLabels.
 */
const TRIGGER_KIND_ICON: Readonly<Record<string, LucideIcon>> = Object.freeze({
    schedule:    Clock,
    manual:      MousePointer2,
    webhook:     Webhook,
    app_event:   Zap,
    agent_call:  Bot,
    layer_input: LogIn,
    app_trigger: AppWindow,
    form:        ClipboardList,
});

/** Sub-icon per (provider, event): a Gmail-new-email trigger gets a Mail glyph, not the generic bolt. */
const APP_EVENT_ICON: Readonly<Record<string, LucideIcon>> = Object.freeze({
    'gmail.mail.new':                  Mail,
    'gmail.label.added':               Tag,
    'google-calendar.event.changed':   Calendar,
    'google-calendar.event.upcoming':  BellRing,
    'google-drive.file.new':           FileUp,
    'nextcloud.file.new':              FilePlus,
    'nextcloud.file.changed':          FilePen,
    'nextcloud.share.received':        Share2,
    'nextcloud.activity.new':          Activity,
    'nextcloud.notification.new':      Bell,
});

/**
 * Every trigger glyph in one map, keyed by `triggerIconKey`. Components look
 * the glyph up here (`TRIGGER_ICONS[triggerIconKey(t)]`) rather than calling a
 * function that returns a component, which react-hooks/static-components
 * cannot tell from a component created during render.
 */
export const TRIGGER_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
    ...TRIGGER_KIND_ICON,
    ...APP_EVENT_ICON,
    'mail': Mail,
    'fallback': Zap,
});

/** Which TRIGGER_ICONS entry a trigger wears: its (provider, event), a mail glyph for any mail event, else its kind. */
export function triggerIconKey(trigger: TriggerLike | null | undefined): string {
    const kind = trigger?.kind || 'manual';
    const ev = kind === 'app_event' ? trigger?.appEvent : null;
    if (ev?.provider && ev.event) {
        const key = `${ev.provider}.${ev.event}`;
        if (APP_EVENT_ICON[key]) return key;
        if (/^mail\./.test(ev.event)) return 'mail';
    }
    return TRIGGER_KIND_ICON[kind] ? kind : 'fallback';
}
