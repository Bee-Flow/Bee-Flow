import SettingsPage from './settings/SettingsPage';
import type { SettingsPageProps } from './settings/SettingsPage';

/**
 * The builder's Settings tab. A thin shell: the page itself (table of
 * contents, sections, readiness rail) lives in `settings/SettingsPage.tsx`,
 * one file per section beside it. Kept under this name so BuilderShell and
 * the tests that mock './SettingsTab' keep their seam.
 */
export default function SettingsTab(props: SettingsPageProps) {
    return <SettingsPage {...props} />;
}
