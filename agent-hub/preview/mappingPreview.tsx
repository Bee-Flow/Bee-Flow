/**
 * Mapping preview: renders the real step drawer (NodeDetailView) with fake
 * data, so the mapping UI can be screenshotted without a server or a login.
 * Dev only: open http://localhost:<vite>/mapping-preview.html?s=<scenario>&theme=dark
 * Scenarios live in ./mappingFixture.ts. Not part of the production build.
 * `?view=slots` shows the value-slot building blocks instead (./valueSlotPreview.tsx).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NodeDetailView from '../src/components/automation/Builder/NodeDetailView';
import '../src/index.css';
import { CATALOG, definitionFor } from './mappingFixture';
import { setCurrentUser, setItem as setScopedItem } from '../src/utils/scopedStorage';
import ValueSlotGallery from './valueSlotPreview';

const params = new URLSearchParams(location.search);
setCurrentUser('preview');
// The drawer opens as tall as the page allows (it caps itself at 60%).
setScopedItem('ndvDrawerHeight', '900');
document.documentElement.setAttribute('data-theme', params.get('theme') === 'dark' ? 'dark' : 'light');

// Every request answers from the fixture: the catalog, otherwise an empty object.
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\/(api|auth)\//.test(url)) return realFetch(input, init);
    const body = /\/automation\/catalog(\?|$)/.test(url) ? CATALOG : /forms/.test(url) ? { forms: [] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { definition, step } = definitionFor(params.get('s') || 'empty');
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const noop = () => {};

createRoot(document.getElementById('root')!).render(params.get('view') === 'slots' ? <ValueSlotGallery /> : (
    <QueryClientProvider client={qc}>
        <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <NodeDetailView
                step={step}
                runStep={null}
                runSteps={[]}
                definition={definition}
                rootDefinition={definition}
                automation={{ id: 'preview', definition }}
                catalog={CATALOG}
                onSaveStep={async () => {}}
                validation={{ errors: [], warnings: [] }}
                modelTiers={{}}
                onClose={noop}
            />
        </div>
    </QueryClientProvider>
));
