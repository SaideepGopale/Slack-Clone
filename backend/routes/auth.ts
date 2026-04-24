import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.ts';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key-456';

router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, email, password: hashedPassword }
    });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) { next(err); }
});

export default router;
