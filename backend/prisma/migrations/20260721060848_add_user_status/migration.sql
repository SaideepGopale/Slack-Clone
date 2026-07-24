-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED');

-- AlterTable: add the new column first (default ACTIVE for everyone)
ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

-- Data migration: preserve existing bans under the new status model before
-- the old boolean is dropped.
UPDATE "User" SET "status" = 'BANNED' WHERE "isBanned" = true;

-- AlterTable: now safe to drop the old boolean
ALTER TABLE "User" DROP COLUMN "isBanned";
