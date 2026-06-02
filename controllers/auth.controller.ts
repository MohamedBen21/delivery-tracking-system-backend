require("dotenv").config();
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
import fs from "fs";
import { Mail } from "../utils/Mail.util";
import { decrypt } from "../utils/Crypto.util";
import ejs from "ejs";
import {
  resetFailedLogins,
  trackFailedLogin,
} from "../middleware/redisRateLimiter";
import { clearTokens, sendToken } from "../utils/Token.util";
import userModel from "../models/user.model";
import { getRedisClient } from "../databases/Redis.database";
import jwt from "jsonwebtoken";
import twilio from "twilio";
import sendSMS from "../utils/sendSMS";
import mongoose from "mongoose";
import adminModel from "../models/admin.model";
import ManagerModel from "../models/manager.model";
import clientModel from "../models/client.model";
import delivererModel from "../models/deliverer.model";
import transporterModel from "../models/transporter.model";
import SupervisorModel from "../models/supervisor.model";
import freelancerModel from "../models/freelancer.model";
import { notifyAdminsNewEntityPending, sendManagerAccountCreatedNotification, sendWelcomeNotification } from "../services/notification.service";
import { geocodeConfirmedPlace, reverseGeocode, searchLocalPlaces } from "../services/geocoding.service";
import { Coordinates } from "../services/eta.types";
import { getOSRMRoute } from "../services/osrm.service";
import { estimateTrafficFactor } from "../services/traffic.service";
import { fetchWeatherFactor } from "../services/weather.service";
import LoaderModel from "../models/loader.model";
import CashierModel from "../models/cashier.model";
import { v2  } from 'cloudinary';

// Configure Cloudinary
v2.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_SECRET_KEY
});



export const register = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { firstName, lastName, email, phone, password } = req.body;

      if (!firstName || !lastName || !password || !email) {
        return next(new ErrorHandler("All fields are required", 400));
      }

      const normalizedPhone = User.normalizePhone(phone);

      const existingUser = await User.findOne({ 
        $or: [
          { email },
          { phone: normalizedPhone }
        ]
      });

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
          from: `Delivery Tracking Dz Wear <${process.env.SMTP_MAIL}>`,
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
          from: `Delivery Tracking Dz Wear <${process.env.SMTP_MAIL}>`,
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
    const { activation_token: ac_token, activation_number: ac_number } = req.body;
    const activation_token = ac_token || req.cookies.activation_token;
 
    if (!activation_token) {
      return next(new ErrorHandler("Activation token not found", 404));
    }
    if (!ac_number) {
      return next(new ErrorHandler("Activation number is required", 400));
    }
 
    const secret = process.env.JWT_SECRET || "default_secret_key";
    const decoded = verifyToken(activation_token, secret) as { iv: string; data: string };
 
    if (typeof decoded === "string") {
      return next(new ErrorHandler("Invalid or expired activation token", 400));
    }
 
    const { firstName, lastName, phone, email, password, activation_number } =
      decrypt(decoded.data, decoded.iv);
 
    if (ac_number !== activation_number) {
      return next(new ErrorHandler("Invalid activation code", 400));
    }
 
    const normalizedPhone = User.normalizePhone(phone);

    const existingUser = await User.findOne({ 
      $or: [
        { email },
        { phone: normalizedPhone }
      ]
    });

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
 
    

    sendWelcomeNotification(
      newUser._id.toString(),
      newUser.firstName,
      newUser.role
    ).catch(error => {

      console.error('Welcome notification sending failed:', error);

    });

    await sendToken(newUser, 200, res, "Account activated successfully");
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
      const refreshToken = req.cookies.refreshToken;
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

      const userId = decoded.id;
      const user = await User.findById(userId);

      if (!user) {
        return next(new ErrorHandler(`user not found.`, 404));
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

      const userId = req.user?._id;
      const user = await User.findById(userId).select("+passwordHash");
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

      // ── Handle email change ──────────────────────────────────────────
      if (email && email !== user.email) {
        const { email_token, activation_number } =
          generateChangeEmailToken(user.email, email);

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
            from: `Delivery Tracking Dz Wear <${process.env.SMTP_MAIL}>`,
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

        // Don't save the email yet — wait for verification
        res.status(200).json({
          success: true,
          message: "Verification email sent. Please check your new email to confirm the change.",
          isEmailChange: true,
          email_token,
        });
      }

      // ── No email change — save normally ──────────────────────────────
      await user.save();

      res.status(200).json({
        success: true,
        message: "User Updated Successfully",
        isEmailChange: false,
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
        from: `Delivery Tracking Dz <${process.env.SMTP_MAIL}>`,
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





const UPLOAD_FOLDER   = "profile_pictures";
const MAX_FILE_BYTES  = 5 * 1024 * 1024; // 5 MB
const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];



async function uploadToCloudinary(
  source: string,
): Promise<{ public_id: string; url: string }> {
  const result = await v2.uploader.upload(source, {
    folder:        UPLOAD_FOLDER,
    width:         300,
    height:        300,
    crop:          "fill",
    gravity:       "face",          
    quality:       "auto:good",
    fetch_format:  "auto",
    resource_type: "image",
    allowed_formats: ALLOWED_FORMATS,
  });

  return {
    public_id: result.public_id,
    url:       result.secure_url,
  };
}



export const updateProfilePicture = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    
    const userId = req.user?._id;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    let uploadSource: string | null = null;

    if (req.file) {
      if (req.file.size > MAX_FILE_BYTES) {
        return next(
          new ErrorHandler(
            `File too large. Maximum allowed size is ${MAX_FILE_BYTES / 1024 / 1024} MB`,
            400,
          ),
        );
      }

      const ext = req.file.mimetype.split("/")[1]?.toLowerCase();
      
      if (!ALLOWED_FORMATS.includes(ext ?? "")) {
        return next(
          new ErrorHandler(
            `Invalid file type. Allowed formats: ${ALLOWED_FORMATS.join(", ")}`,
            400,
          ),
        );
      }

      uploadSource = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    } else if (typeof req.body?.image === "string" && req.body.image.trim()) {
      uploadSource = req.body.image.trim();
    }

    if (!uploadSource) {
      return next(
        new ErrorHandler(
          "No image provided. Send a file under the 'image' field or a base64/URL string in the request body.",
          400,
        ),
      );
    }

    const user = await userModel.findById(userId).lean();
    if (!user) {
      return next(new ErrorHandler("User not found.", 404));
    }

    // Check if there's an existing image (public_id exists and is not null)
    const hasOldImage = user.imageUrl && user.imageUrl.public_id !== null;
    
    if (hasOldImage) {
      try {
        await v2.uploader.destroy(user.imageUrl!.public_id);
      } catch (err) {
        console.warn(`[updateProfilePicture] Failed to delete old image ${user.imageUrl!.public_id}:`, err);
      }
    }

    const { public_id, url } = await uploadToCloudinary(uploadSource);

    // Update the entire imageUrl object
    const updatedUser = await userModel.findByIdAndUpdate(
      userId,
      { 
        $set: { 
          imageUrl: { public_id, url }
        } 
      },
      { new: true },
    ).select("firstName lastName email phone imageUrl role status");

    try {
      const redis = getRedisClient();
      const cached = await redis.get(`user:${userId.toString()}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.imageUrl = { public_id, url };
        await redis.setex(
          `user:${userId.toString()}`,
          7 * 24 * 60 * 60,
          JSON.stringify(parsed),
        );
      }
    } catch (err) {
      console.warn("[updateProfilePicture] Redis cache update failed:", err);
    }

    return res.status(200).json({
      success: true,
      message: "Profile picture updated successfully",
      data: {
        imageUrl: { public_id, url },
        user: updatedUser,
      },
    });
  },
);



export const deleteProfilePicture = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;

    if (!userId) {
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    const user = await userModel.findById(userId).lean();
    if (!user) {
      return next(new ErrorHandler("User not found.", 404));
    }

    // Check if there's an existing image (public_id exists and is not null)
    const hasOldImage = user.imageUrl && user.imageUrl.public_id !== null;
    
    if (!hasOldImage) {
      return next(new ErrorHandler("No profile picture to delete.", 400));
    }

    try {
      await v2.uploader.destroy(user.imageUrl!.public_id);
    } catch (err) {
      console.warn(`[deleteProfilePicture] Failed to delete image ${user.imageUrl!.public_id}:`, err);
    }

    // Reset to null (not empty strings)
    await userModel.findByIdAndUpdate(userId, { 
      $set: { imageUrl: {public_id:null , url:null} } 
    });

    try {
      const redis = getRedisClient();
      const cached = await redis.get(`user:${userId.toString()}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.imageUrl = null;
        await redis.setex(
          `user:${userId.toString()}`,
          7 * 24 * 60 * 60,
          JSON.stringify(parsed),
        );
      }
    } catch (err) {
      console.warn("[deleteProfilePicture] Redis cache update failed:", err);
    }

    return res.status(200).json({
      success: true,
      message: "Profile picture removed successfully",
    });
  },
);




const generateOTP = (): string =>
  Math.floor(1000 + Math.random() * 9000).toString();


const createOTPToken = (
  otp: string,
  contact: { email?: string; phone?: string },
): string => {
  const expireMinutes = parseInt(process.env.OTP_EXPIRE ?? "10", 10);
  return jwt.sign(
    { otp, ...contact },
    process.env.OTP_SECRET as string,
    { expiresIn: expireMinutes * 60 }, 
  );
};



const createResetToken = (userId: string): string =>
  jwt.sign(
    { userId, verified: true },
    process.env.RESET_TOKEN_SECRET as string,
    { expiresIn: "15m" },
  );


const ALLOWED_ROLES = ["deliverer", "transporter", "cashier", "loader"];

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);



export const requestPasswordReset = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { identifier } = req.body as { identifier?: string };

      if (!identifier || typeof identifier !== "string") {
        return next(new ErrorHandler("Email or phone number is required.", 400));
      }

      const sanitized = identifier.trim().toLowerCase();


      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const phoneRegex = /^(\+213|0)(5|6|7)[0-9]{8}$/;

      const isEmail = emailRegex.test(sanitized);
      const isPhone = phoneRegex.test(identifier.trim());

      if (!isEmail && !isPhone) {
        return next(
          new ErrorHandler(
            "Please provide a valid email address or Algerian phone number.",
            400,
          ),
        );
      }


      let query;

      if (isEmail) {
        query = { email: sanitized };
      } else {

        const normalizedPhone = User.normalizePhone(identifier.trim());
        query = { phone: normalizedPhone };
      }

      const user = await userModel.findOne(query);

      if (!user) {

        return next(
          new ErrorHandler(
            "Account not found with the provided email or phone number.",
            404,
          ),
        );
      }


      if (!ALLOWED_ROLES.includes(user.role)) {
        return next(
          new ErrorHandler(
            "Password reset is only available for deliverers ,transporters , chasier and loaders.",
            403,
          ),
        );
      }


      if (user.status === "suspended") {
        return next(new ErrorHandler("This account has been suspended.", 403));
      }

      if (user.status === "inactive") {
        return next(new ErrorHandler("This account is inactive.", 403));
      }


      const otp = generateOTP();
      const otpToken = isEmail
        ? createOTPToken(otp, { email: sanitized })
        : createOTPToken(otp, { phone: identifier.trim() });


      if (isEmail) {
        const templatePath = path.join(
          __dirname,
          "..",
          "mails",
          "reset_password_otp.ejs",
        );

        let html: string;
        if (fs.existsSync(templatePath)) {
          const template = fs.readFileSync(templatePath, "utf8");
          html = ejs.render(template, {
            firstName: user.firstName,
            otp,
            expireMinutes: process.env.OTP_EXPIRE ?? 10,
          });
        } else {
  
          html = `<p>Hi ${user.firstName},</p>
                  <p>Your password reset OTP is: <strong>${otp}</strong></p>
                  <p>It expires in ${process.env.OTP_EXPIRE ?? 10} minutes.</p>`;
        }

        await Mail.sendMail({
          from: `Delivery tracking system <${process.env.SMTP_MAIL}>`,
          to: sanitized,
          subject: `Your password reset code: ${otp}`,
          html,
        });

        res.status(200).json({
          success: true,
          message: `OTP sent to your email: ${sanitized}`,
          otp_token: otpToken,
          method: "email",

        });
      } else {

        const smsSent = await sendSMS({
            to: identifier.trim(),
            message: `Your OTP for password reset is: ${otp}. Valid for ${process.env.OTP_EXPIRE} minutes.`,
          });

        if (!smsSent) {
          return next(
            new ErrorHandler("Failed to send OTP. Please try again.", 500)
          );
        }

        res.status(200).json({
          success: true,
          message: `OTP sent to your phone: ${identifier.trim()}`,
          otp_token: otpToken,
          method: "phone",

        });
      }
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error sending OTP.", 500));
    }
  },
);



export const verifyOTP = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { otp_token, otp } = req.body as {
        otp_token?: string;
        otp?: string;
      };

      if (!otp_token || !otp) {
        return next(new ErrorHandler("OTP token and OTP are required.", 400));
      }


      let decoded: { otp: string; email?: string; phone?: string };
      try {
        decoded = jwt.verify(
          otp_token,
          process.env.OTP_SECRET as string,
        ) as typeof decoded;
      } catch (err: any) {
        if (err.name === "TokenExpiredError") {
          return next(new ErrorHandler("OTP has expired. Please request a new one.", 400));
        }
        return next(new ErrorHandler("Invalid OTP token.", 400));
      }


      if (decoded.otp !== otp.trim()) {
        return next(new ErrorHandler("Incorrect OTP. Please try again.", 400));
      }


      let query;

      if (decoded.email) {

        query = { email: decoded.email };
      } else if (decoded.phone) {

        const normalizedPhone = User.normalizePhone(decoded.phone);
        query = { phone: normalizedPhone };
      }

      const user = await userModel.findOne(query);

      if (!user) {
        return next(new ErrorHandler("User not found.", 404));
      }

      if (!ALLOWED_ROLES.includes(user.role)) {
        return next(new ErrorHandler("Unauthorized role.", 403));
      }


      const reset_token = createResetToken(user._id.toString());

      res.status(200).json({
        success: true,
        message: "OTP verified successfully. Proceed to reset your password.",
        reset_token,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message || "Error verifying OTP.", 500));
    }
  },
);



export const confirmPasswordReset = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { reset_token, new_password, confirm_password } = req.body as {
        reset_token?: string;
        new_password?: string;
        confirm_password?: string;
      };


      if (!reset_token || !new_password || !confirm_password) {
        return next(new ErrorHandler("All fields are required.", 400));
      }

      if (new_password !== confirm_password) {
        return next(new ErrorHandler("Passwords do not match.", 400));
      }

      if (new_password.length < 6) {
        return next(
          new ErrorHandler("Password must be at least 6 characters long.", 400),
        );
      }


      let decoded: { userId: string; verified: boolean };
      try {
        decoded = jwt.verify(
          reset_token,
          process.env.RESET_TOKEN_SECRET as string,
        ) as typeof decoded;
      } catch (err: any) {
        if (err.name === "TokenExpiredError") {
          return next(
            new ErrorHandler(
              "Reset session has expired. Please start over.",
              400,
            ),
          );
        }
        return next(new ErrorHandler("Invalid reset token.", 400));
      }

      if (!decoded.verified) {
        return next(new ErrorHandler("Reset token is not verified.", 400));
      }


      const user = await userModel
        .findById(decoded.userId)
        .select("+passwordHash role status");

      if (!user) {
        return next(new ErrorHandler("User not found.", 404));
      }

      if (!ALLOWED_ROLES.includes(user.role)) {
        return next(new ErrorHandler("Unauthorized role.", 403));
      }

      if (user.status === "suspended") {
        return next(new ErrorHandler("This account has been suspended.", 403));
      }


      user.passwordHash = new_password;
      await user.save();

      res.status(200).json({
        success: true,
        message: "Password has been reset successfully. You can now log in.",
      });
    } catch (error: any) {
      if (error.name === "ValidationError") {
        return next(
          new ErrorHandler(
            Object.values(error.errors)
              .map((e: any) => e.message)
              .join(", "),
            400,
          ),
        );
      }
      return next(new ErrorHandler(error.message || "Error resetting password.", 500));
    }
  },
);



export const meUser = catchAsyncError(
  async(req:Request,res:Response,next:NextFunction)=>{

  try{

    const userId = req.user?._id;

    if(!userId || mongoose.Types.ObjectId.isValid(userId) === false){
      return next(new ErrorHandler("Unauthorized, you are not authenticated.", 401));
    }

    const user = await userModel.findById(userId).select("-passwordHash").lean();

    if(!user){
      return next(new ErrorHandler("User not found.", 404));
    }

    let associated = null;

    switch (user.role){

     case "admin":
       associated = await adminModel.findOne({user_id:userId});
       break;

     case "manager":
       associated = await ManagerModel.findOne({userId});
       break;

     case "client":
       associated = await clientModel.findOne({userId});
       break;

     case "deliverer":
       associated = await delivererModel.findOne({userId});
       break;
       
     case "transporter":
      associated = await transporterModel.findOne({userId});
      break;

     case "supervisor":
      associated = await SupervisorModel.findOne({userId});
      break;

     case "freelancer":
       associated = await freelancerModel.findOne({userId});
       break;

     case "loader":
       associated = await LoaderModel.findOne({userId});
       break;

     case "cashier":
       associated = await CashierModel.findOne({userId});
       break;

      default:
       associated = null;

    }
    
    res.status(200).json({
      success:true,
      user:{
        ...user,
          password:undefined
      },
      associated,
      role : user.role
    })

  }catch(error:any){
    return next(new ErrorHandler(error.message || "Error fetching user data.", 500));
  }

});




// export const createManager = catchAsyncError(
//   async (req: Request, res: Response, next: NextFunction): Promise<void> => {
//     try {
//       const {
//         firstName,
//         lastName,
//         email,
//         phone,
//         password,
//         companyId,
//         accessLevel = 'full',
//         permissions,
//         branchAccess
//       } = req.body;

//       // Simple verification
//       // 1. Check required fields
//       if (!firstName || !lastName || !email || !phone || !password || !companyId) {
//         return next(new ErrorHandler("Missing required fields: firstName, lastName, email, phone, password, companyId", 400));
//       }

//       // 2. Check if user already exists with this email or phone
//       const existingUser = await userModel.findOne({
//         $or: [{ email: email.toLowerCase() }, { phone }]
//       });

//       if (existingUser) {
//         return next(new ErrorHandler("User already exists with this email or phone number", 409));
//       }

//       // 3. Create the user
//       const user = await userModel.create({
//         firstName,
//         lastName,
//         email: email.toLowerCase(),
//         phone,
//         passwordHash: password,
//         role: "manager",
//         status: "active"
//       });

//       // 4. Create the manager record
//       const managerData: any = {
//         userId: user._id,
//         companyId,
//         accessLevel,
//         isActive: true
//       };

//       // Add permissions if provided, otherwise use defaults based on accessLevel
//       if (permissions && Array.isArray(permissions) && permissions.length > 0) {
//         managerData.permissions = permissions;
//       }

//       // Add branch access if provided
//       if (branchAccess) {
//         managerData.branchAccess = branchAccess;
//       }

//       const manager = await ManagerModel.create(managerData);

//       // 5. Return response (excluding sensitive data)
//       res.status(201).json({
//         success: true,
//         message: "Manager created successfully",
//         data: {
//           user: {
//             id: user._id,
//             firstName: user.firstName,
//             lastName: user.lastName,
//             email: user.email,
//             phone: user.phone,
//             role: user.role,
//             status: user.status
//           },
//           manager: {
//             id: manager._id,
//             accessLevel: manager.accessLevel,
//             permissions: manager.permissions,
//             branchAccess: manager.branchAccess,
//             isActive: manager.isActive
//           }
//         }
//       });

//     } catch (err: any) {
//       // Handle duplicate key errors from MongoDB
//       if (err.code === 11000) {
//         return next(new ErrorHandler("Duplicate field value: email or phone already exists", 409));
//       }
      
//       // Handle validation errors from mongoose
//       if (err.name === 'ValidationError') {
//         const messages = Object.values(err.errors).map((e: any) => e.message).join(', ');
//         return next(new ErrorHandler(messages, 400));
//       }
      
//       return next(new ErrorHandler(err.message || "Error creating manager.", 500));
//     }
//   }
// );





export const createManager = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const {
        firstName,
        lastName,
        email,
        phone,
        password,
        accessLevel = 'full'
      } = req.body;

      // Simple verification
      // 1. Check required fields
      if (!firstName || !lastName || !email || !phone || !password) {
        return next(new ErrorHandler("Missing required fields: firstName, lastName, email, phone, password", 400));
      }

      // 2. Check if user already exists with this email or phone
      const normalizedPhone = User.normalizePhone(phone);

      const existingUser = await userModel.findOne({
        
        $or: [{ email: email.toLowerCase() }, { phone: normalizedPhone }]
      });

      if (existingUser) {
        return next(new ErrorHandler("User already exists with this email or phone number", 409));
      }

      // 3. Create the user
      const user = await userModel.create({
        firstName,
        lastName,
        email: email.toLowerCase(),
        phone,
        passwordHash: password,
        role: "manager",
        status: "active"
      });


      // 4. Create a temporary companyId (you might want to create a default company or make this optional)
      // For testing, we'll create a dummy ObjectId or you can modify the schema to allow null temporarily
      // const dummyCompanyId = new mongoose.Types.ObjectId();
      
      // 5. Create the manager record with allBranches access by default
      const manager = await ManagerModel.create({
        userId: user._id,
        // companyId: dummyCompanyId, // You'll need to replace this with a real company ID later
        accessLevel,
        isActive: true,
        branchAccess: {
          allBranches: true,
          specificBranches: []
        }
      });


      // Send notifications for new manager creation
      sendManagerAccountCreatedNotification(
        user._id.toString(),
        user.firstName,
        user.lastName
      ).catch(error => {
        console.error('Manager notification sending failed:', error);

      });

      // Notify admins about new manager
      
      notifyAdminsNewEntityPending(
        manager._id.toString(),
        "Manager",
        `${user.firstName} ${user.lastName}`
      ).catch(error => {
        console.error('Admin notification sending failed:', error);
        // Will implement proper logging later
      });

      // 6. Return response (excluding sensitive data)
      res.status(201).json({
        success: true,
        message: "Manager created successfully",
        data: {
          user: {
            id: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phone: user.phone,
            role: user.role,
            status: user.status
          },
          manager: {
            id: manager._id,
            accessLevel: manager.accessLevel,
            permissions: manager.permissions,
            branchAccess: manager.branchAccess,
            isActive: manager.isActive
          }
        }
      });

    } catch (err: any) {
      // Handle duplicate key errors from MongoDB
      if (err.code === 11000) {
        return next(new ErrorHandler("Duplicate field value: email or phone already exists", 409));
      }
      
      // Handle validation errors from mongoose
      if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map((e: any) => e.message).join(', ');
        return next(new ErrorHandler(messages, 400));
      }
      
      return next(new ErrorHandler(err.message || "Error creating manager.", 500));
    }
  }
);





// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 1 — Autocomplete while typing
// GET /api/auth/geocode/search?q=con&limit=10
//
// Instant — reads from the JSON file in memory, zero network calls.
// Call this on every keystroke (debounce 150–200ms on the frontend).
// ─────────────────────────────────────────────────────────────────────────────
 
export const searchAddress = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const { q, limit } = req.query as Record<string, string | undefined>;
 
    if (!q || !q.trim()) {
      return next(new ErrorHandler("Query parameter 'q' is required.", 400));
    }
 
    if (q.trim().length < 2) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }
 
    const limitNum = limit ? parseInt(limit, 10) : 10;
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 20) {
      return next(new ErrorHandler("limit must be between 1 and 20.", 400));
    }
 
    const places = searchLocalPlaces(q.trim(), limitNum);
 
    return res.status(200).json({
      success: true,
      count:   places.length,
      data:    places,
      // Each item in data has:
      // { id, communeNameAscii, communeName, dairaNameAscii, dairaName,
      //   wilayaCode, wilayaNameAscii, wilayaName, label }
    });
  },
);
 
 
// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 2 — Resolve coordinates for a confirmed selection
// POST /api/auth/geocode/resolve
// Body: { communeNameAscii: "El Khroub", wilayaNameAscii: "Constantine" }
//
// Called ONCE when the user taps a suggestion in the dropdown.
// Hits Nominatim with the full canonical name → returns lat/lon.
// Frontend stores the result and sends it with the createPackage request.
// ─────────────────────────────────────────────────────────────────────────────
 
export const resolvePlace = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const { communeNameAscii, wilayaNameAscii } = req.body as {
      communeNameAscii?: string;
      wilayaNameAscii?: string;
    };
 
    if (!communeNameAscii?.trim() || !wilayaNameAscii?.trim()) {
      return next(
        new ErrorHandler("communeNameAscii and wilayaNameAscii are required.", 400),
      );
    }
 
    try {
      const result = await geocodeConfirmedPlace(
        communeNameAscii.trim(),
        wilayaNameAscii.trim(),
      );
 
      if (!result) {
        return res.status(404).json({
          success: false,
          message: `Could not find or geocode "${communeNameAscii}, ${wilayaNameAscii}".`,
        });
      }
 
      return res.status(200).json({
        success: true,
        data: result,
        // result shape:
        // { communeNameAscii, communeName, wilayaNameAscii, wilayaName,
        //   wilayaCode, displayName, lat, lon }
      });
    } catch (err: any) {
      return next(new ErrorHandler(err.message ?? "Geocoding failed.", 503));
    }
  },
);
 
 
// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 3 — Reverse geocode (for deliverer GPS confirmation)
// GET /api/auth/geocode/reverse?lat=36.26&lon=6.69
// ─────────────────────────────────────────────────────────────────────────────
 
export const reverseGeocodeAddress = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const { lat, lon } = req.query as Record<string, string | undefined>;
 
    if (!lat || !lon) {
      return next(new ErrorHandler("lat and lon are required.", 400));
    }
 
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
 
    if (isNaN(latNum) || latNum < -90  || latNum > 90)  {
      return next(new ErrorHandler("lat must be between -90 and 90.", 400));
    }
    if (isNaN(lonNum) || lonNum < -180 || lonNum > 180) {
      return next(new ErrorHandler("lon must be between -180 and 180.", 400));
    }
 
    try {
      const result = await reverseGeocode(latNum, lonNum);
 
      if (!result) {
        return res.status(404).json({
          success: false,
          message: "No address found for the given coordinates.",
        });
      }
 
      return res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      return next(new ErrorHandler(err.message ?? "Reverse geocoding failed.", 503));
    }
  },
);
 
 
// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — add to your router file (auth.routes.ts or freelancer.routes.ts)
// ─────────────────────────────────────────────────────────────────────────────
 
// import { searchAddress, resolvePlace, reverseGeocodeAddress } from "../controllers/freelancer.controller";
//
// authRouter.get("/geocode/search",   searchAddress);
// authRouter.post("/geocode/resolve", resolvePlace);
// authRouter.get("/geocode/reverse",  reverseGeocodeAddress);
 
 
// ─────────────────────────────────────────────────────────────────────────────
// createPackage — destination block update
// Replace the destination object in your existing createPackage function.
//
// Add these fields to ICreatePackageBody:
//   deliveryLat?: number;
//   deliveryLon?: number;
//   deliveryDisplayName?: string;
//   deliveryCommuneAscii?: string;
//   deliveryWilayaAscii?: string;
// ─────────────────────────────────────────────────────────────────────────────
 
/*
  const {
    // ... your existing fields ...
    deliveryLat,
    deliveryLon,
    deliveryDisplayName,
    deliveryCommuneAscii,
    deliveryWilayaAscii,
  } = req.body as ICreatePackageBody;
 
  // For home delivery, coordinates are required
  if (deliveryType === "home") {
    if (
      deliveryLat === undefined || deliveryLon === undefined ||
      typeof deliveryLat !== "number" || typeof deliveryLon !== "number"
    ) {
      throw new ErrorHandler(
        "deliveryLat and deliveryLon are required for home delivery. " +
        "Use /geocode/search then /geocode/resolve to obtain them.",
        400,
      );
    }
  }
 
  const destination = {
    recipientName:    recipientName.trim(),
    recipientPhone:   normalizedRecipientPhone,
    alternativePhone: normalizedAlternativePhone,
    address:          recipientAddress.trim(),
    city:             deliveryCommuneAscii?.trim() ?? recipientCity.trim(),
    state:            deliveryWilayaAscii?.trim()  ?? recipientState.trim(),
    postalCode:       recipientPostalCode?.trim(),
    notes:            deliveryNotes?.trim(),
    coordinates: (deliveryLat !== undefined && deliveryLon !== undefined)
      ? { lat: deliveryLat, lon: deliveryLon }
      : undefined,
    resolvedAddress: deliveryDisplayName?.trim(),
  };
*/





// POST /api/eta/calculate
//
// Accessible by: deliverers and transporters only (enforced via isDelivererOrTransporter middleware).
//
// Body:
// {
//   currentLat : number,   // user's current GPS latitude
//   currentLon : number,   // user's current GPS longitude
//   destinationLat : number,  // branch hub / branch / delivery address lat
//   destinationLon : number,  // branch hub / branch / delivery address lon
// }
//
// Returns:
// {
//   success          : true,
//   data: {
//     baseDurationMin  : number,   // raw OSRM time
//     finalDurationMin : number,   // smart-adjusted time
//     adjustmentPercent: number,   // total % added
//     estimatedArrival : ISO string,
//     confidence       : 'high' | 'medium' | 'low',
//     distanceKm       : number,
//     traffic          : { factor, level, label },
//     weather          : { factor, severity, label },
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────

export const calculateETA = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?._id;

    if (!userId) {
      return next(new ErrorHandler("Authentication required.", 401));
    }

    // ── 1. Validate body ─────────────────────────────────────────────
    const { currentLat, currentLon, destinationLat, destinationLon } =
      req.body as Record<string, unknown>;

    if (
      currentLat === undefined ||
      currentLon === undefined ||
      destinationLat === undefined ||
      destinationLon === undefined
    ) {
      return next(
        new ErrorHandler(
          "currentLat, currentLon, destinationLat and destinationLon are required.",
          400
        )
      );
    }

    const cLat = parseFloat(String(currentLat));
    const cLon = parseFloat(String(currentLon));
    const dLat = parseFloat(String(destinationLat));
    const dLon = parseFloat(String(destinationLon));

    if (
      isNaN(cLat) || cLat < -90 || cLat > 90 ||
      isNaN(cLon) || cLon < -180 || cLon > 180 ||
      isNaN(dLat) || dLat < -90 || dLat > 90 ||
      isNaN(dLon) || dLon < -180 || dLon > 180
    ) {
      return next(
        new ErrorHandler("One or more coordinates are out of valid range.", 400)
      );
    }

    // ── 2. Role check ────────────────────────────────────────────────
    const [deliverer, transporter] = await Promise.all([
      delivererModel.findOne({ userId, isActive: true, isSuspended: false }),
      transporterModel.findOne({ userId, isActive: true, isSuspended: false }),
    ]);

    if (!deliverer && !transporter) {
      return next(
        new ErrorHandler(
          "Access denied. Only active deliverers and transporters can request ETA.",
          403
        )
      );
    }

    // ── 3. Coordinates ───────────────────────────────────────────────
    const origin: Coordinates = { lat: cLat, lon: cLon };
    const destination: Coordinates = { lat: dLat, lon: dLon };

    const midpoint: Coordinates = {
      lat: (cLat + dLat) / 2,
      lon: (cLon + dLon) / 2,
    };

    // ── 4. OSRM + environment factors ────────────────────────────────
    let osrmResult;

    try {
      osrmResult = await getOSRMRoute(origin, destination);
    } catch {
      return next(
        new ErrorHandler(
          "Could not calculate route. Make sure coordinates are reachable by road.",
          502
        )
      );
    }

    const now = new Date();

    const [trafficResult, weatherResult] = await Promise.all([
      Promise.resolve(estimateTrafficFactor(now)),
      fetchWeatherFactor(midpoint),
    ]);

    // ── 5. SPEED-AWARE TRAFFIC MODEL ──────────────────────────────────
    // Prevent division issues
    const avgSpeed = osrmResult.avgSpeedKmh || 1;

    // Adaptive reference speed:
    // - Urban (<15km): 35 km/h (OSRM over-optimistic in cities)
    // - Mixed/long routes: 55 km/h
    const isUrban = osrmResult.distance < 15_000;

    const REFERENCE_SPEED = isUrban ? 35 : 55;

    const speedRatio = avgSpeed / REFERENCE_SPEED;

    // Stronger correction for urban routes (cap higher)
    const speedCorrection = isUrban
      ? Math.min(1.50, Math.max(0.75, 1 / speedRatio))
      : Math.min(1.40, Math.max(0.75, 1 / speedRatio));

    const adjustedTrafficFactor =
      trafficResult.factor * speedCorrection;

    // ── 6. COMBINED EFFECT ───────────────────────────────────────────
    const rawSum = adjustedTrafficFactor + weatherResult.factor;

    const MAX_ADJUSTMENT = 0.60;
    const MIN_DURATION_SEC = 60;

    const dampened = Math.min(
      1 - Math.exp(-rawSum),
      MAX_ADJUSTMENT
    );

    const baseSec = Math.max(osrmResult.baseDuration, MIN_DURATION_SEC);
    const finalSec = baseSec * (1 + dampened);

    const baseDurationMin = Math.round(baseSec / 60);
    const finalDurationMin = Math.ceil(finalSec / 60);

    const adjustmentPercent = Math.round(dampened * 100);

    const estimatedArrival = new Date(now.getTime() + finalSec * 1000);

    // ── 7. CONFIDENCE SCORE ──────────────────────────────────────────
    const confidence: "high" | "medium" | "low" =
      rawSum < 0.10 ? "high" :
      rawSum < 0.30 ? "medium" :
      "low";

    // ── 8. RESPONSE ──────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      data: {
        baseDurationMin,
        finalDurationMin,
        adjustmentPercent,
        estimatedArrival,
        confidence,
        distanceKm: parseFloat((osrmResult.distance / 1000).toFixed(2)),
        avgSpeedKmh: osrmResult.avgSpeedKmh,

        traffic: {
          factor: trafficResult.factor,
          level: trafficResult.level,
          label: trafficResult.label,
        },

        weather: {
          factor: weatherResult.factor,
          severity: weatherResult.severity,
          label: weatherResult.label,
        },
      },
    });
  }
);


const createContactChangeOTPToken = (payload: {
  otp: string;
  newEmail?: string;
  newPhone?: string;
}): string => {
  const expireMinutes = parseInt(process.env.OTP_EXPIRE ?? "10", 10);
  return jwt.sign(payload, process.env.OTP_SECRET as string, {
    expiresIn: expireMinutes * 60,
  });
};


 
export const requestContactChange = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?._id;
      if (!userId) {
        return next(new ErrorHandler("Unauthorized.", 401));
        
      }

      const { newEmail, newPhone } = req.body as {
        newEmail?: string;
        newPhone?: string;
      };


      if (!newEmail && !newPhone) {
        return next(
          new ErrorHandler(
            "Provide at least one field to change: newEmail or newPhone.",
            400,
          ),
        );
        
      }


      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const phoneRegex = /^(\+213|0)(5|6|7)[0-9]{8}$/;

      if (newEmail && !emailRegex.test(newEmail.trim())) {
        return next(new ErrorHandler("Invalid email address format.", 400));
        
      }

      if (newPhone && !phoneRegex.test(newPhone.trim())) {
        return next(
          new ErrorHandler(
            "Invalid phone number. Must be a valid Algerian number (+213 or 0).",
            400,
          ),
        );
        
      }


      const user = await userModel.findById(userId);
      if (!user) {
        return next(new ErrorHandler("User not found.", 404));
        
      }


      if (newEmail && newEmail.trim().toLowerCase() === user.email?.toLowerCase()) {
        return next(
          new ErrorHandler("New email must be different from your current email.", 400),
        );
        
      }

      if (newPhone) {
        const normalizedNew = User.normalizePhone(newPhone.trim());
        const normalizedCurrent = User.normalizePhone(user.phone ?? "");
        if (normalizedNew === normalizedCurrent) {
          return next(
            new ErrorHandler(
              "New phone number must be different from your current one.",
              400,
            ),
          );
          
        }
      }


      if (newEmail) {
        const taken = await userModel.findOne({
          email: newEmail.trim().toLowerCase(),
          _id: { $ne: userId },
        });
        if (taken) {
          return  next(new ErrorHandler("This email is already in use.", 409));
          
        }
      }

      if (newPhone) {
        const normalizedNew = User.normalizePhone(newPhone.trim());
        const taken = await userModel.findOne({
          phone: normalizedNew,
          _id: { $ne: userId },
        });
        if (taken) {
          return  next(new ErrorHandler("This phone number is already in use.", 409));
          
        }
      }


      const otp = generateOTP();

      const tokenPayload: { otp: string; newEmail?: string; newPhone?: string } = { otp };
      if (newEmail) tokenPayload.newEmail = newEmail.trim().toLowerCase();
      if (newPhone) tokenPayload.newPhone = User.normalizePhone(newPhone.trim());

      const otp_token = createContactChangeOTPToken(tokenPayload);
      const expireMinutes = process.env.OTP_EXPIRE ?? "10";
      const expiresInSeconds = parseInt(expireMinutes) * 60;


      if (newEmail) {

        const targetEmail = newEmail.trim().toLowerCase();

        const templatePath = path.join(
          __dirname,
          "..",
          "mails",
          "change_contact_otp.ejs",
        );

        let html: string;
        if (fs.existsSync(templatePath)) {
          const template = fs.readFileSync(templatePath, "utf8");
          html = ejs.render(template, {
            firstName: user.firstName,
            otp,
            expireMinutes,
            changeType: newPhone ? "email and phone" : "email",
          });
        } else {
          // Fallback inline template
          html = `
            <p>Hi ${user.firstName},</p>
            <p>Your verification code for the contact update is: <strong>${otp}</strong></p>
            <p>It expires in ${expireMinutes} minutes.</p>
            ${newPhone ? '<p>Your email and phone number will be updated after verification.</p>' : ''}
            <p>If you did not request this change, please ignore this email.</p>
          `;
        }

        await Mail.sendMail({
          from: `Delivery Tracking Dz <${process.env.SMTP_MAIL}>`,
          to: targetEmail,
          subject: `Your contact change code: ${otp}`,
          html,
        });

        res.status(200).json({
          success: true,
          message: `OTP sent to your new email address: ${targetEmail}`,
          otp_token,
          method: "email",
          expiresIn: expiresInSeconds,
        });
        return;
      }

      // Phone-only path
      const smsSent = await sendSMS({
        to: newPhone!.trim(),
        message: `Your contact change OTP is: ${otp}. Valid for ${expireMinutes} minutes.`,
      });

      if (!smsSent) {
        next(new ErrorHandler("Failed to send OTP via SMS. Please try again.", 500));
        return;
      }

      res.status(200).json({
        success: true,
        message: `OTP sent to your new phone number: ${newPhone!.trim()}`,
        otp_token,
        method: "sms",
        expiresIn: expiresInSeconds,
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error sending contact change OTP.", 500),
      );
    }
  },
);



export const confirmContactChange = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?._id;
      if (!userId) {
        return next(new ErrorHandler("Unauthorized.", 401));
        
      }

      const { otp_token, otp } = req.body as {
        otp_token?: string;
        otp?: string;
      };

      if (!otp_token || !otp) {
        return next(new ErrorHandler("otp_token and otp are required.", 400));
        
      }


      let decoded: { otp: string; newEmail?: string; newPhone?: string };
      try {
        decoded = jwt.verify(
          otp_token,
          process.env.OTP_SECRET as string,
        ) as typeof decoded;
      } catch (err: any) {
        if (err.name === "TokenExpiredError") {
          return next(
            new ErrorHandler("OTP has expired. Please request a new one.", 400),
          );
          return;
        }
        return next(new ErrorHandler("Invalid OTP token.", 400));
        
      }


      if (decoded.otp !== otp.trim()) {
        return next(new ErrorHandler("Incorrect OTP. Please try again.", 400));
      }


      if (!decoded.newEmail && !decoded.newPhone) {
        return next(
          new ErrorHandler("Token does not contain any contact fields to update.", 400),
        );
        
      }


      const user = await userModel.findById(userId);
      if (!user) {
        return next(new ErrorHandler("User not found.", 404));
        
      }


      if (decoded.newEmail) {
        const taken = await userModel.findOne({
          email: decoded.newEmail,
          _id: { $ne: userId },
        });
        if (taken) {
          return next(
            new ErrorHandler(
              "This email was taken by another account. Please request a new change.",
              409,
            ),
          );
          
        }
      }

      if (decoded.newPhone) {
        const taken = await userModel.findOne({
          phone: decoded.newPhone,
          _id: { $ne: userId },
        });
        if (taken) {
          return next(
            new ErrorHandler(
              "This phone number was taken by another account. Please request a new change.",
              409,
            ),
          );
          
        }
      }


      const updated: { email?: string; phone?: string } = {};

      if (decoded.newEmail) {
        user.email = decoded.newEmail;
        updated.email = decoded.newEmail;
      }

      if (decoded.newPhone) {
        user.phone = decoded.newPhone;
        updated.phone = decoded.newPhone;
      }

      await user.save();


      const changedFields = Object.keys(updated).join(" and ");
      res.status(200).json({
        success: true,
        message: `Your ${changedFields} ${Object.keys(updated).length > 1 ? "have" : "has"} been updated successfully.`,
        updated,
      });
    } catch (error: any) {
      return next(
        new ErrorHandler(error.message || "Error confirming contact change.", 500),
      );
    }
  },
);