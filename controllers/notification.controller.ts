import { Request, Response, NextFunction } from "express";
import { catchAsyncError } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import notificationModel from "../models/notification.model";




export const getAllNotifications = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      if (!userId) {
        return next(new ErrorHandler("User not found", 404));
      }


      const [notifications, total, unreadCount] = await Promise.all([
        notificationModel
          .find({ user_id: userId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate({
            path: "user_id",
            select: "first_name last_name email profile_picture_url",
          })
          .lean(),
        notificationModel.countDocuments({ user_id: userId }),
        notificationModel.countDocuments({
          user_id: userId,
          is_read: false,
        }),
      ]);

      res.status(200).json({
        success: true,
        notifications,
        pagination: {
          current_page: page,
          total_pages: Math.ceil(total / limit),
          total_notifications: total,
          per_page: limit,
        },
        unread_count: unreadCount,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);


export const markNotificationAsRead = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;
      const { notification_id } = req.params;

      if (!userId) {
        return next(new ErrorHandler("User not found", 404));
      }

      if (!notification_id) {
        return next(new ErrorHandler("Notification ID is required", 400));
      }


      const notification = await notificationModel.findOneAndUpdate(
        {
          _id: notification_id,
          user_id: userId,
        },
        {
          is_read: true,
        },
        {
          new: true,
          runValidators: true,
        }
      ).lean();

      if (!notification) {
        return next(
          new ErrorHandler("Notification not found or unauthorized", 404)
        );
      }

      res.status(200).json({
        success: true,
        message: "Notification marked as read",
        notification,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);



export const markMultipleNotificationsAsRead = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?._id;

      if (!userId) {
        return next(new ErrorHandler("User not found", 404));
      }

      // Update all notifications for this user that are unread
      const updateResult = await notificationModel.updateMany(
        {
          user_id: userId,
          is_read: false,
        },
        {
          is_read: true,
        }
      );

      res.status(200).json({
        success: true,
        message: `Marked ${updateResult.modifiedCount} notification(s) as read`,
        updated_count: updateResult.modifiedCount,
      });
    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);


export const verifyUnreadNotification = catchAsyncError(
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user_id = req.user?._id;

      if (!user_id) {
        return next(new ErrorHandler("User not found", 404));
      }

      const [hasUnread, unreadCount] = await Promise.all([

        notificationModel.exists({
          user_id,
          is_read: false
        }),

        notificationModel.countDocuments({
          user_id,
          is_read: false
        })
      ]);

      res.status(200).json({
        success: true,
        message: "Verification completed successfully",
        has_unread_notifications: !!hasUnread,
        unread_count: unreadCount
      });

    } catch (error: any) {
      return next(new ErrorHandler(error.message, 400));
    }
  }
);