import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T.33 — the voice-message UI: the player (seek, speed, download, one note at
 * a time) and the composer bar (record → review → send with progress,
 * cancel, retry without re-recording). MediaRecorder and the microphone are
 * scripted; uploads go to a mocked axios.
 */
const axiosMock = vi.hoisted(() => ({ post: vi.fn(), isCancel: vi.fn(() => false) }));
vi.mock('axios', () => ({ default: axiosMock }));

import { VoiceMessagePlayer } from './VoiceMessagePlayer';
import { VoiceRecorderBar } from './VoiceRecorderBar';

class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus';
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
    this.onstop?.();
  }
}
const track = { stop: vi.fn() };
const getUserMedia = vi.fn();

beforeEach(() => {
  track.stop.mockClear();
  axiosMock.post.mockReset();
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [track] });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  HTMLMediaElement.prototype.pause = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
    this.dispatchEvent(new Event('pause'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VoiceMessagePlayer', () => {
  const waveform = Array.from({ length: 48 }, (_, i) => i * 2);

  it('shows the stored duration and waveform, and plays/pauses', async () => {
    const { container } = render(<VoiceMessagePlayer src="https://files/v.webm" durationMs={42_000} waveform={waveform} label="Voice note" />);
    expect(screen.getByText('0:42')).toBeInTheDocument();
    expect(container.querySelectorAll('[role="slider"] > span')).toHaveLength(48);
    fireEvent.click(screen.getByRole('button', { name: 'Play Voice note' }));
    expect(await screen.findByRole('button', { name: 'Pause Voice note' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause Voice note' }));
    expect(await screen.findByRole('button', { name: 'Play Voice note' })).toBeInTheDocument();
  });

  it('seeks with the keyboard and cycles playback speed', () => {
    const { container } = render(<VoiceMessagePlayer src="https://files/v.webm" durationMs={60_000} waveform={waveform} label="Voice note" />);
    const audio = container.querySelector('audio')!;
    const slider = screen.getByRole('slider', { name: 'Seek Voice note' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(audio.currentTime).toBe(5);
    expect(slider).toHaveAttribute('aria-valuenow', '5');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(audio.currentTime).toBe(60);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(audio.currentTime).toBe(0);

    const speed = screen.getByRole('button', { name: 'Playback speed 1×' });
    fireEvent.click(speed);
    expect(audio.playbackRate).toBe(1.5);
    fireEvent.click(screen.getByRole('button', { name: 'Playback speed 1.5×' }));
    expect(audio.playbackRate).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Playback speed 2×' }));
    expect(audio.playbackRate).toBe(1);
  });

  it('offers download and plays only one note at a time', async () => {
    const onDownload = vi.fn();
    const { container } = render(
      <>
        <VoiceMessagePlayer src="https://files/a.webm" durationMs={5_000} label="First" onDownload={onDownload} />
        <VoiceMessagePlayer src="https://files/b.webm" durationMs={5_000} label="Second" />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download First' }));
    expect(onDownload).toHaveBeenCalled();

    const [first] = container.querySelectorAll('audio');
    fireEvent.click(screen.getByRole('button', { name: 'Play First' }));
    await screen.findByRole('button', { name: 'Pause First' });
    fireEvent.click(screen.getByRole('button', { name: 'Play Second' }));
    await screen.findByRole('button', { name: 'Pause Second' });
    expect(first.paused).toBe(true);
    expect(screen.getByRole('button', { name: 'Play First' })).toBeInTheDocument();
  });

  it('draws neutral bars when a note has no stored waveform', () => {
    const { container } = render(<VoiceMessagePlayer src="https://files/v.webm" label="Old note" />);
    expect(container.querySelectorAll('[role="slider"] > span').length).toBeGreaterThan(0);
  });
});

describe('VoiceRecorderBar', () => {
  const recordAndStop = async () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    render(<VoiceRecorderBar onSend={onSend} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and review voice message' }));
    await screen.findByRole('button', { name: 'Send voice message' });
    return { onSend, onClose };
  };

  it('records, reviews and sends the note with its duration and waveform, showing progress', async () => {
    let finish: (value: unknown) => void = () => undefined;
    axiosMock.post.mockImplementationOnce((_url: string, _form: FormData, config: { onUploadProgress: (e: { loaded: number; total: number }) => void }) => {
      config.onUploadProgress({ loaded: 40, total: 100 });
      return new Promise((resolve) => (finish = resolve));
    });
    const { onSend, onClose } = await recordAndStop();
    expect(track.stop).toHaveBeenCalled(); // microphone released at stop

    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    expect(await screen.findByText('40%')).toBeInTheDocument();
    const [url, form] = axiosMock.post.mock.calls[0] as [string, FormData];
    expect(url).toBe('/api/upload');
    expect(Number(form.get('durationMs'))).toBeGreaterThanOrEqual(0);
    expect(String(form.get('waveform')).split(',')).toHaveLength(48);
    expect((form.get('attachment') as File).name).toMatch(/^voice-message-\d+\.webm$/);

    await act(async () => finish({ data: { url: '/api/attachments/abc', name: 'voice.webm', type: 'audio/webm;codecs=opus' } }));
    expect(onSend).toHaveBeenCalledWith({ url: '/api/attachments/abc', name: 'voice.webm', type: 'audio/webm;codecs=opus' });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the recording after a failed upload and retries it', async () => {
    axiosMock.post
      .mockRejectedValueOnce({ response: { data: { message: 'Network trouble.' } } })
      .mockResolvedValueOnce({ data: { url: '/api/attachments/def', name: 'v.webm', type: 'audio/webm' } });
    const { onSend } = await recordAndStop();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    expect(await screen.findByText(/Network trouble\. Your recording is kept/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry sending voice message' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/attachments/def' })));
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
  });

  it('cancelling a recording closes the bar and releases the microphone', async () => {
    const onClose = vi.fn();
    render(<VoiceRecorderBar onSend={vi.fn()} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel recording' }));
    expect(onClose).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('pause and resume are offered while recording', async () => {
    render(<VoiceRecorderBar onSend={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume recording' }));
    expect(await screen.findByRole('button', { name: 'Pause recording' })).toBeInTheDocument();
  });

  it('explains a blocked microphone and offers to try again', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    render(<VoiceRecorderBar onSend={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked/i);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Stop and review voice message' })).toBeInTheDocument();
  });
});
