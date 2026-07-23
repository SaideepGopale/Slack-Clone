import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as usersService from './users.service';

export const listUsersHandler = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const users = await usersService.listUsers();
    res.json(users);
  } catch (err) { next(err); }
};
