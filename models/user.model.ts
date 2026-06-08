import mongoose, { Document, Model, Schema } from "mongoose";
import bcrypt from "bcryptjs";
import { NextFunction } from "express";
import jwt from "jsonwebtoken";
require("dotenv").config();

const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex: RegExp = /^(\+213|0)(5|6|7)[0-9]{8}$/;


export interface IUser extends Document {
  email: string;
  phone: string;
  passwordHash?: string;
  firstName: string;
  lastName: string;
  imageUrl?: {
    public_id: string;
    url: string;
  };
  role: "admin" | "manager" | "client" | "deliverer" | "transporter" | "supervisor" | "freelancer" | "cashier" | "loader";
  status: "active" | "pending" | "suspended" | "inactive";
  companyId?: string;

  comparePassword: (password: string) => Promise<boolean>;
  SignAccessToken: () => string;
  SignRefreshToken: () => string;

}


export interface IUserModel extends Model<IUser> {

  normalizePhone(phone: string): string;
}

const userSchema: Schema<IUser> = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [
        function (this: IUser) {
          return this.role !== "client";
        },
        "Please enter your email",
      ],
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      validate: {
        // ✅ Regular function so `this` refers to the document
        validator: function (this: IUser, value: string) {
          // If no value and role is client, skip validation
          if (!value && this.role === "client") {
            return true;
          }
          // If value exists, it must be a valid email
          if (value) {
            return emailRegex.test(value);
          }
          return true;
        },
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
      minlength: [6, "Password must be at least 6 characters"],
      select: false,
      required: [
        function (this: IUser) {

          return this.role !== "client";
        },
        "Password is required for this role"
      ],
    },

    firstName: {
      type: String,
      required: [true, "Please enter your first name"],
      trim: true,
      minlength: [3, "Username must be at least 3 characters long"],
      maxlength: [30, "Username must not exceed 30 characters"],
    },

    lastName: {
      type: String,
      required: [true, "Please enter your last name"],
      trim: true,
      minlength: [3, "Username must be at least 3 characters long"],
      maxlength: [30, "Username must not exceed 30 characters"],
    },

    role: {
      type: String,
      enum: {
        values: ["admin", "manager", "client", "deliverer", "transporter", "supervisor", "freelancer", "cashier", "loader"],
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
      type: {
        // public_id: { type: String, default: "" },
        // url: { type: String, default: "" },
        public_id: { type: String, default: null },
        url: { type: String, default: null },
      },
      // default: { public_id: "", url: "" },
      default: { public_id: null, url: null },
      _id: false,
    },
  },
  { timestamps: true }
);

// userSchema.index({ email: 1 }); // duplicate: email already indexed via `unique: true`
// userSchema.index({ phone: 1 }); // duplicate: phone already indexed via `unique: true`
userSchema.index({ role: 1, status: 1 });


userSchema.pre<IUser>("save", async function (next) {
  try {


    if (this.role === "client" && !this.email) {
      this.email = undefined as any;
    }

    if (this.isModified("phone")) {

      let phone = this.phone.trim().replace(/[^\d+]/g, '').replace(/\s+/g, '');

      if (phone.startsWith('0')) {
        phone = '+213' + phone.substring(1);
      }

      if (!phone.startsWith('+213')) {
        return next(new Error('Phone number must start with +213 or 0') as any);
      }

      this.phone = phone;
    }


    if (!this.passwordHash || !this.isModified("passwordHash")) {
      return next();
    }

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

  if (!this.passwordHash) {

    return false;
  }

  return await bcrypt.compare(enteredPassword, this.passwordHash);
};



userSchema.statics.normalizePhone = function (phone: string): string {

  let normalized = phone.trim().replace(/[^\d+]/g, '').replace(/\s+/g, '');

  if (normalized.startsWith('0')) {
    normalized = '+213' + normalized.substring(1);
  }

  if (!normalized.startsWith('+213')) {
    throw new Error('Phone number must start with +213 or 0');
  }

  return normalized;
};


const userModel: IUserModel = mongoose.model<IUser, IUserModel>("User", userSchema);

export default userModel;
