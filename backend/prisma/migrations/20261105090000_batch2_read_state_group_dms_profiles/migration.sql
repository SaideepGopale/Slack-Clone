-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "isGroupDM" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ChannelMember" ADD COLUMN     "historyFrom" TIMESTAMP(3),
ADD COLUMN     "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastReadMessageId" TEXT;

-- Backfill: every existing membership starts "caught up" (no historical
-- unread flood after deploy). Written in UTC explicitly: Prisma stores
-- DateTime values as UTC in timestamp-without-time-zone columns, whereas the
-- column DEFAULT (CURRENT_TIMESTAMP) follows the database session time zone.
-- Only the new column is written; no existing data is modified.
UPDATE "ChannelMember" SET "lastReadAt" = (NOW() AT TIME ZONE 'UTC');

-- CreateTable
CREATE TABLE "UserProfile" (
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "bio" TEXT,
    "timezone" TEXT,
    "readReceiptsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

