import type { ErrorRequestHandler } from 'express';
import { ApiError } from '../utils/ApiError.js';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';

function isClientAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // undici throws 'terminated' when the client closes the TCP connection mid-request
  if (err.message === 'terminated') return true;
  // fetch AbortController signal fired
  if (err.name === 'AbortError') return true;
  return false;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Client closed the connection before we finished — not a server error, don't log or respond.
  if (isClientAbort(err)) return;

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: err.flatten() },
    });
    return;
  }
  logger.error('Unhandled error', { err });
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
  });
};
