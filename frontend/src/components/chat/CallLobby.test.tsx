import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallLobby } from './CallLobby';

/**
 * T.33 — pre-join lobby: previews camera/microphone, lets you join muted or
 * with the camera off and pick devices, releases the preview on join and
 * cancel, explains failures and falls back to audio when there is no camera.
 */
const tracks = { audio: { kind: 'audio', enabled: true, stop: vi.fn() }, video: { kind: 'video', enabled: true, stop: vi.fn() } };
const stream = (video = true) => ({
  getTracks: () => (video ? [tracks.audio, tracks.video] : [tracks.audio]),
  getAudioTracks: () => [tracks.audio],
  getVideoTracks: () => (video ? [tracks.video] : []),
});
const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();

beforeEach(() => {
  tracks.audio.stop.mockClear();
  tracks.video.stop.mockClear();
  tracks.audio.enabled = true;
  tracks.video.enabled = true;
  getUserMedia.mockReset().mockResolvedValue(stream());
  enumerateDevices.mockReset().mockResolvedValue([
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in mic' },
    { kind: 'audioinput', deviceId: 'mic-2', label: 'Headset' },
    { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime HD' },
  ]);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia, enumerateDevices }, configurable: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { set: vi.fn(), configurable: true });
});
afterEach(() => vi.clearAllMocks());

const renderLobby = (callType: 'audio' | 'video' = 'video') => {
  const onJoin = vi.fn();
  const onCancel = vi.fn();
  render(<CallLobby callType={callType} title="Video call · design" joinLabel="Start call" onJoin={onJoin} onCancel={onCancel} />);
  return { onJoin, onCancel };
};

describe('CallLobby (T.33)', () => {
  it('previews, then joins with the chosen microphone and camera state, releasing the preview', async () => {
    const { onJoin } = renderLobby();
    const join = await screen.findByRole('button', { name: 'Start call' });
    await waitFor(() => expect(join).toBeEnabled());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(tracks.audio.enabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Turn camera off' }));
    expect(tracks.video.enabled).toBe(false);
    expect(screen.getByText('Camera is off')).toBeInTheDocument();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Microphone' }), { target: { value: 'mic-2' } });
    await waitFor(() => expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-2' } }, video: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Start call' }));
    expect(onJoin).toHaveBeenCalledWith({ audio: false, video: false, audioDeviceId: 'mic-2', videoDeviceId: undefined });
    expect(tracks.audio.stop).toHaveBeenCalled();
  });

  it('falls back to audio when there is no camera', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('no cam', 'NotFoundError')).mockResolvedValueOnce(stream(false));
    const { onJoin } = renderLobby();
    expect(await screen.findByText(/No camera found/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start call' }));
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ audio: true, video: false }));
  });

  it('explains a blocked microphone, offers to retry, and cancel releases everything', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const { onCancel } = renderLobby('audio');
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked/i);
    expect(screen.getByRole('button', { name: 'Start call' })).toBeDisabled();
    getUserMedia.mockReset().mockResolvedValue(stream(false));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start call' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(tracks.audio.stop).toHaveBeenCalled();
  });
});
