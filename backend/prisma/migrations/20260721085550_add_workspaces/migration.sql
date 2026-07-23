-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_userId_workspaceId_key" ON "WorkspaceMember"("userId", "workspaceId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: add nullable first — Channel/Invitation already have rows, so
-- a NOT NULL column can't be added without a value to backfill them with.
ALTER TABLE "Channel" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Invitation" ADD COLUMN "workspaceId" TEXT;

-- Data migration: pre-workspace data was implicitly "one shared workspace"
-- already — create a Default Workspace (owned by whoever created "General",
-- falling back to the earliest-created user if no channel exists yet), make
-- every existing user a member of it (preserving ADMIN vs MEMBER from their
-- existing global Role), and attribute every existing Channel/Invitation to it.
DO $$
DECLARE
  default_owner_id TEXT;
  default_workspace_id TEXT := gen_random_uuid()::TEXT;
BEGIN
  SELECT "createdBy" INTO default_owner_id FROM "Channel" WHERE name = 'General' AND "isDM" = false LIMIT 1;
  IF default_owner_id IS NULL THEN
    SELECT id INTO default_owner_id FROM "User" ORDER BY "createdAt" ASC LIMIT 1;
  END IF;

  IF default_owner_id IS NOT NULL THEN
    INSERT INTO "Workspace" (id, name, slug, "ownerId", "createdAt")
    VALUES (default_workspace_id, 'Default Workspace', 'default', default_owner_id, now());

    INSERT INTO "WorkspaceMember" (id, "userId", "workspaceId", role, "createdAt", "updatedAt")
    SELECT gen_random_uuid()::TEXT, id, default_workspace_id,
           CASE WHEN role = 'ADMIN' THEN 'ADMIN'::"WorkspaceRole" ELSE 'MEMBER'::"WorkspaceRole" END,
           now(), now()
    FROM "User";

    UPDATE "Channel" SET "workspaceId" = default_workspace_id WHERE "workspaceId" IS NULL;
    UPDATE "Invitation" SET "workspaceId" = default_workspace_id WHERE "workspaceId" IS NULL;
  END IF;
END $$;

-- AlterTable: now safe to require + FK (every row has a value)
ALTER TABLE "Channel" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Invitation" ALTER COLUMN "workspaceId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
