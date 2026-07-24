-- DropIndex
DROP INDEX "Message_channelId_createdAt_idx";

-- CreateIndex
CREATE INDEX "Message_channelId_createdAt_id_idx" ON "Message"("channelId", "createdAt" DESC, "id" DESC);
