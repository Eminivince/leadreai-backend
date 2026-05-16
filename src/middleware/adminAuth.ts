import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.ADMIN_SECRET) {
    res.status(503).json({ error: 'Admin UI not configured (ADMIN_SECRET not set)' });
    return;
  }
  const provided = req.headers['x-admin-secret'] ?? req.query['secret'];
  if (provided !== env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
