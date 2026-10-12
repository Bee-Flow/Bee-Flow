import { Globe } from 'lucide-react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { useRuntime } from '../RuntimeContext';
import { useBrowserRun } from '../BrowserRunContext';

/**
 * App Studio runtime — 'browser_view'. Spec: server/appStudio/componentSpecs.js.
 *
 * Renders the live screenshot stream while an ai_browse step of the wired
 * action (`props.actionId`) runs. Adapted from the chat BrowserLivePreview:
 * a plain <img> swapped on each throttled JPEG frame — frames are never
 * accumulated and never persisted, so idle (and after a reload) it shows a
 * placeholder; the answer lives in the step's resultVar, not here.
 */

const ASPECT = { '16:10': '16 / 10', '16:9': '16 / 9', '4:3': '4 / 3' };

export default function AppBrowserView({ node }) {
    const { t } = useTranslation();
    const { mode } = useRuntime();
    const { previews } = useBrowserRun();
    const props = node.props || {};
    const actionId = props.actionId || '';
    const aspectRatio = ASPECT[props.aspect] || ASPECT['16:10'];
    const preview = actionId ? previews[actionId] : null;
    const editing = mode !== 'run';

    const frame = preview?.frame || null;
    const ended = preview?.ended;
    const queued = preview?.queued;
    const action = preview?.action;
    const label = preview?.url || preview?.task || t('studio_apps_runtime.browser_view.browsing', 'Browsing…');

    return (
        <div
            className="overflow-hidden w-full border"
            style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-tertiary)' }}
            data-app-browser-view={actionId || 'unbound'}
        >
            <div
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs truncate border-b"
                style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)' }}
            >
                <Globe className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{preview ? label : t('studio_apps_runtime.browser_view.live_browser', 'Live browser')}</span>
                {ended && <span className="ml-auto flex-shrink-0 opacity-70">{t('studio_apps_runtime.browser_view.done', 'done')}</span>}
            </div>

            {frame ? (
                <img
                    src={`data:image/jpeg;base64,${frame}`}
                    alt={t('studio_apps_runtime.browser_view.preview_alt', 'Live browser preview')}
                    className="w-full h-auto block"
                    style={{ opacity: ended ? 0.75 : 1 }}
                />
            ) : (
                <div
                    className="flex items-center justify-center text-center px-4 text-sm"
                    style={{ aspectRatio, color: 'var(--text-secondary)' }}
                >
                    {editing
                        ? (props.emptyText || t('studio_apps_runtime.browser_view.empty', 'The live browser appears here while the agent works.'))
                        : queued
                            ? (preview?.queuePosition
                                ? t('studio_apps_runtime.browser_view.waiting_ahead', 'Waiting for an available browser ({n} ahead)…', { n: preview.queuePosition })
                                : t('studio_apps_runtime.browser_view.waiting', 'Waiting for an available browser…'))
                            : preview
                                ? t('studio_apps_runtime.browser_view.opening', 'Opening the browser…')
                                : (props.emptyText || t('studio_apps_runtime.browser_view.empty', 'The live browser appears here while the agent works.'))}
                </div>
            )}

            {!ended && action && frame && (
                <div
                    className="px-2.5 py-1 text-xs truncate border-t"
                    style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)' }}
                >
                    {action}
                </div>
            )}
        </div>
    );
}
