import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * T.32 (audit H3, client side): private attachments are loaded through a
 * short-lived signed link fetched with the session; older public URLs render
 * directly; a file the server will not hand out shows a clear message.
 */
const axiosMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMock }));

import { clearAttachmentLinkCache, MessageAttachment } from './MessageAttachment';

const PATH = '/api/attachments/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

afterEach(() => {
  vi.clearAllMocks();
  clearAttachmentLinkCache();
});

describe('MessageAttachment (T.32)', () => {
  it('fetches a signed link for a private image and renders it', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { url: 'https://api.cloudinary.com/v1_1/x/image/download?sig=1', expiresAt: future() } });
    render(<MessageAttachment fileUrl={PATH} fileName="plan.png" fileType="image/png" />);
    const img = await screen.findByRole('img', { name: 'plan.png' });
    expect(img).toHaveAttribute('src', 'https://api.cloudinary.com/v1_1/x/image/download?sig=1');
    expect(axiosMock.get).toHaveBeenCalledWith(PATH);
  });

  it('reuses one signed link for the same file', async () => {
    axiosMock.get.mockResolvedValue({ data: { url: 'https://api.cloudinary.com/signed', expiresAt: future() } });
    render(
      <>
        <MessageAttachment fileUrl={PATH} fileName="a.png" fileType="image/png" />
        <MessageAttachment fileUrl={PATH} fileName="a.png" fileType="image/png" />
      </>
    );
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
  });

  it('renders older public files directly without asking the API', () => {
    render(<MessageAttachment fileUrl="https://res.cloudinary.com/x/image/upload/workspace-uploads/a.png" fileName="a.png" fileType="image/png" />);
    expect(screen.getByRole('img', { name: 'a.png' })).toHaveAttribute('src', 'https://res.cloudinary.com/x/image/upload/workspace-uploads/a.png');
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  it('says so when the file is not available (deleted, or no longer visible)', async () => {
    axiosMock.get.mockRejectedValueOnce(Object.assign(new Error('404'), { response: { status: 404 } }));
    render(<MessageAttachment fileUrl={PATH} fileName="gone.pdf" fileType="application/pdf" />);
    expect(await screen.findByText('This file is no longer available.')).toBeInTheDocument();
  });

  it('private documents get a download button with an accessible name', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { url: 'https://api.cloudinary.com/signed', expiresAt: future() } });
    render(<MessageAttachment fileUrl={PATH} fileName="report.pdf" fileType="application/pdf" />);
    expect(await screen.findByRole('button', { name: 'Download report.pdf' })).toBeInTheDocument();
  });
});
