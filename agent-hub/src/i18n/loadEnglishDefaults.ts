import { namespacesForPath } from '../demo/demoNamespaces';
import { loadEnNamespaces } from './enNamespaces';

/**
 * The English catalogue for the document that is open. A public feature demo
 * (/__demo__/<id>) is its own document and renders a known set of screens, so
 * it loads just their namespaces; everything else loads the full 3.9 MB file.
 */
export function loadEnglishDefaults(): Promise<Record<string, unknown>> {
    const scoped = typeof window !== 'undefined' ? namespacesForPath(window.location.pathname) : undefined;
    if (scoped) return loadEnNamespaces(scoped);
    return import('./en-defaults').then((m) => m.default || {});
}
