import { Request, Response, NextFunction } from 'express';
import logger from '../../utils/logger';

export function errorHandlerMiddleware(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error(`Unhandled Express error: ${err?.stack || err?.message || err}`);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
  });
}

export default errorHandlerMiddleware;
