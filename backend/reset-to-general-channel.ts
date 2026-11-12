/**
 * RETIRED (T.32, audit M16) — this script no longer does anything.
 *
 * It was a one-time migration from the single-workspace era: it deleted EVERY
 * non-DM channel in the database (all workspaces; their messages, reactions
 * and memberships cascaded) and then created one global "General" channel.
 * Since channels belong to workspaces (`Channel.workspaceId` is required) the
 * create step fails after the deletes have already run, so running it would
 * destroy every channel and leave nothing in their place. It had no
 * environment guard or confirmation.
 *
 * Every workspace now creates its own "General" channel when it is created
 * (modules/workspaces/workspaces.service.ts), and the shared SmartConnect
 * Collab workspace is reconciled at server start (lib/sharedWorkspace.ts), so
 * there is nothing left for this script to do. It is kept only so existing
 * references to it fail loudly and harmlessly instead of 404ing.
 *
 * Usage: none. Running it prints this notice and exits with status 1 without
 * connecting to any database.
 */
console.error(
  'reset-to-general-channel.ts is retired: it deleted every channel in every workspace and can no longer complete. ' +
    'Workspaces create their own "General" channel; nothing was changed.'
);
process.exitCode = 1;

export {};
