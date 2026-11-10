import { Check, Copy, Send } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { formatDate } from '../../lib/adminAccess';
import { errorMessage, invitationsApi } from '../../lib/api';
import { Button, Field, Modal, Spinner, TextInput } from '../ui';

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * "Invite People" (shown only to people who may manage invitations — server
 * capability). F2: accessible dialog with both supported ways in:
 *  - an e-mail invitation bound to one address (its token is never shown);
 *  - the shareable invite link, whose users wait for approval.
 */
export const InviteMemberModal = ({ isOpen, onClose, workspaceId }: InviteMemberModalProps) => {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLink(null);
    setLinkError(null);
    setCopied(false);
    setEmail('');
    setEmailError(null);
    setLinkLoading(true);
    let cancelled = false;
    invitationsApi
      .getInviteLink(workspaceId)
      .then((res) => !cancelled && setLink(res))
      .catch((err) => !cancelled && setLinkError(errorMessage(err, 'Failed to generate invite link.')))
      .finally(() => !cancelled && setLinkLoading(false));
    return () => {
      cancelled = true;
    };
  }, [isOpen, workspaceId]);

  if (!isOpen) return null;

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      toast.success('Invite link copied!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.info('Select the link and copy it manually.');
    }
  };

  const sendInvite = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) {
      setEmailError('Enter a valid e-mail address.');
      return;
    }
    setSending(true);
    setEmailError(null);
    try {
      const result = await invitationsApi.inviteByEmail(workspaceId, value);
      setEmail('');
      if (result.emailSent) toast.success(`Invitation sent to ${value}.`);
      else toast.warning(`Invitation created for ${value}, but the e-mail couldn't be delivered. Share the invite link instead.`);
    } catch (err) {
      setEmailError(errorMessage(err, 'Could not send the invitation.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal title="Invite people" subtitle="Grow your workspace" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-6">
        <form onSubmit={sendInvite} noValidate className="space-y-2">
          <Field label="Invite by e-mail" error={emailError} hint="They join as a member. The invitation works only for this address and expires in 14 days.">
            <TextInput type="email" autoComplete="off" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={sending} disabled={!email.trim()} icon={<Send size={13} aria-hidden="true" />}>
              Send invite
            </Button>
          </div>
        </form>

        <div className="border-t border-line pt-5">
          {linkLoading ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Spinner size={16} label="Generating link" /> Generating link…
            </div>
          ) : linkError ? (
            <p role="alert" className="text-sm font-semibold text-danger">
              {linkError}
            </p>
          ) : link ? (
            <div className="space-y-2">
              <Field
                label="Invite link"
                hint={`Anyone with this link can ask to join; you approve each request under Join requests. Works until ${formatDate(link.expiresAt)}.`}
              >
                <TextInput readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
              </Field>
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" onClick={copyLink} icon={copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}>
                  {copied ? 'Copied' : 'Copy Link'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};
