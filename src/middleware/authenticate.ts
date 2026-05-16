import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import User from '../models/User.js';
import type { IUser } from '../models/User.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import Workspace from '../models/Workspace.js';

// Extend Express Request to carry authenticated user. Module-augmentation via
// `namespace Express` is the documented Express pattern and is intentional.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: IUser;
      rawBody?: Buffer;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies?.access_token as string | undefined;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;

    let token: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (cookieToken) {
      token = cookieToken;
    } else if (queryToken) {
      token = queryToken;
    }

    if (!token) {
      throw ApiError.unauthorized('No token provided');
    }

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);

    if (!user) {
      throw ApiError.unauthorized('User not found');
    }

    // Session epoch — see User.tokenVersion. A token issued before logout
    // (or admin force-rotate) carries a stale `tv` and must be rejected
    // even if its signature is valid and it hasn't expired yet.
    const tokenTv = payload.tv ?? 0;
    if (tokenTv !== user.tokenVersion) {
      throw ApiError.unauthorized('Session expired');
    }

    req.user = user;
    next();
  } catch (err) {
    const JWT_ERROR_NAMES = new Set(['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError']);
    if (err instanceof Error && JWT_ERROR_NAMES.has(err.name)) {
      // JWT failed — check if this is a workspace API key
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

      if (token?.startsWith('sk-')) {
        try {
          const keyHash = createHash('sha256').update(token).digest('hex');
          const workspace = await Workspace.findOne(
            { 'apiKeys.keyHash': keyHash },
          ).select('+apiKeys.keyHash ownerId');

          if (!workspace) {
            res.status(401).json({ success: false, error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
            return;
          }

          // Update lastUsedAt (fire-and-forget)
          const matchedKey = workspace.apiKeys.find((k) => k.keyHash === keyHash);
          if (matchedKey) {
            Workspace.updateOne(
              { _id: workspace._id, 'apiKeys._id': matchedKey._id },
              { $set: { 'apiKeys.$.lastUsedAt': new Date() } }
            ).catch(() => {});
          }

          const owner = await User.findById(workspace.ownerId);
          if (!owner) {
            res.status(401).json({ success: false, error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
            return;
          }

          req.user = owner;
          next();
          return;
        } catch {
          res.status(401).json({ success: false, error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
          return;
        }
      }

      next(ApiError.unauthorized('Invalid or expired token'));
      return;
    }
    next(err);
  }
}
