import { useEffect, useState } from 'react';
import { teamManagementApi } from '../lib/api';
import type { Hierarchy } from '../lib/api/teamManagement';

/**
 * Stage 3 (T.22): the signed-in account's company level (Company Admin, Team
 * Lead or Member) and what the UI may offer. Hints only — the server enforces
 * every action. null while loading or if it could not be loaded, so callers
 * decide their own fallback.
 */
export const useHierarchy = (): Hierarchy | null => {
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  useEffect(() => {
    let alive = true;
    teamManagementApi
      .myHierarchy()
      .then((value) => alive && setHierarchy(value))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return hierarchy;
};
