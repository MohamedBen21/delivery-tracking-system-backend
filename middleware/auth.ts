import { Request, Response, NextFunction } from "express";
import { catchAsyncError } from "./catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import jwt, { JwtPayload } from "jsonwebtoken";
import { getRedisClient } from "../databases/Redis.database";
import { IUser } from "../models/user.model";

export const isAuthenticated = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const access_token = req.cookies.accessToken || req.cookies.access_token;

    if (!access_token) {
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );
    }

    try {
      const decoded = jwt.verify(
        access_token,
        process.env.ACCESS_TOKEN as string,
      ) as JwtPayload;

      if (!decoded || !decoded.id) {
        return next(new ErrorHandler("Access token is invalid", 401));
      }

      // Get Redis client
      const redis = getRedisClient();

      // Get user from Redis
      const user = await redis.get(`user:${decoded.id}`); // Adding prefix for better organization

      if (!user) {
        return next(
          new ErrorHandler("Session expired. Please login again", 401),
        );
      }

      req.user = JSON.parse(user);
      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return next(new ErrorHandler("Access token expired", 401));
      }
      if (error instanceof jwt.JsonWebTokenError) {
        return next(new ErrorHandler("Invalid access token", 401));
      }
      return next(new ErrorHandler("Authentication failed", 401));
    }
  },
);

// Alternative version without Redis (using JWT only)
export const isAuthenticatedJWTOnly = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const access_token = req.cookies.accessToken || req.cookies.access_token;

    if (!access_token) {
      return next(
        new ErrorHandler("Please login to access this resource", 401),
      );
    }

    try {
      const decoded = jwt.verify(
        access_token,
        process.env.ACCESS_TOKEN as string,
      ) as JwtPayload;

      if (!decoded || !decoded.id) {
        return next(new ErrorHandler("Access token is invalid", 401));
      }

      // Create user object from JWT claims
      req.user = {
        _id: decoded.id,
        email: decoded.email,
        role: decoded.role,
        firstName: decoded.firstName,
        lastName: decoded.lastName,
        phone: decoded.phone,
        status: decoded.status,
      } as IUser;

      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return next(new ErrorHandler("Access token expired", 401));
      }
      return next(new ErrorHandler("Invalid access token", 401));
    }
  },
);

export const authorizeRoles = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ErrorHandler("Authentication required", 401));
    }

    if (!roles.includes(req.user.role)) {
      return next(
        new ErrorHandler(
          `Role: ${req.user.role} is not allowed to access this resource`,
          403,
        ),
      );
    }
    next();
  };
};
