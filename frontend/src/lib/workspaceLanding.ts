/**
 * P2: where "/" lands a signed-in user. Their last active workspace if it
 * still exists; otherwise one of their own or shared workspaces (where their
 * work is) before SmartConnect Collab, which everyone has.
 */
export const pickLandingWorkspace = (
  workspaces: { id: string; isDefault?: boolean }[],
  lastActiveId: string | null | undefined
): string | null => {
  const last = lastActiveId ? workspaces.find((w) => w.id === lastActiveId) : undefined;
  return (last ?? workspaces.find((w) => !w.isDefault) ?? workspaces[0])?.id ?? null;
};
