-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ChannelCreationPolicy" AS ENUM ('MEMBERS', 'ADMINS');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "channelCreationPolicy" "ChannelCreationPolicy" NOT NULL DEFAULT 'MEMBERS',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "organizationId" TEXT;

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Workspace_organizationId_idx" ON "Workspace"("organizationId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Data backfill (writes only to the NEW tables/column; existing rows, ids and
-- memberships are untouched). Idempotent: only workspaces without an
-- organization are processed.
--
-- 1. One organization per existing workspace (decision B/1). The Default
--    Workspace's organization is named "Default Organization" and flagged
--    isDefault (implicit membership for every account, matching frozen
--    signup behaviour). Slugs reuse the workspace slug (already unique).
--    Timestamps are written in UTC explicitly (Prisma stores UTC; the DB
--    session time zone may differ).
WITH mapping AS MATERIALIZED (
  SELECT w."id" AS workspace_id,
         gen_random_uuid()::text AS organization_id,
         CASE WHEN w."isDefault" THEN 'Default Organization' ELSE w."name" END AS organization_name,
         w."slug" AS organization_slug,
         w."isDefault" AS is_default,
         w."createdAt" AS created_at
  FROM "Workspace" w
  WHERE w."organizationId" IS NULL
),
inserted AS (
  INSERT INTO "Organization" ("id", "name", "slug", "isDefault", "createdAt", "updatedAt")
  SELECT organization_id, organization_name, organization_slug, is_default, created_at, (NOW() AT TIME ZONE 'UTC')
  FROM mapping
  RETURNING "id"
)
UPDATE "Workspace" w
SET "organizationId" = m.organization_id
FROM mapping m
WHERE w."id" = m.workspace_id;

-- 2. Organization roles from existing workspace roles. Owners first so the
--    OWNER row wins over the owner's own WorkspaceMember(ADMIN) row.
INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, w."organizationId", w."ownerId", 'OWNER'::"OrganizationRole",
       (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')
FROM "Workspace" w
WHERE w."organizationId" IS NOT NULL
ON CONFLICT ("organizationId", "userId") DO NOTHING;

INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, w."organizationId", wm."userId",
       CASE WHEN wm."role" = 'ADMIN' THEN 'ADMIN'::"OrganizationRole" ELSE 'MEMBER'::"OrganizationRole" END,
       (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')
FROM "WorkspaceMember" wm
JOIN "Workspace" w ON w."id" = wm."workspaceId"
WHERE w."organizationId" IS NOT NULL
ON CONFLICT ("organizationId", "userId") DO NOTHING;
