import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not set. Refusing to start.');
}

export interface AuthenticatedRequest extends Request {
  user?: { id: string; username: string };
}

export const dbCheck = async (_req: Request, _res: Response, next: NextFunction) => {
  next();
};

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
    req.user = decoded as { id: string; username: string };
    next();
  });
};

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
};
