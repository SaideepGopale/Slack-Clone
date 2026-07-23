import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { JWT_SECRET } from '../config/env';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; username: string; role: Role };
}

export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || token === 'null' || token === 'undefined') {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  jwt.verify(token, JWT_SECRET as string, (err, decoded) => {
    if (err) {
      console.error('JWT Auth Error:', err.message);
      return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
    }
    req.user = decoded as AuthenticatedRequest['user'];
    next();
  });
};
