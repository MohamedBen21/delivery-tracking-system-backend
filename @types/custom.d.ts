import { Request } from "express";
import { IUser } from "../models/user.model";

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      file?: Express.Multer.File;
      rateLimit?: {
        current: number;
        limit: number;
        remaining: number;
        reset: number;
      };
      remainingLoginAttempts?: number;
    }
  }
}
