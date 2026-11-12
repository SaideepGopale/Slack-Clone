import { ChevronRight } from 'lucide-react';
import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { focusRing } from '../ui';

export interface Crumb {
  label: string;
  to?: string;
}

interface PageFrameProps {
  title: string;
  /** Small context line above the title (e.g. "Organization"). */
  eyebrow?: string;
  crumbs?: Crumb[];
  badges?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Shared frame for the organization / workspace administration pages (F2):
 * breadcrumb navigation, one h1, an action area that wraps on small screens,
 * and a readable, scrollable content column inside WorkspaceLayout's <main>.
 */
export const PageFrame = ({ title, eyebrow, crumbs = [], badges, actions, children }: PageFrameProps) => (
  <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface">
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full px-4 py-6 md:px-8 md:py-8">
        {crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-3">
            <ol className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
              {crumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1 min-w-0">
                  {index > 0 && <ChevronRight size={12} aria-hidden="true" className="text-fg-subtle shrink-0" />}
                  {crumb.to ? (
                    <Link to={crumb.to} className={`truncate hover:text-brand hover:underline rounded ${focusRing}`}>
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="truncate" aria-current="page">
                      {crumb.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
          <div className="min-w-0">
            {eyebrow && <p className="text-[11px] font-bold uppercase tracking-widest text-fg-subtle mb-1">{eyebrow}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-fg tracking-tight break-words">{title}</h1>
              {badges}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  </div>
);

/** A titled card section used inside admin tabs. */
export const Section = ({ title, description, children, tone = 'default' }: { title: string; description?: ReactNode; children: ReactNode; tone?: 'default' | 'danger' }) => (
  <section
    aria-label={title}
    className={`rounded-2xl border p-4 md:p-6 ${tone === 'danger' ? 'border-danger/30 bg-danger-soft/40' : 'border-line bg-surface'}`}
  >
    <h2 className={`text-base font-semibold tracking-tight ${tone === 'danger' ? 'text-danger' : 'text-fg'}`}>{title}</h2>
    {description && <p className="text-sm text-fg-muted mt-1">{description}</p>}
    <div className="mt-4">{children}</div>
  </section>
);
