import { Router } from "express";
import { isAuthenticated } from "../middleware/auth";
import { getAllNotifications, markMultipleNotificationsAsRead, markNotificationAsRead, verifyUnreadNotification } from "../controllers/notification.controller";

const notificationRouter = Router();



notificationRouter.get("", isAuthenticated, getAllNotifications);
notificationRouter.patch("/:notification_id", isAuthenticated, markNotificationAsRead);
notificationRouter.patch("/all", isAuthenticated, markMultipleNotificationsAsRead);
notificationRouter.get("/unread", isAuthenticated, verifyUnreadNotification);

export default notificationRouter;


