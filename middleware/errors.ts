import { NextFunction, Request, Response } from "express";
import ErrorHandler from "../utils/ErrorHandler";

export const ErrorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  err.statusCode = err.statusCode || 500;
  err.message = err.message || "Internal Server Error";


  if (err.name === "CastError") {
    const message = `Resource not found. Invalid :${err.path}`;
    err = new ErrorHandler(message, 400);
  }


  if (err.code === 11000) {
    const message = `Duplicate ${Object.keys(err.keyValue)} entered`;
    err = new ErrorHandler(message, 400);
  }


  if (err.name === "JsonWebTokenError") {
    const message = "Invalid token. Please login again";
    err = new ErrorHandler(message, 400);
  }


  if (err.name === "TokenExpiredError") {
    const message = "Your token has expired. Please login again";
    err = new ErrorHandler(message, 400);
  }

  res.status(err.statusCode).json({  
    success: false,
    message: err.message,
  });
};