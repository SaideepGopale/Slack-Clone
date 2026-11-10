-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "clientId" TEXT;

-- CreateTable
CREATE TABLE "WorkspaceInviteLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInviteLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInviteLink_token_key" ON "WorkspaceInviteLink"("token");

-- CreateIndex
CREATE INDEX "WorkspaceInviteLink_workspaceId_expiresAt_idx" ON "WorkspaceInviteLink"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "Message_parentId_createdAt_idx" ON "Message"("parentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_senderId_clientId_key" ON "Message"("senderId", "clientId");

-- AddForeignKey
ALTER TABLE "WorkspaceInviteLink" ADD CONSTRAINT "WorkspaceInviteLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInviteLink" ADD CONSTRAINT "WorkspaceInviteLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

