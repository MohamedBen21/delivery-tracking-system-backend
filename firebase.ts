const dotenv = require("dotenv");
import firebase_admin from "firebase-admin";
import path from "path";
import ErrorHandler from "./utils/ErrorHandler";

dotenv.config();


const serviceAccountPath = path.resolve("./" + process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

console.log("Firebase service account path:", serviceAccountPath);

firebase_admin.initializeApp({
  credential: firebase_admin.credential.cert(serviceAccountPath),
});

export interface INotificationData {
  type: string;
  route?: string;
  id?: string;
  [key: string]: string | undefined;
}

export const sendNotificationToDevice = async (
  fcmToken: string,
  title: string,
  body: string,
  data?: INotificationData,
  imageUrl?: string
) => {
  try {
    console.log("Sending notification to FCM...");
    console.log("FCM Token:", fcmToken);
    console.log("Title:", title);
    console.log("Body:", body);
    console.log("Image URL:", imageUrl);
    
    const message: any = {
      token: fcmToken,
      notification: {
        title,
        body,
        ...(imageUrl && { imageUrl }),
      },
      data: data ? {
        ...data,

        type: data.type,
        ...(data.route && { route: data.route }),
        ...(data.id && { id: data.id }),
      } : {},

      android: {
        notification: {
          ...(imageUrl && { imageUrl }),
          clickAction: data?.route ? "FLUTTER_NOTIFICATION_CLICK" : undefined,
          channelId: "default", 
        },
        priority: "high" as const,
      },

      apns: imageUrl ? {
        payload: {
          aps: {
            "mutable-content": 1,
            sound: "default",
          },
        },
        fcmOptions: {
          imageUrl: imageUrl,
        },
      } : {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    };
    
    console.log("Message payload:", JSON.stringify(message, null, 2));
    
    const response = await firebase_admin.messaging().send(message);
    console.log("Notification sent successfully to FCM:", response);
    return response;
  } catch (error: any) {
    console.error("FCM Error:", error);
    throw new ErrorHandler(error.message || "Failed to send notification", 500);
  }
};

export const sendNotificationToMultipleDevices = async (
  fcmTokens: string[],
  title: string,
  body: string,
  data?: INotificationData,
  imageUrl?: string
) => {
  try {
    const tokens = (fcmTokens || []).filter(Boolean);
    if (tokens.length === 0) {
      console.warn("No FCM tokens provided for multicast notification");
      return { successCount: 0, failureCount: 0 };
    }

    const message: firebase_admin.messaging.MulticastMessage = {
      tokens,
      notification: {
        title,
        body,
        ...(imageUrl && { imageUrl }),
      },
      data: data ? {
        ...data,
        type: data.type,
        ...(data.route && { route: data.route }),
        ...(data.id && { id: data.id }),
      } : {},
      android: {
        notification: {
          ...(imageUrl && { imageUrl }),
          clickAction: data?.route ? "FLUTTER_NOTIFICATION_CLICK" : undefined,
          channelId: "default",
        },
        priority: "high" as const,
      },
      apns: imageUrl ? {
        payload: {
          aps: {
            "mutable-content": 1,
            sound: "default",
          },
        },
        fcmOptions: {
          imageUrl: imageUrl,
        },
      } : {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    };

    console.log("Sending multicast notification:", {
      title,
      body,
      tokensCount: tokens.length,
      data,
      imageUrl,
    });

    const response = await firebase_admin.messaging().sendEachForMulticast(message);
    console.log(
      `Multicast sent. Success: ${response.successCount}, Failures: ${response.failureCount}`
    );
    
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.warn(`Token[${idx}] failed:`, resp.error?.message);
        }
      });
    }
    
    return response;
  } catch (error: any) {
    console.error("FCM Multicast Error:", error);
    throw new ErrorHandler(error.message || "Failed to send multicast notification", 500);
  }
};

export default firebase_admin;