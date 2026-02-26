import jwt, { JwtPayload } from "jsonwebtoken";
import { encrypt } from "./Crypto.util";
import { Response } from "express";
import dotenv from "dotenv";
import { Logger } from "./Logger.util";
import { getRedisClient } from "../databases/Redis.database";
import { IUser } from "../models/user.model";

dotenv.config();

const secret = process.env.JWT_SECRET || "default_secret_key";
const accessTokenExpire = parseInt(process.env.ACCESS_TOKEN_EXPIRE || "15", 10);
const refreshTokenExpire = parseInt(
  process.env.REFRESH_TOKEN_EXPIRE || "7",
  10,
);

interface ITokenOptions {
  expires: Date;
  maxAge: number;
  httpOnly: boolean;
  sameSite: "lax" | "strict" | "none" | undefined;
  secure?: boolean;
  path?: string;
  domain?: string;
}

export const accessTokenOptions: ITokenOptions = {
  expires: new Date(Date.now() + accessTokenExpire * 60 * 1000),
  maxAge: accessTokenExpire * 60 * 1000,
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export const refreshTokenOptions: ITokenOptions = {
  expires: new Date(Date.now() + refreshTokenExpire * 24 * 60 * 60 * 1000),
  maxAge: refreshTokenExpire * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export const generateActivationToken = ({
  firstName,
  lastName,
  email,
  password,
  phone,
}: {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
}): { activation_token: string; activation_number: string } => {
  const activation_number = Math.floor(1000 + Math.random() * 9000).toString();

  const { data, iv } = encrypt({
    firstName,
    lastName,
    phone,
    email,
    password,
    activation_number,
  });

  const activation_token = jwt.sign({ data, iv }, secret, {
    expiresIn: "30m",
  });
  return { activation_token, activation_number };
};

export const generateChangeEmailToken = (
  oldEmail: string,
  newEmail: string,
): { email_token: string; activation_number: string } => {
  const activation_number = Math.floor(1000 + Math.random() * 9000).toString();

  const { data, iv } = encrypt({
    oldEmail,
    newEmail,
    activation_number,
  });

  const email_token = jwt.sign({ data, iv }, secret, {
    expiresIn: "30m",
  });
  return { email_token, activation_number };
};

export const generateRecoveryToken = (email: string): string => {
  const { data, iv } = encrypt(email);
  return jwt.sign({ data, iv }, secret, {
    expiresIn: "30m",
  });
};

export const verifyToken = (
  token: string,
  secret: string,
): string | JwtPayload => {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    throw new Error("Invalid token");
  }
};

export const sendToken = async (
  user: IUser,
  statusCode: number,
  res: Response,
  message?: string,
) => {
  try {
    const accessToken = user.SignAccessToken();
    const refreshToken = user.SignRefreshToken();

    // Store user in Redis with 7 days expiry (matching refresh token)
    const redis = getRedisClient();
    const userId = user._id?.toString();

    if (!userId) {
      throw new Error("User ID not found");
    }

    // Store user data in Redis with proper expiration
    await redis.setex(
      `user:${userId}`,
      refreshTokenExpire * 24 * 60 * 60, // Convert days to seconds
      JSON.stringify({
        _id: user._id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        status: user.status,
        imageUrl: user.imageUrl,
      }),
    );

    // Store refresh token in Redis for invalidation if needed
    await redis.setex(
      `refresh:${userId}`,
      refreshTokenExpire * 24 * 60 * 60,
      refreshToken,
    );

    // Set cookies
    res.cookie("accessToken", accessToken, accessTokenOptions);
    res.cookie("refreshToken", refreshToken, refreshTokenOptions);

    // Also set for compatibility with both naming conventions
    res.cookie("access_token", accessToken, accessTokenOptions);
    res.cookie("refresh_token", refreshToken, refreshTokenOptions);

    // Remove sensitive data
    const userWithoutPassword = { ...user.toObject(), passwordHash: undefined };

    res.status(statusCode).json({
      success: true,
      message,
      user: userWithoutPassword,
      accessToken,
    });
  } catch (error) {
    Logger.error("Error in sendToken:", error);
    throw error;
  }
};

// Function to clear tokens on logout
export const clearTokens = async (userId: string, res: Response) => {
  try {
    const redis = getRedisClient();

    // Remove user from Redis
    await redis.del(`user:${userId}`);
    await redis.del(`refresh:${userId}`);

    // Clear cookies
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
    };

    res.clearCookie("accessToken", cookieOptions);
    res.clearCookie("refreshToken", cookieOptions);
    res.clearCookie("access_token", cookieOptions);
    res.clearCookie("refresh_token", cookieOptions);
  } catch (error) {
    Logger.error("Error clearing tokens:", error);
  }
};
