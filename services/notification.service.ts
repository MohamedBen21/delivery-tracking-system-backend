import { sendNotificationToDevice, sendNotificationToMultipleDevices } from "../firebase";
import userModel from "../models/user.model";
import notificationModel from "../models/notification.model";


type IconType = "delivery_app" | "freelancer_app" | "client_app" | "manager_app";
type RouteType = "to" | "offAll";


async function storeNotificationInDB({
  userId,
  notificationType,
  referenceId,
  referenceType,
  title,
  message,
  priority,
  userType,
  route,
  iconType,
  routeType,
}: {
  userId: string;
  notificationType: string;
  referenceId?: string;
  referenceType?: string;
  title: string;
  message: string;
  priority: string;
  userType?: string;
  route?: string;
  iconType?: IconType;
  routeType?: RouteType;
}) {
  await notificationModel.create({
    user_id: userId,
    notification_type: notificationType,
    reference_id: referenceId,
    reference_type: referenceType,
    title,
    message,
    priority,
    ...(userType && { user_type: userType }),
    ...(route && { route }),
    ...(iconType && { iconType }),
    ...(routeType && { routeType }),
  });
}


async function getFcmToken(userId: string): Promise<string | null> {
  const user = await userModel.findById(userId).select("fcm_token").lean();
  return (user as any)?.fcm_token ?? null;
}



//  AUTH / REGISTRATION EVENTS

/**
 * Triggered: auth_controller → activate (after a new user account is created).
 * Recipient: the new user themselves.
 */

export async function sendWelcomeNotification(
  userId: string,
  firstName: string,
  role: string,
) {
  try {

    const fcmToken = await getFcmToken(userId);
    const title = "Welcome to Delivery Tracking!";

    const message = `Hi ${firstName}, your account has been created successfully. Start exploring the app!`;
    const iconType: IconType = "delivery_app";

    const notificationData = {
      type: "account_created",
      route: "/home",
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId,
      notificationType: "account_created",
      referenceType: "User",
      title,
      message,
      priority: "low",
      userType: role,
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store welcome notification:", err));

  } catch (error) {
    console.error("Failed to send welcome notification:", error);
  }
}


/**
 * Triggered: auth_controller → createManager (when admin creates a new manager account).
 * Recipient: the newly created manager.
 */

export async function sendManagerAccountCreatedNotification(
  managerUserId: string,
  firstName: string,
  lastName: string,
) {
  try {

    const fcmToken = await getFcmToken(managerUserId);
    const title = "Manager Account Created";

    const message = `Dear ${firstName} ${lastName}, your manager account has been created successfully. You can now log in and manage your company.`;
    const iconType: IconType = "manager_app";

    const notificationData = {
      type: "account_created",
      route: "/manager/dashboard",
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: managerUserId,
      notificationType: "account_created",
      referenceType: "User",
      title,
      message,
      priority: "normal",
      userType: "manager",
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store manager account notification:", err));

  } catch (error) {
    console.error("Failed to send manager account created notification:", error);
  }
}



