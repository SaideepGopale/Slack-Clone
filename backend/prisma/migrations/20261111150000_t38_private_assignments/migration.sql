-- T.38: Team Lead task assignment.
--  - Task.assigneeOnly: a private assignment, visible only to its assignee,
--    its creator and the workspace's leads (defaults to false: every existing
--    task keeps its current visibility).
--  - Workspace.teamTasksProjectId: the workspace's "Team tasks" project (nullable).
-- Additive only: two columns with defaults/NULL, two indexes, one foreign key.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "assigneeOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "teamTasksProjectId" TEXT;

-- CreateIndex
CREATE INDEX "Task_workspaceId_assigneeId_idx" ON "Task"("workspaceId", "assigneeId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_teamTasksProjectId_key" ON "Workspace"("teamTasksProjectId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_teamTasksProjectId_fkey" FOREIGN KEY ("teamTasksProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

