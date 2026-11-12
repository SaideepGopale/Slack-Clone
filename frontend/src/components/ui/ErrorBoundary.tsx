import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, ErrorInfo, ReactNode } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Button } from './Button';

/**
 * T.32 (audit M22): a render error no longer replaces the whole app with a
 * blank page or React Router's developer screen. `RouteErrorScreen` is the
 * router's errorElement; `ErrorBoundary` wraps smaller regions (a message
 * list, a panel) so one bad item cannot take the rest of the screen down.
 * No error details are shown to users; they go to the console.
 */
const ErrorPanel = ({ title, body, onRetry, fullPage }: { title: string; body: string; onRetry: () => void; fullPage?: boolean }) => (
  <div role="alert" className={`flex items-center justify-center bg-surface-secondary px-4 ${fullPage ? 'min-h-screen' : 'h-full min-h-[240px]'}`}>
    <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 text-center shadow-sm">
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle size={18} aria-hidden="true" />
      </span>
      <h1 className="text-base font-semibold text-fg">{title}</h1>
      <p className="mt-1 text-sm text-fg-muted">{body}</p>
      <div className="mt-5 flex justify-center gap-2">
        {fullPage && (
          <Button variant="secondary" size="sm" onClick={() => window.location.assign('/')}>
            Go to start
          </Button>
        )}
        <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  </div>
);

export const RouteErrorScreen = () => {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <ErrorPanel fullPage title="Page not found" body="This page does not exist or has moved." onRetry={() => window.location.assign('/')} />;
  }
  // A failed lazy chunk after a new deployment: reloading fetches the new build.
  const chunkFailed = error instanceof Error && /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message);
  if (!chunkFailed) console.error('Unhandled route error:', error);
  return (
    <ErrorPanel
      fullPage
      title={chunkFailed ? 'SmartConnect was updated' : 'Something went wrong'}
      body={chunkFailed ? 'Reload to get the latest version.' : 'This screen hit an unexpected problem. Your data is safe.'}
      onRetry={() => window.location.reload()}
    />
  );
};

interface BoundaryProps {
  children: ReactNode;
  /** Short label of the region, e.g. "messages". */
  region?: string;
  /** Changing this resets the boundary (e.g. the channel id). */
  resetKey?: unknown;
}

export class ErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Render error in ${this.props.region ?? 'a region'}:`, error, info.componentStack);
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ErrorPanel
        title={`Couldn’t show ${this.props.region ?? 'this section'}`}
        body="Something unexpected happened here. The rest of SmartConnect still works."
        onRetry={() => this.setState({ failed: false })}
      />
    );
  }
}
