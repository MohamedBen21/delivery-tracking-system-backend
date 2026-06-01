import { Request, Response, NextFunction } from "express";
import { getRedisClient } from "../databases/Redis.database";
import { Logger } from "../utils/Logger.util";

interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  keyByEmail?: boolean;
}

function createRateLimiter(prefix: string, config: RateLimitConfig) {
  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const redis = getRedisClient();

      const identifier = config.keyByEmail
        ? `${req.ip}:${req.body.email?.toLowerCase() || "unknown"}`
        : req.ip || "unknown";

      const key = `rl:${prefix}:${identifier}`;
      const windowSec = Math.ceil(config.windowMs / 1000);

      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, windowSec);
      }

      const ttl = await redis.ttl(key);
      const remaining = Math.max(0, config.max - current);

      res.setHeader("X-RateLimit-Limit", config.max);
      res.setHeader("X-RateLimit-Remaining", remaining);
      res.setHeader("X-RateLimit-Reset", Math.ceil(Date.now() / 1000) + ttl);

      if (current > config.max) {
        Logger.warn(`Rate limit hit: [${prefix}] ${identifier}`);
        res.status(429).json({
          success: false,
          message:
            config.message || "Too many requests. Please try again later.",
          retryAfter: ttl,
        });
        return;
      }

      next();
    } catch (error) {
      Logger.error(`Rate limiter error [${prefix}]:`, error);
      next();
    }
  };
}

const FAILED_LOGIN_PREFIX = "failed:";
const FAILED_LOGIN_MAX = 5;
const FAILED_LOGIN_WINDOW_SEC = 15 * 60;

function failedLoginKey(email: string, ip: string): string {
  return `${FAILED_LOGIN_PREFIX}${ip}:${email.toLowerCase()}`;
}

export async function trackFailedLogin(
  email: string,
  ip: string,
): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = failedLoginKey(email, ip);
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, FAILED_LOGIN_WINDOW_SEC);
    }
  } catch (error) {
    Logger.error("trackFailedLogin error:", error);
  }
}

export async function resetFailedLogins(
  email: string,
  ip: string,
): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.del(failedLoginKey(email, ip));
  } catch (error) {
    Logger.error("resetFailedLogins error:", error);
  }
}

export async function checkFailedLogins(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { email } = req.body;
    if (!email) return next();

    const redis = getRedisClient();
    const key = failedLoginKey(email, req.ip || "unknown");
    const raw = await redis.get(key);

    if (!raw) return next(); // No failed attempts yet

    const count = parseInt(raw, 10);
    if (count >= FAILED_LOGIN_MAX) {
      const ttl = await redis.ttl(key);
      res.status(429).json({
        success: false,
        message: `Account temporarily locked. Too many failed attempts. Try again in ${Math.ceil(ttl / 60)} minutes.`,
        retryAfter: ttl,
      });
      return;
    }

    // Attach remaining attempts so the controller can include it in the error message
    req.remainingLoginAttempts = Math.max(0, FAILED_LOGIN_MAX - count);
    next();
  } catch (error) {
    Logger.error("checkFailedLogins error:", error);
    next(); // Fail open
  }
}

export const limiters = {
  login: createRateLimiter("login", {
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many login attempts. Please try again after 15 minutes.",
    keyByEmail: true,
  }),

  register: createRateLimiter("register", {
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: "Too many registration attempts. Please try again after an hour.",
  }),

  activate: createRateLimiter("activate", {
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: "Too many activation attempts. Please try again after an hour.",
  }),

  passwordRecovery: createRateLimiter("recovery", {
    windowMs: 60 * 60 * 1000,
    max: 3,
    message: "Too many recovery attempts. Please try again after an hour.",
  }),

  emailChange: createRateLimiter("email-change", {
    windowMs: 24 * 60 * 60 * 1000,
    max: 2,
    message: "Too many email change attempts. Please try again after 24 hours.",
  }),

  resendActivation: createRateLimiter("resend-activation", {
    windowMs: 60 * 60 * 1000,
    max: 3,
    message:
      "Too many resend attempts. Please wait an hour before trying again.",
    keyByEmail: true,
  }),

  api: createRateLimiter("api", {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Too many API requests. Please slow down.",
  }),
};
