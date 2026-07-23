import { prisma } from './lib/prisma';
import { DEFAULT_WORKSPACE_SLUG } from './modules/workspaces/workspaces.service';

// One-off: flips isDefault on the existing global/default workspace after the
// column was added (migration 20260722060258_add_workspace_is_default). Not
// meant to run repeatedly — new environments should instead create their
// default workspace with isDefault: true from the start.
async function main() {
  const workspace = await prisma.workspace.findUnique({ where: { slug: DEFAULT_WORKSPACE_SLUG } });
  if (!workspace) {
    console.error(`No workspace with slug "${DEFAULT_WORKSPACE_SLUG}" found — nothing to update.`);
    process.exit(1);
  }

  const updated = await prisma.workspace.update({
    where: { id: workspace.id },
    data: { isDefault: true },
  });

  console.log(`"${updated.name}" (${updated.id}) is now isDefault=${updated.isDefault}`);
}

main().finally(() => prisma.$disconnect());
