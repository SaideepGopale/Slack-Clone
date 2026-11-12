import { Lock, SearchX } from 'lucide-react';
import { ReactNode } from 'react';
import type { ApiError } from '../../lib/api';
import { EmptyState, ErrorState } from '../ui';

interface AccessProblemProps {
  error: ApiError;
  /** e.g. "organization", "workspace" */
  resource: string;
  onRetry?: () => void;
  action?: ReactNode;
}

/**
 * Renders a failed admin request the way the backend's privacy rules intend:
 *  - 404: the resource doesn't exist OR the caller may not know it exists —
 *    one message for both, so nothing is revealed;
 *  - 403: the caller can see it but lacks the permission;
 *  - anything else: a retryable error.
 */
export const AccessProblem = ({ error, resource, onRetry, action }: AccessProblemProps) => {
  if (error.isNotFound) {
    return (
      <EmptyState
        icon={<SearchX size={28} aria-hidden="true" />}
        title={`${resource[0].toUpperCase()}${resource.slice(1)} not found`}
        description={`This ${resource} doesn't exist, or you don't have access to it.`}
        action={action}
      />
    );
  }
  if (error.isForbidden) {
    return (
      <EmptyState
        icon={<Lock size={28} aria-hidden="true" />}
        title="You don't have permission"
        description={error.message || `You don't have permission to manage this ${resource}.`}
        action={action}
      />
    );
  }
  return <ErrorState title={`Couldn't load this ${resource}`} message={error.message} onRetry={onRetry} />;
};
