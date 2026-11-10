-- Stage 2 (T.20): single-use activation invitations for provisioned accounts.
-- Additive only: one new enum type and one new table (+ indexes and foreign
-- keys on the new table). No existing table, column, constraint or row is
-- changed, and no existing account is backfilled.

-- CreateEnum
CREATE TYPE "AccountInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- CreateTable
CREATE TABLE "AccountInvitation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "intendedTier" "AccountTier" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tempPasswordHash" TEXT,
    "credentialFingerprint" TEXT NOT NULL,
    "teamLabel" TEXT,
    "status" "AccountInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountInvitation_tokenHash_key" ON "AccountInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountInvitation_userId_status_idx" ON "AccountInvitation"("userId", "status");

-- CreateIndex
CREATE INDEX "AccountInvitation_createdById_idx" ON "AccountInvitation"("createdById");

-- CreateIndex
CREATE INDEX "AccountInvitation_status_expiresAt_idx" ON "AccountInvitation"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "AccountInvitation" ADD CONSTRAINT "AccountInvitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountInvitation" ADD CONSTRAINT "AccountInvitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
