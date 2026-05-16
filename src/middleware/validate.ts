import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

type ValidateTarget = 'body' | 'query' | 'params';

export function validate(schema: ZodSchema, target: ValidateTarget = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      // Pass ZodError to global error handler
      next(result.error);
      return;
    }
    // Replace with parsed/coerced data
    req[target] = result.data;
    next();
  };
}
