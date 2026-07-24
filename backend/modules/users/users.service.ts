import { prisma } from '../../lib/prisma';

export const listUsers = () =>
  prisma.user.findMany({ select: { id: true, username: true } });
