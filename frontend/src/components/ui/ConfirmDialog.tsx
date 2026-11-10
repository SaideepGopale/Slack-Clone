import { ReactNode, useCallback, useRef, useState } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  tone?: 'default' | 'danger';
}

interface ConfirmDialogProps extends ConfirmOptions {
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Accessible replacement for window.confirm (built on ui/Modal: dialog role,
 * Escape/backdrop cancel, focus restore). An async onConfirm keeps the dialog
 * open with a busy button until it settles.
 */
export const ConfirmDialog = ({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default', onConfirm, onCancel }: ConfirmDialogProps) => {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={() => !busy && onCancel()}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-fg-muted">{message}</div>
    </Modal>
  );
};

/**
 * Promise-based confirmation: `if (await confirm({...})) doIt();`
 * Render the returned `dialog` element once in the component.
 */
export const useConfirm = () => {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  };

  const dialog = options ? <ConfirmDialog {...options} onConfirm={() => settle(true)} onCancel={() => settle(false)} /> : null;
  return { confirm, dialog };
};
