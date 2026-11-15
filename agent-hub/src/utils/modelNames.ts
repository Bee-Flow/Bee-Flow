// The short name of a model id in the usage reports (Monitoring, Settings >
// Usage): every leading `<provider>/` segment goes, whatever the provider is
// (`anthropic/…`, `azure/<deployment>`, `scaleway/<vendor>/<id>`,
// `ionos/<org>/<id>`, a local runtime's `ollama/…`), and so does a trailing
// dated snapshot (`-2025-01-31`). One helper, so a model reads the same in
// every table, chart and drawer whichever adapter served it.

const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/** The model id without its provider path and dated snapshot; `fallback` when there is none. */
export function shortModelName(model: string | null | undefined, fallback = 'Unknown'): string {
    const id = typeof model === 'string' ? model.trim() : '';
    if (!id) return fallback;
    const slash = id.lastIndexOf('/');
    const name = slash >= 0 ? id.slice(slash + 1) : id;
    return name.replace(DATED_SNAPSHOT, '') || id;
}
