import { randomUUID } from "node:crypto";
import pino from "pino";
import type { NextFunction, Request, Response } from "express";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "err.config.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
  base: { service: "custom-dca-opencode" },
});

declare global {
  namespace Express {
    interface Request {
      requestID?: string;
    }
  }
}

/**
 * Logs request outcomes without retaining URLs or bodies: both can contain
 * workspace paths, OpenCode auth tokens, and agent-authored instructions.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestID = req.header("x-request-id") || randomUUID();
  const startedAt = process.hrtime.bigint();
  req.requestID = requestID;
  res.setHeader("x-request-id", requestID);

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl || "unmatched";
    const fields = {
      requestID,
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    };
    if (res.statusCode >= 500) logger.error(fields, "request failed");
    else if (res.statusCode >= 400) logger.warn(fields, "request rejected");
    else logger.info(fields, "request completed");
  });

  next();
}

export function errorLogger(error: unknown, req: Request, _res: Response, next: NextFunction): void {
  // Error messages from upstream may include response bodies or user input.
  logger.error({ errorType: error instanceof Error ? error.name : "unknown", requestID: req.requestID }, "unhandled request error");
  next(error);
}
