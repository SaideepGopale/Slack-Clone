-- Batch 3 / Sub-batch D — channel types and management.
--
-- Purely additive and backward compatible:
--   * new enum ChannelVisibility;
--   * new Channel columns with defaults that keep every existing channel
--     PUBLIC and open-posting (isAnnouncement=false), not archived, no topic;
--   * archivedById FK ON DELETE SET NULL (attribution only; the frozen admin
--     delete-user flow needs no change).
-- ChannelMember.role is untouched: legacy 'admin' keeps meaning Channel Owner;
-- 'moderator' is a new value written only by the application. No UPDATE,
-- DELETE or DROP of existing data. Constant defaults are metadata-only on
-- PostgreSQL 11+ (no table rewrite).

-- CreateEnum
CREATE TYPE "ChannelVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "isAnnouncement" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "topic" TEXT,
ADD COLUMN     "visibility" "ChannelVisibility" NOT NULL DEFAULT 'PUBLIC';

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

