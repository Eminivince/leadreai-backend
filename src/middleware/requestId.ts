import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Request ID middleware.
 *
 * Sets `req.id` to either the inbound `X-Request-Id` header (when the
 * caller already has a trace ID — e.g., a Vercel edge proxy or another
 * service in our own stack) or a fresh UUID v4. Echoes the chosen value
 * back as the response header so the client can quote it in support
 * tickets.
 *
 * Downstream consumers:
 *   - `errorHandler` reads `req.id` and includes it in the JSON error body.
 *   - Worker job payloads include `requestId` so a sequence send failure
 *     can be traced back to the originating HTTP request.
 *   - Structured logger child loggers (future) inherit the id automatically.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
// Cap inbound header length to avoid log-poisoning from a hostile caller.
const MAX_REQUEST_ID_LENGTH = 80;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id =
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MAX_REQUEST_ID_LENGTH
      ? candidate
      : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}
