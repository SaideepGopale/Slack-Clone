-- Stage 3 (T.22): bind a Member activation invitation to the Team Lead's workspace.
-- Additive only: one nullable column, one index and one foreign key on the
-- Stage 2 AccountInvitation table. No existing row is changed (all existing
-- invitations keep workspaceId = NULL); no backfill.

-- AlterTable
ALTER TABLE "AccountInvitation" ADD COLUMN     "workspaceId" TEXT;

-- CreateIndex
CREATE INDEX "AccountInvitation_workspaceId_status_idx" ON "AccountInvitation"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "AccountInvitation" ADD CONSTRAINT "AccountInvitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
