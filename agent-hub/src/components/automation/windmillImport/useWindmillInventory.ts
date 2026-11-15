import { useQuery } from '@tanstack/react-query';
import { fetchWindmillInventory } from '@/api/windmillImport';

const windmillInventoryKey = ['automation', 'import', 'windmill', 'inventory'] as const;

/**
 * The Windmill flows that listen to this Nextcloud (api/windmillImport.ts),
 * shared by the inventory panel and the import report, so both read one answer.
 */
export default function useWindmillInventory() {
    return useQuery({ queryKey: windmillInventoryKey, queryFn: fetchWindmillInventory, staleTime: 60_000 });
}
