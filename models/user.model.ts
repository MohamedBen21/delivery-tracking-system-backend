import mongoose, { Document, Model, Schema } from "mongoose";
import bcrypt from "bcryptjs";
import { NextFunction } from "express";
import jwt from "jsonwebtoken";
require("dotenv").config();

const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex: RegExp = /^(\+213|0)(5|6|7)[0-9]{8}$/;


export interface IUser extends Document {
  email: string;
  phone?: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  imageUrl? : string;
  role: "admin" | "manager" | "client" | "deliverer" | "transporter" | "supervisor" | "freelancer";
  status: "active" | "pending" | "suspended" | "inactive";

  comparePassword: (password: string) => Promise<boolean>;
  SignAccessToken: () => string;
  SignRefreshToken: () => string;
}

const userSchema: Schema<IUser> = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, "Please enter your email"],
      unique: true,

      lowercase: true,
      trim: true,

      validate: {
        validator: (value: string) => emailRegex.test(value),

        message: "Please enter a valid email",
      },
    },

    phone: {
      type: String,
      required: [true, "Please enter your phone number"],
      unique: true,
      trim: true,

      validate: {
        validator: function (value: string) {
          return phoneRegex.test(value);
        },

        message: "Please enter a valid Algerian phone number.",
      },
    },

    passwordHash: {
      type: String,
      required: [true, "Please enter your password"],
      minlength: [6, "Password must be at least 6 characters"],
      select: false,
    },

    firstName: {
      type: String,
      required: [true, "Please enter your first name"],
      trim: true,
    },

    lastName: {
      type: String,
      required: [true, "Please enter your last name"],
      trim: true,
    },

    role: {
      type: String,
      enum: {
        values: ["admin", "manager", "client", "deliverer", "transporter", "supervisor","freelancer"],
        message: "{VALUE} is not a valid role.", 
      },
      default: "client",
    },

    status: {
      type: String,
      enum: {
        values: ["active", "pending", "suspended", "inactive"],
        message: "{VALUE} is not a valid role.",
      },
      default: "pending",
    },
    
    imageUrl: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

userSchema.index({ username: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ role: 1, status: 1 });


userSchema.pre<IUser>("save", async function (next) {
  if (!this.isModified("passwordHash")) {
    return next();
  }

  try {

    this.passwordHash = await bcrypt.hash(this.passwordHash, 10);

    next();

  } catch (error: any) {

    next(error);
  }

});


userSchema.methods.SignAccessToken = function () {
  return jwt.sign(
    { id: this._id, role: this.role },
    process.env.ACCESS_TOKEN || "",
    { expiresIn: "15m" }
  );
};


userSchema.methods.SignRefreshToken = function () {
  return jwt.sign(
    { id: this._id },
    process.env.REFRESH_TOKEN || "",
    { expiresIn: "7d" }
  );
};


userSchema.methods.comparePassword = async function (
  enteredPassword: string
): Promise<boolean> {
  return await bcrypt.compare(enteredPassword, this.passwordHash);
};


const userModel: Model<IUser> = mongoose.model<IUser>("User", userSchema);

export default userModel;
