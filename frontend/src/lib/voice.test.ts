import { describe, expect, it } from 'vitest';
import { downsamplePeaks, encodeWaveform, formatDuration, levelFromRms, parseWaveform, pickRecordingFormat, recorderErrorMessage } from './voice';

describe('voice helpers (T.33)', () => {
  it('picks the first container the browser can record, with a matching extension', () => {
    expect(pickRecordingFormat((t) => t === 'audio/webm;codecs=opus')).toEqual({ mimeType: 'audio/webm;codecs=opus', extension: 'webm' });
    // Safari records MP4/AAC only.
    expect(pickRecordingFormat((t) => t === 'audio/mp4')).toEqual({ mimeType: 'audio/mp4', extension: 'm4a' });
    expect(pickRecordingFormat((t) => t.startsWith('audio/ogg'))).toEqual({ mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' });
    // Nothing explicitly supported: let the browser choose its default.
    expect(pickRecordingFormat(() => false)).toEqual({ mimeType: '', extension: 'webm' });
  });

  it('formats durations as m:ss and never shows NaN', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5_400)).toBe('0:05');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_600_000)).toBe('60:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Infinity)).toBe('0:00');
  });

  it('downsamples levels to a fixed number of 0–100 bars', () => {
    expect(downsamplePeaks([], 4)).toEqual([0, 0, 0, 0]);
    expect(downsamplePeaks([0.1, 0.5, 1, 0.2], 2)).toEqual([50, 100]);
    expect(downsamplePeaks([0.5], 3)).toEqual([50, 50, 50]);
    expect(downsamplePeaks([2, -1], 2)).toEqual([100, 0]); // clamped
  });

  it('round-trips the waveform and rejects anything malformed', () => {
    expect(parseWaveform(encodeWaveform([0, 12.4, 100]))).toEqual([0, 12, 100]);
    expect(parseWaveform('1,2,abc')).toBeNull();
    expect(parseWaveform('1,2,101')).toBeNull();
    expect(parseWaveform('')).toBeNull();
    expect(parseWaveform(null)).toBeNull();
    expect(parseWaveform(Array(65).fill('1').join(','))).toBeNull();
  });

  it('explains microphone failures in plain language', () => {
    expect(recorderErrorMessage(new DOMException('x', 'NotAllowedError'))).toMatch(/blocked/i);
    expect(recorderErrorMessage(new DOMException('x', 'NotFoundError'))).toMatch(/no microphone/i);
    expect(recorderErrorMessage(new DOMException('x', 'NotReadableError'))).toMatch(/another app/i);
    expect(recorderErrorMessage(new Error('boom'))).toMatch(/could not start/i);
  });

  it('meters on a decibel scale so quiet speech is still visible', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(Number.NaN)).toBe(0);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(0.001)).toBeCloseTo(0, 5); // −60 dB
    expect(levelFromRms(0.0316)).toBeCloseTo(0.5, 2); // −30 dB, typical speech
    expect(levelFromRms(2)).toBe(1);
  });
});
