/**
 * Open a library document from a chat message: in the right side panel when
 * there is one (useSidePanelState answers the event with preventDefault),
 * otherwise on its own page. Used by the generated-file card and by an
 * uploaded spreadsheet's attachment chip.
 */
export function openLibraryDocument(id: string): void {
    const href = `/app/studio/documents/${id}`;
    const evt = new CustomEvent('beeflow:open-document-side', { detail: { id, href }, cancelable: true });
    if (!window.dispatchEvent(evt)) return;
    window.history.pushState({ page: 'studio' }, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'studio' } }));
}
