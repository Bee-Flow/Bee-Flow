import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProjectWorkspacePage from './src/components/projects/workspace/ProjectWorkspacePage';
import './src/index.css';
import './src/tailwind-utilities.css';
import { setCurrentUser } from './src/utils/scopedStorage';

setCurrentUser('u-owner');
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function ProjectPreview() {
    const [searchOpen, setSearchOpen] = useState(false);
    return (
        <div className="h-dvh">
            <ProjectWorkspacePage projectId="p1" user={{ id: 'u-owner', name: 'Olivia Owner' }}
                initialTab={new URLSearchParams(location.search).get('tab') || 'overview'}
                searchOpen={searchOpen} onSearchOpenChange={setSearchOpen}
                onClose={() => {}} onNavigate={() => {}} onStartChat={() => {}} onOpenThread={() => {}} />
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={qc}><ProjectPreview /></QueryClientProvider>);
