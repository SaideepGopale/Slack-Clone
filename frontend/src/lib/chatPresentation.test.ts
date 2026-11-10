import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDraft,
  draftStorageKey,
  formatDayLabel,
  GROUP_WINDOW_MS,
  isPreviewableImage,
  layoutMessages,
  loadDraft,
  saveDraft,
} from './chatPresentation';

const at = (iso: string) => new Date(iso).toISOString();
const msg = (id: string, senderId: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ id, senderId, createdAt: at(createdAt), ...extra });

describe('drafts', () => {
  afterEach(() => localStorage.clear());

  it('keys drafts per user and per conversation', () => {
    expect(draftStorageKey('u1', 'c1')).toBe('smartconnect:draft:u1:c1');
    expect(draftStorageKey('u1', 'c1')).not.toBe(draftStorageKey('u1', 'c2'));
    expect(draftStorageKey('u1', 'c1')).not.toBe(draftStorageKey('u2', 'c1'));
  });

  it('saves, restores and clears a draft without leaking into other conversations', () => {
    saveDraft('u1', 'c1', '<p><strong>hi</strong></p>', 'hi');
    expect(loadDraft('u1', 'c1')).toEqual({ html: '<p><strong>hi</strong></p>', text: 'hi' });
    expect(loadDraft('u1', 'c2')).toBeNull();
    expect(loadDraft('u2', 'c1')).toBeNull();
    clearDraft('u1', 'c1');
    expect(loadDraft('u1', 'c1')).toBeNull();
  });

  it('drops the stored draft when the composer becomes empty', () => {
    saveDraft('u1', 'c1', '<p>hi</p>', 'hi');
    saveDraft('u1', 'c1', '<p></p>', '   ');
    expect(localStorage.getItem(draftStorageKey('u1', 'c1'))).toBeNull();
  });

  it('ignores corrupt or foreign stored values', () => {
    localStorage.setItem(draftStorageKey('u1', 'c1'), '{not json');
    expect(loadDraft('u1', 'c1')).toBeNull();
    localStorage.setItem(draftStorageKey('u1', 'c1'), JSON.stringify({ html: 5, text: 'x' }));
    expect(loadDraft('u1', 'c1')).toBeNull();
  });

  it('is a no-op without a user or conversation', () => {
    saveDraft(undefined, 'c1', '<p>x</p>', 'x');
    expect(localStorage.length).toBe(0);
    expect(loadDraft(undefined, 'c1')).toBeNull();
  });
});

describe('formatDayLabel', () => {
  const now = new Date('2026-11-10T15:00:00');
  it('names today and yesterday', () => {
    expect(formatDayLabel(new Date('2026-11-10T08:00:00'), now)).toBe('Today');
    expect(formatDayLabel(new Date('2026-11-09T23:59:00'), now)).toBe('Yesterday');
  });
  it('spells out older days, adding the year only when it differs', () => {
    expect(formatDayLabel(new Date('2026-11-02T10:00:00'), now)).toBe('Monday, November 2');
    expect(formatDayLabel(new Date('2025-12-31T10:00:00'), now)).toBe('December 31, 2025');
  });
});

describe('layoutMessages', () => {
  const now = new Date('2026-11-10T15:00:00');

  it('puts a day separator before the first message and at every day change', () => {
    const layout = layoutMessages(
      [msg('a', 'u1', '2026-11-09T10:00:00'), msg('b', 'u1', '2026-11-09T10:01:00'), msg('c', 'u1', '2026-11-10T09:00:00')],
      now
    );
    expect(layout.get('a')?.dayLabel).toBe('Yesterday');
    expect(layout.get('b')?.dayLabel).toBeNull();
    expect(layout.get('c')?.dayLabel).toBe('Today');
  });

  it('groups consecutive messages from the same author within the window', () => {
    const layout = layoutMessages(
      [
        msg('a', 'u1', '2026-11-10T10:00:00'),
        msg('b', 'u1', '2026-11-10T10:02:00'),
        msg('c', 'u2', '2026-11-10T10:03:00'),
        msg('d', 'u1', '2026-11-10T10:04:00'),
      ],
      now
    );
    expect(layout.get('a')?.grouped).toBe(false);
    expect(layout.get('b')?.grouped).toBe(true);
    expect(layout.get('c')?.grouped).toBe(false);
    expect(layout.get('d')?.grouped).toBe(false);
  });

  it('starts a new group after the time window or a day change', () => {
    const start = new Date('2026-11-10T10:00:00').getTime();
    const layout = layoutMessages(
      [
        msg('a', 'u1', new Date(start).toISOString()),
        msg('b', 'u1', new Date(start + GROUP_WINDOW_MS + 1000).toISOString()),
        msg('c', 'u1', '2026-11-09T23:59:00'),
      ],
      now
    );
    expect(layout.get('b')?.grouped).toBe(false);
  });

  it('never groups polls or pinned messages', () => {
    const layout = layoutMessages(
      [
        msg('a', 'u1', '2026-11-10T10:00:00'),
        msg('b', 'u1', '2026-11-10T10:00:30', { pollData: { question: 'q', options: [] } }),
        msg('c', 'u1', '2026-11-10T10:01:00'),
        msg('d', 'u1', '2026-11-10T10:01:30', { isPinned: true }),
      ],
      now
    );
    expect(layout.get('b')?.grouped).toBe(false);
    expect(layout.get('c')?.grouped).toBe(false);
    expect(layout.get('d')?.grouped).toBe(false);
  });
});

describe('isPreviewableImage', () => {
  it('previews uploaded images only', () => {
    expect(isPreviewableImage('image/png', 'https://res.cloudinary.com/x/a.png')).toBe(true);
    expect(isPreviewableImage('image/jpeg', '/uploads/a.jpg')).toBe(true);
    expect(isPreviewableImage('application/pdf', 'https://x/a.pdf')).toBe(false);
    expect(isPreviewableImage(undefined, 'https://x/a.png')).toBe(false);
  });
  it('refuses scriptable or protocol-relative URLs', () => {
    expect(isPreviewableImage('image/png', 'javascript:alert(1)')).toBe(false);
    expect(isPreviewableImage('image/png', '//evil.example/a.png')).toBe(false);
    expect(isPreviewableImage('image/png', 'data:image/png;base64,AAAA')).toBe(false);
    expect(isPreviewableImage('image/png', undefined)).toBe(false);
  });
});
