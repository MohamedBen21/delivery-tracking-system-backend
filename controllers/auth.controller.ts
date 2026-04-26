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
import cloudinary from "cloudinary";
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

      // const filename = req.file?.filename;
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

      // if (filename) {
      //   if (user.imageUrl && user.imageUrl.url !== "/uploads/users/user.jpeg")
      //     deleteImage(user.imageUrl.url);
      //   const imageUrl = `/uploads/users/${filename}`;
      //   user.imageUrl = { public_id: "" , url: imageUrl };
      // }

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
  const result = await cloudinary.v2.uploader.upload(source, {
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


    const oldPublicId = user.imageUrl?.public_id;
    if (oldPublicId) {
      try {
        await cloudinary.v2.uploader.destroy(oldPublicId);
      } catch (err) {

        console.warn(`[updateProfilePicture] Failed to delete old image ${oldPublicId}:`, err);
      }
    }


    const { public_id, url } = await uploadToCloudinary(uploadSource);


    const updatedUser = await userModel.findByIdAndUpdate(
      userId,
      { $set: { imageUrl: { public_id, url } } },
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
        user:     updatedUser,
      },
    });
  },
);


//  DELETE PROFILE PICTURE
//  POST /user/profile-picture/delete
//  Removes the current profile picture from Cloudinary and sets imageUrl to null.

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

    if (!user.imageUrl?.public_id) {
      return next(new ErrorHandler("No profile picture to delete.", 400));
    }


    await cloudinary.v2.uploader.destroy(user.imageUrl.public_id);


    await userModel.findByIdAndUpdate(userId, { $set: { imageUrl: null } });


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
  Math.floor(100000 + Math.random() * 900000).toString();


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


const ALLOWED_ROLES = ["deliverer", "transporter"];

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


      const query = isEmail ? { email: sanitized } : { phone: identifier.trim() };
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
            "Password reset via OTP is only available for deliverers and transporters.",
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


      const query = decoded.email
        ? { email: decoded.email }
        : { phone: decoded.phone };

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
       associated = adminModel.findOne({user_id:user._id});

     case "manager":
       associated = ManagerModel.findOne({user_id:user._id});

     case "client":
       associated = clientModel.findOne({user_id:user._id});

     case "deliverer":
       associated = delivererModel.findOne({user_id:user._id});
       
     case "transporter":
      associated = transporterModel.findOne({user_id:user._id});

     case "supervisor":
      associated = SupervisorModel.findOne({user_id:user._id});

     case "freelancer":
       associated = freelancerModel.findOne({user_id:user._id});

      default:
       associated = null;

    }
    
    res.sendStatus(200).json({
      success:true,
      user,
      associated,
      role : user.role
    })

  }catch(error:any){
    return next(new ErrorHandler(error.message || "Error fetching user data.", 500));
  }

});