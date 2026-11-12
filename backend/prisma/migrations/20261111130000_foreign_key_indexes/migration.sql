-- T.32 (audit L30): indexes on foreign keys that deletes and cascades scan
-- (deleting a message scanned every Notification row; deleting a user scanned
-- Channel/AuditLog/Workspace/Project/WorkspaceInviteLink). Additive only.
-- Plain CREATE INDEX briefly blocks writes to each table; on a large existing
-- database run it in a quiet window (an empty or small database is instant).

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "Channel_createdBy_idx" ON "Channel"("createdBy");

-- CreateIndex
CREATE INDEX "Channel_archivedById_idx" ON "Channel"("archivedById");

-- CreateIndex
CREATE INDEX "Notification_messageId_idx" ON "Notification"("messageId");

-- CreateIndex
CREATE INDEX "Project_createdById_idx" ON "Project"("createdById");

-- CreateIndex
CREATE INDEX "Project_archivedById_idx" ON "Project"("archivedById");

-- CreateIndex
CREATE INDEX "Workspace_ownerId_idx" ON "Workspace"("ownerId");

-- CreateIndex
CREATE INDEX "WorkspaceInviteLink_createdById_idx" ON "WorkspaceInviteLink"("createdById");

