import { lazy, Suspense } from 'react';
import { useResolvedTheme } from '../../lib/theme';

// P3 (performance): emoji-picker-react is large and only needed once someone
// opens a picker, so it's loaded on demand instead of in the main bundle.
const Picker = lazy(() => import('emoji-picker-react'));

/** Emoji picker that follows the app theme and loads on first use. */
export const EmojiPicker = ({ onPick }: { onPick: (emoji: string) => void }) => {
  const theme = useResolvedTheme();
  return (
    <Suspense
      fallback={
        <div role="status" className="w-[350px] max-w-[90vw] h-[450px] flex items-center justify-center text-sm text-fg-muted bg-surface">
          Loading emoji…
        </div>
      }
    >
      {/* 'dark' | 'light' are the library's Theme enum values. */}
      <Picker onEmojiClick={(data) => onPick(data.emoji)} theme={(theme === 'dark' ? 'dark' : 'light') as never} lazyLoadEmojis />
    </Suspense>
  );
};
