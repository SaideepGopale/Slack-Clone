import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, Menu, Spinner, TabPanel, Tabs, TextInput, useConfirm } from '.';

describe('Button / IconButton', () => {
  it('defaults to type="button" and blocks clicks while loading (aria-busy)', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<Button onClick={onClick} loading>Save</Button>);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('icon-only buttons always have an accessible name', () => {
    render(<IconButton label="Close panel" icon={<span>x</span>} />);
    expect(screen.getByRole('button', { name: 'Close panel' })).toHaveAttribute('title', 'Close panel');
  });
});

describe('Field', () => {
  it('links label, hint and error to the control', () => {
    const { rerender } = render(
      <Field label="Workspace name" hint="Shown to everyone">
        <TextInput />
      </Field>
    );
    const input = screen.getByLabelText('Workspace name');
    expect(input).toHaveAccessibleDescription('Shown to everyone');
    expect(input).not.toHaveAttribute('aria-invalid');

    rerender(
      <Field label="Workspace name" hint="Shown to everyone" error="Name is required">
        <TextInput />
      </Field>
    );
    expect(screen.getByLabelText('Workspace name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Workspace name')).toHaveAccessibleDescription('Name is required');
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
  });
});

describe('Tabs', () => {
  const Harness = () => {
    const [value, setValue] = useState('a');
    return (
      <>
        <Tabs label="Sections" idPrefix="t" value={value} onChange={setValue} tabs={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', count: 3 }, { id: 'c', label: 'Gamma' }]} />
        <TabPanel idPrefix="t" id={value}>
          Panel {value}
        </TabPanel>
      </>
    );
  };

  it('uses roving focus with arrow/Home/End keys and labels its panel', () => {
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    expect(alpha).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: /Beta/ })).toHaveTextContent('Panel b');

    fireEvent.keyDown(screen.getByRole('tab', { name: /Beta/ }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Gamma' }), { key: 'ArrowRight' });
    expect(alpha).toHaveAttribute('aria-selected', 'true'); // wraps
  });
});

describe('Menu', () => {
  it('opens on click, moves with arrows, selects, and closes on Escape with focus returned', () => {
    const onRename = vi.fn();
    render(
      <Menu
        label="Workspace options"
        trigger="Options"
        items={[
          { id: 'rename', label: 'Rename', onSelect: onRename },
          { id: 'archived', label: 'Archived', onSelect: vi.fn(), disabled: true },
          { id: 'delete', label: 'Delete', onSelect: vi.fn(), danger: true },
        ]}
      />
    );
    const trigger = screen.getByRole('button', { name: 'Workspace options' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(rename, { key: 'ArrowDown' }); // skips the disabled item
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Delete' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onRename).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders nothing when there are no items (no empty menus)', () => {
    const { container } = render(<Menu label="Empty" trigger="x" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ConfirmDialog / useConfirm', () => {
  it('is an accessible dialog; async confirm shows a busy state', async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Leave Acme?" message="You'll need a new invite." confirmLabel="Leave" tone="danger" onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = screen.getByRole('dialog', { name: 'Leave Acme?' });
    expect(dialog).toHaveTextContent("You'll need a new invite.");
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByRole('button', { name: 'Leave' })).toHaveAttribute('aria-busy', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled(); // can't dismiss mid-action
    await act(async () => resolve());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('useConfirm resolves true/false', async () => {
    const results: boolean[] = [];
    const Harness = () => {
      const { confirm, dialog } = useConfirm();
      return (
        <>
          <button onClick={async () => results.push(await confirm({ title: 'Sure?', message: 'Really?' }))}>Ask</button>
          {dialog}
        </>
      );
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(results).toEqual([true]));
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(results).toEqual([true, false]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('states and badges', () => {
  it('announce loading, errors (with retry) and render empty states', () => {
    const onRetry = vi.fn();
    render(
      <>
        <Spinner label="Loading people" />
        <ErrorState message="Could not load people." onRetry={onRetry} />
        <EmptyState title="No projects yet" description="Create one to get started." />
        <Badge tone="brand">Owner</Badge>
      </>
    );
    expect(screen.getByRole('status', { name: 'Loading people' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load people.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });
});
