-- AlterTable: add nullable first — Message already has rows, so a NOT NULL
-- column can't be added without a value to backfill them with.
ALTER TABLE "Message" ADD COLUMN "workspaceId" TEXT;

-- Data migration: every message's workspace is knowable via its channel
-- (Channel.workspaceId has been required and populated since the workspaces
-- migration) — backfill directly from that relationship rather than
-- guessing at a default.
UPDATE "Message" m
SET "workspaceId" = c."workspaceId"
FROM "Channel" c
WHERE m."channelId" = c.id;

-- AlterTable: now safe to require
ALTER TABLE "Message" ALTER COLUMN "workspaceId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Message_workspaceId_createdAt_idx" ON "Message"("workspaceId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
