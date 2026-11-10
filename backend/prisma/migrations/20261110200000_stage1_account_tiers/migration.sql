-- Stage 1 (T.19): company hierarchy tiers (Team Lead / Member).
-- Additive only: one new enum type and one new table. No existing table,
-- column, constraint or row is changed. No data backfill — every existing
-- account has no row here and is therefore treated as MEMBER until a
-- reviewed backfill (see entireanalysis.md T.19) grants TEAM_LEAD.

-- CreateEnum
CREATE TYPE "AccountTier" AS ENUM ('TEAM_LEAD', 'MEMBER');

-- CreateTable
CREATE TABLE "AccountTierGrant" (
    "userId" TEXT NOT NULL,
    "tier" "AccountTier" NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountTierGrant_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "AccountTierGrant_tier_idx" ON "AccountTierGrant"("tier");

-- CreateIndex
CREATE INDEX "AccountTierGrant_grantedById_idx" ON "AccountTierGrant"("grantedById");

-- AddForeignKey
ALTER TABLE "AccountTierGrant" ADD CONSTRAINT "AccountTierGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountTierGrant" ADD CONSTRAINT "AccountTierGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

