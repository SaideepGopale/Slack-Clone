import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import type { OneTimeCredentials } from '../../lib/api/teamManagement';
import { Button, IconButton } from './Button';
import { Modal } from './Modal';

/**
 * One-time account credentials (Stage 2 Team Leads, Stage 3 Members): the
 * single-use activation link, the login and the temporary password, shown
 * exactly once — they live only in the caller's state while this is open and
 * cannot be fetched again (the server keeps only hashes).
 */

const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const invitationText = (credentials: OneTimeCredentials, intro: string) =>
  [
    intro,
    '',
    `Activation link: ${credentials.activationUrl}`,
    `Login: ${credentials.loginId}`,
    `Temporary password: ${credentials.temporaryPassword}`,
    '',
    `Open the link, enter the temporary password and choose your own password, then sign in with your login.`,
    `The link and temporary password work once and expire on ${formatDate(credentials.expiresAt)}.`,
  ].join('\n');

const CredentialRow = ({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-1">
      <div className="text-xs font-bold text-fg-muted">{label}</div>
      <div className="flex items-start gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-surface-secondary border border-line px-3 py-2 text-sm text-fg select-all">{value}</code>
        <IconButton label={copied ? `${copyLabel} (copied)` : copyLabel} icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={copy} variant="secondary" />
      </div>
    </div>
  );
};

export const OneTimeCredentialsModal = ({
  title,
  subtitle,
  intro,
  credentials,
  onClose,
}: {
  title: string;
  subtitle: string;
  /** First line of the copied message, e.g. "You've been added to SmartConnect as a Team Lead." */
  intro: string;
  credentials: OneTimeCredentials;
  onClose: () => void;
}) => {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(invitationText(credentials, intro));
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={copyAll} icon={copied === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}>
            Copy invitation
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm rounded-xl px-3 py-2 bg-warning-soft text-warning font-semibold">
          This is the only time the temporary password and link are shown. Copy them now — they cannot be retrieved later.
        </p>
        <CredentialRow label="Activation link" value={credentials.activationUrl} copyLabel="Copy link" />
        <CredentialRow label="Login" value={credentials.loginId} copyLabel="Copy login" />
        <CredentialRow label="Temporary password" value={credentials.temporaryPassword} copyLabel="Copy temporary password" />
        <p className="text-xs text-fg-subtle">
          Single use. Expires {formatDate(credentials.expiresAt)}. The temporary password does not work on the sign-in page — only on the activation link.
        </p>
        {copied !== 'idle' && (
          <p role="status" className={`text-xs font-semibold ${copied === 'copied' ? 'text-success' : 'text-danger'}`}>
            {copied === 'copied' ? 'Invitation copied to the clipboard.' : 'Copying failed — select the values above and copy them manually.'}
          </p>
        )}
      </div>
    </Modal>
  );
};
