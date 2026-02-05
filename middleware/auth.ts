import {Request, Response , NextFunction} from "express";
import { catchAsyncError } from "./catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import jwt, { JwtPayload } from "jsonwebtoken";
import { redis } from "../utils/redis";
import { IUser } from "../models/user.model";


export const isAuthenticated = catchAsyncError(async(req:Request , res:Response , next:NextFunction)=>{


    const acces_token = req.cookies.accessToken;

    // console.log('Access Token:', acces_token);

    if(!acces_token) {
        return next(new ErrorHandler( "Please login to access this resource",401));
    }

    const decoded = jwt.verify(acces_token,process.env.ACCESS_TOKEN as string) as JwtPayload;
    if(!decoded){
        return next(new ErrorHandler("access token is invalid ",401));
    }

    const user = await redis.get(decoded.id);
    if(!user){
        return next(new ErrorHandler("Please login to access this resource",401));
       }

       req.user = JSON.parse(user);

       next();


});

// this is the same but without using redis
// export const isAuthenticated = catchAsyncError(
//   async (req: Request, res: Response, next: NextFunction) => {
//     const access_token = req.cookies.accessToken;
    
//     if (!access_token) {
//       return next(new ErrorHandler("Please login to access this resource", 401));
//     }

//     try {
//       const decoded = jwt.verify(
//         access_token,
//         process.env.ACCESS_TOKEN as string
//       ) as JwtPayload;

//       if (!decoded) {
//         return next(new ErrorHandler("Access token is invalid", 401));
//       }

//       // checking if the user still exists and is active in Redis -not getting all data
//       const userExists = await redis.exists(decoded.id);
      
//       if (!userExists) {
//         return next(new ErrorHandler("Please login to access this resource", 401));
//       }

//       // Use data from JWT instead of Redis query
//       req.user = {
//         _id: decoded.id,
//         email: decoded.email,
//         phone: decoded.phone,
//         role: decoded.role,
//         first_name: decoded.first_name,
//         last_name: decoded.last_name,
//         is_active: decoded.is_active
//       } as IUser;

//       next();
//     } catch (error) {
//       return next(new ErrorHandler("Access token is invalid", 401));
//     }
//   }
// );


export const authorizeRoles = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!roles.includes(req.user?.role || "")) {
        return next(
          new ErrorHandler(
            `Role : ${req.user?.role} is not allowed to access this resource`,
            403
          )
        );
      }
      next();
    };
  };