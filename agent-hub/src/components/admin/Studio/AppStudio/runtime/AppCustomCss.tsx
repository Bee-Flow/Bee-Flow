/**
 * The place where an app's own stylesheet is mounted.
 *
 * Every host that draws an app renders this once: AppShell (the run view and the editor
 * preview), the public page, the headless screen and the editor canvas. There is no app
 * stylesheet yet, so it renders nothing; whatever adds one changes this file only.
 */
export default function AppCustomCss(_props: { definition?: { [key: string]: unknown } | null }): null {
    return null;
}
