import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { IUser } from '../models/user.model';
import userModel from '../models/user.model';
import ErrorHandler from '../utils/ErrorHandler';

export interface AuthenticatedSocket extends Socket {
  user?: IUser;
}

export const socketAuth = async (socket: AuthenticatedSocket, next: (err?: Error) => void) => {
  try {
    const token = socket.handshake.auth.accessToken || socket.handshake.query.token || socket.handshake.headers['x-access-token'];
    
    if (!token) {
      return next(new ErrorHandler('Authentication error: Token not provided', 401));
    }

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN as string) as { id: string };
    const user = await userModel.findById(decoded.id);

    if (!user) {
      return next(new ErrorHandler('Authentication error: User not found', 401));
    }

    socket.user = user;
    next();
  } catch (error) {
    next(new ErrorHandler('Authentication error: Invalid token', 401));
  }
}; 