-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastActiveWorkspaceId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_lastActiveWorkspaceId_fkey" FOREIGN KEY ("lastActiveWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
