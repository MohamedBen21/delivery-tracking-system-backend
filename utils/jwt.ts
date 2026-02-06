require("dotenv").config();
import { Jwt } from "jsonwebtoken";
import { Response } from "express";
import { redis } from "./redis";
import { IUser } from "../models/user.model";

interface ITokenOptions {
  expires: Date;
  maxAge: number;

  httpOnly: boolean;
  sameSite: "lax"   | "strict" | "none"  | undefined;
  secure?: boolean;
}

 const accessTokenExpire = parseInt(

  process.env.ACCESS_TOKEN_EXPIRE || "15",
  10
);
 const refreshTokenExpire = parseInt(

  process.env.REFRESH_TOKEN_EXPIRE || "3",
  10
);

export const accessTokenOptions: ITokenOptions = {

  expires: new Date(Date.now() + accessTokenExpire * 60 * 1000),

  maxAge: accessTokenExpire  *60* 1000,
  httpOnly: true,
  sameSite: "lax",
};

export const refreshTokenOptions: ITokenOptions = {

  expires: new Date(Date.now() + refreshTokenExpire * 24 * 60 * 60 * 1000),

  maxAge: refreshTokenExpire * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: "lax",
};


export const sendToken = (user: IUser, statusCode: number, res: Response) => {

  const accessToken = user.SignAccessToken();
  const refreshToken = user.SignRefreshToken();

  redis.set(user._id as any, JSON.stringify(user) as any,"EX",604800); 

  if (process.env.NODE_ENV === "production") {
    accessTokenOptions.secure = true;
  }

  res.cookie("accessToken",accessToken,accessTokenOptions);
  res.cookie("refreshToken",refreshToken,refreshTokenOptions);

  res.status(201).json({
    status: "success",
    user,
    accessToken,

  });

};
