import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import * as authService from './auth.service';

export const signupRequestHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { username, email, password } = req.body;
    const result = await authService.requestSignupOtp(username, email, password);
    res.status(200).json(result);
  } catch (err) { next(err); }
};

export const verifyOtpHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { email, code } = req.body;
    const result = await authService.verifySignupOtp(email, code);
    res.status(201).json(result);
  } catch (err) { next(err); }
};

export const loginHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    res.json(result);
  } catch (err) { next(err); }
};

export const meHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const user = await authService.getMe(req.user!.id);
    res.json(user);
  } catch (err) { next(err); }
};

export const forgotPasswordHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await authService.forgotPassword(req.body.email);
    res.json(result);
  } catch (err) { next(err); }
};

export const resetPasswordHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id, token, newPassword } = req.body;
    const result = await authService.resetPassword(id, token, newPassword);
    res.json(result);
  } catch (err) { next(err); }
};
