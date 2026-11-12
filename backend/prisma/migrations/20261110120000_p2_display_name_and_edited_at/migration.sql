-- P2 (collaboration platform): additive, nullable columns only. No data is
-- rewritten and nothing is dropped; every existing row stays valid (NULL).

-- Optional display name shown next to the unique username.
ALTER TABLE "UserProfile" ADD COLUMN "displayName" TEXT;

-- Set when an author edits a message's content ("edited" indicator).
ALTER TABLE "Message" ADD COLUMN "editedAt" TIMESTAMP(3);
