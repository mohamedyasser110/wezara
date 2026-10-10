import type { NextFunction, Request, Response } from 'express';

/**
 * Async route/middleware wrapper (Express 4 has no built-in async error
 * handling — a rejected promise inside `async (req, res)` would otherwise hang
 * the request and surface as an unhandled rejection). Forwards errors to the
 * final ApiError middleware in app.ts.
 *
 * Usage: router.get('/x', ah(async (req: AuthedRequest, res) => { ... }))
 */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
