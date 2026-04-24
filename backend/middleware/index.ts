import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'secret-key-456';

export const dbCheck = async (req: Request, res: Response, next: NextFunction) => {
  // Prisma connects lazily, we can do a simple check but usually it's fine
  // For now we just pass through or do a quick ping if requested
  next();
};

export const authenticate = (req: any, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || token === 'null' || token === 'undefined') {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      console.error('JWT Auth Error:', err.message);
      return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
};
