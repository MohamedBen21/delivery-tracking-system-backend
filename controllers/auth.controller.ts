import { NextFunction, Request, Response } from "express";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import User from "../models/user.model";
import ErrorHandler from "../utils/ErrorHandler";
import {
  generateActivationToken,
  generateChangeEmailToken,
  generateRecoveryToken,
  verifyToken,
} from "../utils/Token.util";
import axios from "axios";
import path from "path";
import { deleteImage } from "../utils/Multer.util";
import fs from "fs";
import { Mail } from "../utils/Mail.util";
import { decrypt } from "../utils/Crypto.util";
import ejs from "ejs";
import {
  resetFailedLogins,
  trackFailedLogin,
} from "../middleware/redisRateLimiter";
import { clearTokens, sendToken } from "../utils/Token.util";

export const register = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { firstName, lastName, email, phone, password } = req.body;

      if (!firstName || !lastName || !password || !email) {
        return next(new ErrorHandler("All fields are required", 400));
      }

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return next(new ErrorHandler("User already exists", 400));
      }

      const { activation_token, activation_number } = generateActivationToken({
        firstName,
        lastName,
        phone,
        email,
        password,
      });

      const activation_url = `http://localhost:3000/activation/${activation_token}`;

      const templatePath = path.join(__dirname, "..", "mails", "activate.ejs");

      if (fs.existsSync(templatePath)) {
        const template = fs.readFileSync(templatePath, "utf8");
        const html = ejs.render(template, {
          activation_url,
          email,
          activation_number,
        });

        await Mail.sendMail({
          from: `Fennec Wear <${process.env.SMTP_MAIL}>`,
          to: email,
          subject: `Activation Code is ${activation_number}`,
          html,
        });
      }

      res.cookie("activation_token", activation_token, {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        maxAge: 30 * 60 * 1000,
      });

      res.status(200).json({
        success: true,
        message: "Please check your DM to activate your account",
        activation_token, // Only for development, remove in production
        activation_number, // Only for development, remove in production
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error registering user.", 500),
      );
    }
  },
);

export const resendActivation = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email } = req.body;

      if (!email) {
        return next(new ErrorHandler("Email is required.", 400));
      }

      const existingUser = await User.findOne({ email });
      if (existingUser && existingUser.status === "active") {
        return next(
          new ErrorHandler(
            "This account is already active. Please log in.",
            400,
          ),
        );
      }

      const currentToken =
        req.body.activation_token || req.cookies.activation_token;

      if (!currentToken) {
        return next(
          new ErrorHandler(
            "No pending registration found. Please register again.",
            404,
          ),
        );
      }

      const secret = process.env.JWT_SECRET || "default_secret_key";
      const decoded = verifyToken(currentToken, secret) as {
        iv: string;
        data: string;
      };

      if (typeof decoded === "string") {
        return next(
          new ErrorHandler(
            "Your registration session has expired. Please register again.",
            400,
          ),
        );
      }

      const {
        firstName,
        lastName,
        phone,
        email: tokenEmail,
        password,
      } = decrypt(decoded.data, decoded.iv);

      if (tokenEmail.toLowerCase() !== email.toLowerCase()) {
        return next(
          new ErrorHandler(
            "Email does not match the pending registration.",
            400,
          ),
        );
      }

      const { activation_token, activation_number } = generateActivationToken({
        firstName,
        lastName,
        phone,
        email: tokenEmail,
        password,
      });

      const activation_url = `http://localhost:3000/activation/${activation_token}`;

      const templatePath = path.join(__dirname, "..", "mails", "activate.ejs");

      if (fs.existsSync(templatePath)) {
        const template = fs.readFileSync(templatePath, "utf8");
        const html = ejs.render(template, {
          activation_url,
          email: tokenEmail,
          activation_number,
        });

        await Mail.sendMail({
          from: `Fennec Wear <${process.env.SMTP_MAIL}>`,
          to: tokenEmail,
          subject: `Your new Activation Code is ${activation_number}`,
          html,
        });
      }

      res.cookie("activation_token", activation_token, {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        maxAge: 30 * 60 * 1000, // 30 minutes
      });

      res.status(200).json({
        success: true,
        message:
          "A new activation email has been sent. Please check your inbox.",
        // Only for development — remove in production:
        activation_token,
        activation_number,
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(
          error.message || "Error resending activation email.",
          500,
        ),
      );
    }
  },
);

export const activate = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { activation_token: ac_token, activation_number: ac_number } =
        req.body;

      const activation_token = ac_token || req.cookies.activation_token;

      if (!activation_token) {
        return next(new ErrorHandler("Activation token not found", 404));
      }

      if (!ac_number) {
        return next(new ErrorHandler("Activation number not found", 404));
      }

      const secret = process.env.JWT_SECRET || "default_secret_key";
      const decoded = verifyToken(activation_token, secret) as {
        iv: string;
        data: string;
      };

      if (typeof decoded === "string") {
        return next(new ErrorHandler("Invalid activation token", 400));
      }

      const { firstName, lastName, phone, email, password, activation_number } =
        decrypt(decoded.data, decoded.iv);

      if (ac_number !== activation_number) {
        return next(new ErrorHandler("Invalid activation number", 400));
      }

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return next(new ErrorHandler("User already exists", 400));
      }

      const newUser = new User({
        firstName,
        lastName,
        phone,
        email,
        passwordHash: password,
        status: "active",
        role: "client",
      });

      await newUser.save();

      res.clearCookie("activation_token", {
        httpOnly: true,
        sameSite: "none",
        secure: true,
      });

      sendToken(newUser, 200, res, "Account activated successfully");
      await sendToken(newUser, 200, res);
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error activating account.", 500),
      );
    }
  },
);

export const login = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password } = req.body;
      const ip = req.ip || "unknown";

      if (!email || !password) {
        return next(new ErrorHandler("Email and password are required", 400));
      }

      const user = await User.findOne({ email }).select("+passwordHash");
      const isMatch = await user?.comparePassword(password);

      if (!user || !isMatch) {
        // Track the failure — this increments the Redis counter
        await trackFailedLogin(email, ip);

        // req.remainingLoginAttempts was attached by checkFailedLogins middleware
        const remaining = Math.max(0, (req.remainingLoginAttempts ?? 5) - 1);

        return next(
          new ErrorHandler(
            `Invalid credentials. You have ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
            401,
          ),
        );
      }

      if (user.status === "suspended" || user.status === "inactive") {
        return next(new ErrorHandler(`Account is ${user.status}.`, 403));
      }

      // On success, clear failed attempt counter so the user isn't penalised
      await resetFailedLogins(email, ip);

      await sendToken(user, 200, res);
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error logging in to account.", 500),
      );
    }
  },
);

export const logout = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.user?._id) {
        await clearTokens(req.user._id.toString(), res);
      }

      res.status(200).json({
        success: true,
        message: "Logout successful",
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(error?.message || "Error logging out.", 500),
      );
    }
  },
);

export const googleLogin = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { credential: accessToken } = req.body;

    try {
      const { data } = await axios.get(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const { email, name, picture } = data;

      if (!email) {
        return next(new ErrorHandler("Invalid user info from Google", 400));
      }

      let user = await User.findOne({ email });

      if (!user) {
        user = new User({
          email,
          username: name,
          avatar: picture,
          googleAccount: true,
          password: null,
        });
        await user.save();
      }

      sendToken(user, 200, res, "Google login successful");
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Invalid Google login.", 500),
      );
    }
  },
);

export const refreshTokens = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const refreshToken = req.cookies.refresh_token;
      if (!refreshToken) {
        res.status(401).json({ message: "Refresh token not found" });
        return;
      }

      const secret = process.env.REFRESH_TOKEN || "default_refresh_secret_key";
      const decoded = verifyToken(refreshToken, secret);

      if (typeof decoded === "string") {
        res.status(400).json({ message: "Invalid refresh token" });
        return;
      }

      const userId = decoded.userId;
      const user = await User.findById(userId);

      if (!user) {
        return next(new ErrorHandler(`ser not found.`, 404));
      }

      if (user.status === "suspended" || user.status === "inactive") {
        return next(new ErrorHandler(`User is ${user.status}.`, 403));
      }

      sendToken(user, 200, res, "Tokens refreshed successfully");
    } catch (error: any) {
      return next(
        new ErrorHandler(error?.message || "Failed to refresh tokens.", 500),
      );
    }
  },
);

export const updateUser = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { firstName, lastName, password, newPassword, email } = req.body;

      const filename = req.file?.filename;
      const userId = req.user?._id;
      const user = await User.findById(userId).select("+password");
      if (!user) {
        return next(new ErrorHandler("User not found.", 404));
      }

      if (newPassword && password) {
        const isMatch = await user.comparePassword(password.toString());

        if (!isMatch) {
          return next(
            new ErrorHandler("The password you provided is not correct.", 400),
          );
        }
        user.passwordHash = newPassword;
      }

      if (firstName) user.firstName = firstName;
      if (lastName) user.lastName = lastName;

      if (filename) {
        if (user.imageUrl && user.imageUrl !== "/uploads/users/user.jpeg")
          deleteImage(user.imageUrl);
        const imageUrl = `/uploads/users/${filename}`;
        user.imageUrl = imageUrl;
      }

      if (email && email !== user.email) {
        const { email_token, activation_number } = generateChangeEmailToken(
          user.email,
          email,
        );

        const email_url = `http://localhost:5173/confirm-email/${email_token}`;

        const templatePath = path.join(
          __dirname,
          "..",
          "mails",
          "updateEmail.ejs",
        );

        if (fs.existsSync(templatePath)) {
          const template = fs.readFileSync(templatePath, "utf8");
          const html = ejs.render(template, {
            email_url,
            email,
            activation_number,
          });

          await Mail.sendMail({
            from: `Fennec Wear <${process.env.SMTP_MAIL}>`,
            to: email,
            subject: `Activation Code is ${activation_number}`,
            html,
          });
        }

        res.cookie("email_token", email_token, {
          httpOnly: true,
          sameSite: "none",
          secure: true,
          maxAge: 30 * 60 * 1000,
        });
      }

      await user.save();

      res.status(200).json({
        success: true,
        message: "User Updated Successfully",
        user: {
          ...user.toObject(),
          password: undefined,
        },
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(error?.message || "Error Updating Profile.", 500),
      );
    }
  },
);

export const changeEmail = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email_token: em_token, activation_number: ac_number } = req.body;

      const email_token = em_token || req.cookies.email_token;

      if (!email_token) {
        return next(new ErrorHandler("Email Token not found", 404));
      }

      if (!ac_number) {
        return next(new ErrorHandler("Activation number not found", 404));
      }

      const secret = process.env.JWT_SECRET || "default_secret_key";
      const decoded = verifyToken(email_token, secret) as {
        iv: string;
        data: string;
      };

      if (typeof decoded === "string") {
        return next(new ErrorHandler("Invalid email token", 400));
      }

      const { oldEmail, newEmail, activation_number } = decrypt(
        decoded.data,
        decoded.iv,
      );

      if (ac_number !== activation_number) {
        return next(new ErrorHandler("Invalid activation number", 400));
      }

      const user = await User.findOne({ email: oldEmail });
      if (!user) {
        return next(new ErrorHandler("User not found.", 404));
      }

      user.email = newEmail;

      await user.save();

      res.clearCookie("email_token", {
        httpOnly: true,
        sameSite: "none",
        secure: true,
      });

      res.status(200).json({
        success: true,
        message: "Account activated successfully",
        user: {
          ...user.toObject(),
          password: undefined,
        },
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error changing email.", 500),
      );
    }
  },
);

export const passwordRecovery = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email } = req.body;
      if (!email) {
        return next(new ErrorHandler("Email is required.", 400));
      }

      const user = await User.findOne({ email });
      if (!user) {
        return next(new ErrorHandler("User not found.", 404));
      }

      const recovery_token = generateRecoveryToken(email);
      const ORIGIN = process.env.ORIGIN || "http://localhost:5173";
      const resetUrl = `${ORIGIN}/reset-password/${recovery_token}`;

      const template = fs.readFileSync(
        path.join(__dirname, "..", "mails", "recovery.ejs"),
        "utf8",
      );

      const html = ejs.render(template, { resetUrl, email });

      await Mail.sendMail({
        from: `FENNEC <${process.env.SMTP_MAIL}>`,
        to: email,
        subject: "Password Recovery Request",
        html,
      });

      res
        .status(200)
        .json({ success: true, message: "Reset link sent to your email." });
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error sending recovery email.", 500),
      );
    }
  },
);

export const resetPassword = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      let { newPassword, recovery_token } = req.body;
      if (!recovery_token) {
        return next(new ErrorHandler("Recovery token is required.", 403));
      }

      const secret = process.env.REFRESH_TOKEN || "default_refresh_secret_key";
      const decoded = verifyToken(recovery_token, secret);
      if (typeof decoded === "string") {
        return next(new ErrorHandler("Invalid activation token", 400));
      }

      const email = decrypt(decoded.data, decoded.iv);
      const user = await User.findOne({
        email,
      });

      if (!user) {
        return next(new ErrorHandler("User not found.", 404));
      }

      user.passwordHash = newPassword;
      await user.save();

      res
        .status(200)
        .json({ success: true, message: "Password has been reset" });
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error resetting password.", 500),
      );
    }
  },
);
