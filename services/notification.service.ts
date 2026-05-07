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



//  PACKAGE LIFECYCLE EVENTS  (triggered from supervisor_controller)

/**
 * Triggered: supervisor_controller → createPackage.
 * Recipient: the freelancer / sender whose package was registered.
 */

export async function sendPackageCreatedNotification(
  senderUserId: string,
  senderType: string,
  packageId: string,
  trackingNumber: string,
) {
  try {

    const fcmToken = await getFcmToken(senderUserId);
    const title = "Package Registered";

    const message = `Your package ${trackingNumber} has been registered successfully and is awaiting pick-up at the branch.`;
    const iconType: IconType = senderType === "freelancer" ? "freelancer_app" : "client_app";

    const notificationData = {
      type: "package_created",
      route: `/packages/${packageId}`,
      id: packageId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: senderUserId,
      notificationType: "package_created",
      referenceId: packageId,
      referenceType: "Package",
      title,
      message,
      priority: "normal",
      userType: senderType,
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store package created notification:", err));

  } catch (error) {
    console.error("Failed to send package created notification:", error);
  }
}


/**
 * Triggered: supervisor_controller → updatePackage (when status changes).
 * Recipients:
 *   - The sender (freelancer or client) for every status change.
 *   - The assigned deliverer when status becomes "out_for_delivery".
 *   - The deliverer when status becomes "accepted" (package assigned to them).
 */

export async function sendPackageStatusUpdatedNotification(
  senderUserId: string,
  senderType: string,
  packageId: string,
  trackingNumber: string,
  newStatus: string,
  assignedDelivererUserId?: string,
) {
  try {

    const statusMessages: Record<string, { title: string; message: string; priority: string }> = {

      accepted: {
        title: "Package Accepted",
        message: `Your package ${trackingNumber} has been accepted at the branch and is being processed.`,
        priority: "normal",
      },

      at_origin_branch: {
        title: "Package at Origin Branch",
        message: `Your package ${trackingNumber} has arrived at the origin branch and is ready for dispatch.`,
        priority: "normal",
      },

      cashier_claimed: {
        title: "Package Received at Counter",
        message: `Your package ${trackingNumber} has been physically received at the branch counter.`,
        priority: "normal",
      },

      in_transit_to_branch: {
        title: "Package In Transit",
        message: `Your package ${trackingNumber} is now on its way to the destination branch.`,
        priority: "normal",
      },

      at_destination_branch: {
        title: "Package Arrived at Destination",
        message: `Your package ${trackingNumber} has arrived at the destination branch and is ready for delivery.`,
        priority: "normal",
      },

      out_for_delivery: {
        title: "Out for Delivery 🚚",
        message: `Your package ${trackingNumber} is out for delivery. Expect it today!`,
        priority: "high",
      },

      delivered: {
        title: "Package Delivered ✅",
        message: `Your package ${trackingNumber} has been successfully delivered. Thank you for using our service!`,
        priority: "high",
      },

      failed_delivery: {
        title: "Delivery Attempt Failed",
        message: `A delivery attempt for package ${trackingNumber} was unsuccessful. We will try again shortly.`,
        priority: "high",
      },

      rescheduled: {
        title: "Delivery Rescheduled",
        message: `The delivery for package ${trackingNumber} has been rescheduled. We will contact you with the new date.`,
        priority: "normal",
      },

      on_hold: {
        title: "Package On Hold",
        message: `Package ${trackingNumber} is currently on hold. Please contact support for more information.`,
        priority: "high",
      },

      returned: {
        title: "Package Being Returned",
        message: `Package ${trackingNumber} is being returned to you. Please prepare to receive it.`,
        priority: "high",
      },

      cancelled: {
        title: "Package Cancelled",
        message: `Package ${trackingNumber} has been cancelled. Contact support if you believe this is an error.`,
        priority: "high",
      },

      lost: {
        title: "Package Reported Lost",
        message: `Package ${trackingNumber} has been reported as lost. Our team is investigating. Please contact support.`,
        priority: "high",
      },

      damaged: {
        title: "Package Reported Damaged",
        message: `Package ${trackingNumber} has been reported as damaged. Please contact support to file a claim.`,
        priority: "high",
      },
    };

    const content = statusMessages[newStatus];
    if (!content) return;

    const iconType: IconType = senderType === "freelancer" ? "freelancer_app" : "client_app";
    const route = `/packages/${packageId}`;

    const notificationData = {
      type: "package_status_update",
      status: newStatus,
      route,
      id: packageId,
      iconType,
    };


    const senderFcmToken = await getFcmToken(senderUserId);

    if (senderFcmToken) {
      await sendNotificationToDevice(senderFcmToken, content.title, content.message, notificationData);
    }

    storeNotificationInDB({
      userId: senderUserId,
      notificationType: "package_status_update",
      referenceId: packageId,
      referenceType: "Package",
      title: content.title,
      message: content.message,
      priority: content.priority,
      userType: senderType,
      route,
      iconType,
    }).catch((err) => console.error("Failed to store package status notification (sender):", err));


    if (assignedDelivererUserId && ["accepted", "out_for_delivery"].includes(newStatus)) {
      const delivererFcmToken = await getFcmToken(assignedDelivererUserId);

      const delivererContent =
        newStatus === "accepted"
          ? {
              title: "New Package Assigned 📦",
              message: `Package ${trackingNumber} has been assigned to you. Check your dashboard for details.`,
              priority: "high",
            }
          : {
              title: "Start Delivery 🚚",
              message: `Package ${trackingNumber} is ready for delivery. Head out now!`,
              priority: "high",
            };

      const delivererNotificationData = {
        type: "package_assigned",
        route: `/deliverer/packages/${packageId}`,
        id: packageId,
        iconType: "delivery_app" as IconType,
      };

      if (delivererFcmToken) {
        await sendNotificationToDevice(

          delivererFcmToken,
          delivererContent.title,
          delivererContent.message,
          delivererNotificationData,
        );
      }

      storeNotificationInDB({

        userId: assignedDelivererUserId,
        notificationType: "package_assigned",
        referenceId: packageId,
        referenceType: "Package",
        title: delivererContent.title,
        message: delivererContent.message,
        priority: delivererContent.priority,
        userType: "deliverer",
        route: delivererNotificationData.route,
        iconType: "delivery_app",

      }).catch((err) =>
        console.error("Failed to store package status notification (deliverer):", err),
      );
    }

  } catch (error) {
    console.error("Failed to send package status update notification:", error);
  }
}


/**
 * Triggered: supervisor_controller → toggleCancelPackage.
 * Recipient: the sender (freelancer/client).
 */

export async function sendPackageCancelledNotification(
  senderUserId: string,
  senderType: string,
  packageId: string,
  trackingNumber: string,
  reason?: string,
) {
  try {

    const fcmToken = await getFcmToken(senderUserId);
    const title = "Package Cancelled";

    const message = reason
      ? `Package ${trackingNumber} has been cancelled. Reason: ${reason}.`
      : `Package ${trackingNumber} has been cancelled. Contact support for more details.`;
    const iconType: IconType = senderType === "freelancer" ? "freelancer_app" : "client_app";

    const notificationData = {

      type: "package_cancelled",
      route: `/packages/${packageId}`,
      id: packageId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: senderUserId,
      notificationType: "package_cancelled",
      referenceId: packageId,
      referenceType: "Package",
      title,
      message,
      priority: "high",
      userType: senderType,
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store package cancelled notification:", err));

  } catch (error) {
    console.error("Failed to send package cancelled notification:", error);
  }
}


/**
 * Triggered: supervisor_controller → addPackageIssue.
 * Recipient: the sender (freelancer/client) when a problem is flagged on their package.
 */

export async function sendPackageIssueReportedNotification(
  senderUserId: string,
  senderType: string,
  packageId: string,
  trackingNumber: string,
  issueType: string,
) {
  try {

    const fcmToken = await getFcmToken(senderUserId);
    const title = "Issue Reported on Your Package ⚠️";

    const message = `An issue of type "${issueType}" has been reported on package ${trackingNumber}. Our team is looking into it.`;
    const iconType: IconType = senderType === "freelancer" ? "freelancer_app" : "client_app";

    const notificationData = {
      type: "package_issue",
      route: `/packages/${packageId}`,
      id: packageId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: senderUserId,
      notificationType: "package_issue",
      referenceId: packageId,
      referenceType: "Package",
      title,
      message,
      priority: "high",
      userType: senderType,
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store package issue notification:", err));

  } catch (error) {
    console.error("Failed to send package issue notification:", error);
  }
}


/**
 * Triggered: supervisor_controller → resolvePackageIssue.
 * Recipient: the sender when the issue on their package is resolved.
 */

export async function sendPackageIssueResolvedNotification(
  senderUserId: string,
  senderType: string,
  packageId: string,
  trackingNumber: string,
) {
  try {

    const fcmToken = await getFcmToken(senderUserId);
    const title = "Package Issue Resolved";

    const message = `The issue reported on package ${trackingNumber} has been resolved. Delivery will continue as normal.`;
    const iconType: IconType = senderType === "freelancer" ? "freelancer_app" : "client_app";

    const notificationData = {
      type: "package_issue_resolved",
      route: `/packages/${packageId}`,
      id: packageId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: senderUserId,
      notificationType: "package_issue_resolved",
      referenceId: packageId,
      referenceType: "Package",
      title,
      message,
      priority: "normal",
      userType: senderType,
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store issue resolved notification:", err));

  } catch (error) {
    console.error("Failed to send package issue resolved notification:", error);
  }
}



//  CASHIER EVENTS

/**
 * Triggered: cashier_controller → claimPackage.
 * Recipient: the freelancer/sender – their package has been physically received.
 */

export async function sendPackageClaimedByCashierNotification(
  senderUserId: string,
  senderType: string,
  packageId: string,
  trackingNumber: string,
  branchName: string,
) {
  try {

    const fcmToken = await getFcmToken(senderUserId);
    const title = "Package Received at Counter ✅";

    const message = `Your package ${trackingNumber} has been received and verified at ${branchName}. It will be dispatched shortly.`;
    const iconType: IconType = senderType === "freelancer" ? "freelancer_app" : "client_app";

    const notificationData = {
      type: "package_claimed",
      route: `/packages/${packageId}`,
      id: packageId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: senderUserId,
      notificationType: "package_claimed",
      referenceId: packageId,
      referenceType: "Package",
      title,
      message,
      priority: "normal",
      userType: senderType,
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store package claimed notification:", err));

  } catch (error) {
    console.error("Failed to send package claimed notification:", error);
  }
}


/**
 * Triggered: cashier_controller → rejectPackage.
 * Recipient: the freelancer/sender – their package was rejected at the counter.
 */

export async function sendPackageRejectedByCashierNotification(
  senderUserId: string,
  senderType: string,
  packageId: string,
  trackingNumber: string,
  rejectionReason: string,
) {
  try {

    const fcmToken = await getFcmToken(senderUserId);
    const title = "Package Rejected at Counter ❌";

    const message = `Your package ${trackingNumber} was rejected at the branch counter. Reason: ${rejectionReason}. Please contact support.`;
    const iconType: IconType = senderType === "freelancer" ? "freelancer_app" : "client_app";

    const notificationData = {
      type: "package_rejected",
      route: `/packages/${packageId}`,
      id: packageId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: senderUserId,
      notificationType: "package_rejected",
      referenceId: packageId,
      referenceType: "Package",
      title,
      message,
      priority: "high",
      userType: senderType,
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store package rejected notification:", err));

  } catch (error) {
    console.error("Failed to send package rejected notification:", error);
  }
}



//  FREELANCER ACCOUNT EVENTS  (triggered from supervisor_controller / freelancer_controller)

/**
 * Triggered: supervisor_controller → createFreelancer.
 * Recipient: the new freelancer.
 */

export async function sendFreelancerAccountCreatedNotification(
  freelancerUserId: string,
  firstName: string,
  lastName: string,
  freelancerId: string,
) {
  try {

    const fcmToken = await getFcmToken(freelancerUserId);
    const title = "Freelancer Account Created 🎉";

    const message = `Dear ${firstName} ${lastName}, your freelancer account has been created successfully. You can now start registering packages through the app.`;
    const iconType: IconType = "freelancer_app";

    const notificationData = {
      type: "account_created",
      route: "/freelancer/dashboard",
      id: freelancerId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: freelancerUserId,
      notificationType: "account_created",
      referenceId: freelancerId,
      referenceType: "Freelancer",
      title,
      message,
      priority: "low",
      userType: "freelancer",
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store freelancer account notification:", err));

  } catch (error) {
    console.error("Failed to send freelancer account created notification:", error);
  }
}


/**
 * Triggered: supervisor_controller → toggleBlockFreelancer.
 * Recipient: the freelancer being blocked or unblocked.
 */

export async function sendFreelancerBlockStatusNotification(
  freelancerUserId: string,
  freelancerId: string,
  isBlocked: boolean,
) {
  try {

    const fcmToken = await getFcmToken(freelancerUserId);
    const title = isBlocked ? "Account Suspended" : "Account Reactivated";

    const message = isBlocked
      ? "Your freelancer account has been suspended. Please contact your branch supervisor for more information."
      : "Your freelancer account has been reactivated. You can now register packages again.";
    const iconType: IconType = "freelancer_app";

    const notificationData = {
      type: isBlocked ? "account_blocked" : "account_unblocked",
      route: "/freelancer/account-status",
      id: freelancerId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: freelancerUserId,
      notificationType: isBlocked ? "account_blocked" : "account_unblocked",
      referenceId: freelancerId,
      referenceType: "Freelancer",
      title,
      message,
      priority: "high",
      userType: "freelancer",
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store freelancer block status notification:", err));
  } catch (error) {
    console.error("Failed to send freelancer block status notification:", error);
  }
}



//  DELIVERER ACCOUNT & ASSIGNMENT EVENTS  (triggered from supervisor_controller)

/**
 * Triggered: supervisor_controller → assignDeliverer.
 * Recipient: the new deliverer.
 */

export async function sendDelivererAccountCreatedNotification(
  delivererUserId: string,
  firstName: string,
  lastName: string,
  delivererId: string,
  branchName: string,
) {
  try {

    const fcmToken = await getFcmToken(delivererUserId);
    const title = "You've Been Assigned as a Deliverer 🚚";

    const message = `Dear ${firstName} ${lastName}, you have been assigned as a deliverer at ${branchName}. Log in to view your deliveries.`;
    const iconType: IconType = "delivery_app";

    const notificationData = {
      type: "account_created",
      route: "/deliverer/dashboard",
      id: delivererId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: delivererUserId,
      notificationType: "account_created",
      referenceId: delivererId,
      referenceType: "Deliverer",
      title,
      message,
      priority: "normal",
      userType: "deliverer",
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store deliverer account notification:", err));

  } catch (error) {
    console.error("Failed to send deliverer account created notification:", error);
  }
}


/**
 * Triggered: supervisor_controller → toggleBlockDeliverer.
 * Recipient: the deliverer being blocked or unblocked.
 */


export async function sendDelivererBlockStatusNotification(
  delivererUserId: string,
  delivererId: string,
  isBlocked: boolean,
) {
  try {

    const fcmToken = await getFcmToken(delivererUserId);
    const title = isBlocked ? "Account Suspended" : "Account Reactivated";

    const message = isBlocked
      ? "Your deliverer account has been suspended. Please contact your supervisor for more information."
      : "Your deliverer account has been reactivated. You can resume accepting deliveries.";
    const iconType: IconType = "delivery_app";

    const notificationData = {
      type: isBlocked ? "account_blocked" : "account_unblocked",
      route: "/deliverer/account-status",
      id: delivererId,
      iconType,
    };

    if (fcmToken) {
      await sendNotificationToDevice(fcmToken, title, message, notificationData);
    }

    storeNotificationInDB({

      userId: delivererUserId,
      notificationType: isBlocked ? "account_blocked" : "account_unblocked",
      referenceId: delivererId,
      referenceType: "Deliverer",
      title,
      message,
      priority: "high",
      userType: "deliverer",
      route: notificationData.route,
      iconType,

    }).catch((err) => console.error("Failed to store deliverer block status notification:", err));

  } catch (error) {
    console.error("Failed to send deliverer block status notification:", error);
  }
}



//  MANIFEST / LOADER EVENTS  (triggered from loader_controller)


/**
 * Triggered: loader_controller → sealManifest.
 * Recipient: supervisors of the destination branch – a sealed manifest is on its way.
 * Uses multi-device send since there may be multiple supervisors.
 */

export async function sendManifestSealedNotification(
  manifestId: string,
  manifestCode: string,
  destinationBranchId: string,
  packageCount: number,
) {
  try {

    const supervisors = await userModel
      .find({ role: "supervisor", fcm_token: { $exists: true, $ne: null } })
      .select("fcm_token _id")
      .lean();

    // We target all supervisors for now; if you have a branch-supervisor join
    // model you can filter by destinationBranchId here.

    const tokens = supervisors
      .map((s) => (s as any).fcm_token as string)
      .filter(Boolean);

    if (!tokens.length) return;

    const title = "Manifest Sealed & Dispatched ";
    const message = `Manifest ${manifestCode} containing ${packageCount} package(s) has been sealed and is heading to your branch.`;
    const iconType: IconType = "manager_app";
    const notificationData = {
      type: "manifest_sealed",
      route: `/manifests/${manifestId}`,
      id: manifestId,
      iconType,
    };

    await sendNotificationToMultipleDevices(tokens, title, message, notificationData);
  } catch (error) {
    console.error("Failed to send manifest sealed notification:", error);
  }
}


/**
 * Triggered: loader_controller → markManifestArrived.
 * Recipient: supervisors – an inbound manifest has arrived and needs unloading.
 */

export async function sendManifestArrivedNotification(
  manifestId: string,
  manifestCode: string,
  packageCount: number,
) {
  try {

    const supervisors = await userModel
      .find({ role: "supervisor", fcm_token: { $exists: true, $ne: null } })
      .select("fcm_token")
      .lean();

    const tokens = supervisors
      .map((s) => (s as any).fcm_token as string)
      .filter(Boolean);

    if (!tokens.length) return;

    const title = "Manifest Arrived ";
    const message = `Manifest ${manifestCode} with ${packageCount} package(s) has arrived at your branch and is ready for unloading.`;

    const iconType: IconType = "manager_app";

    const notificationData = {
      type: "manifest_arrived",
      route: `/manifests/${manifestId}`,
      id: manifestId,
      iconType,
    };

    await sendNotificationToMultipleDevices(tokens, title, message, notificationData);

  } catch (error) {
    console.error("Failed to send manifest arrived notification:", error);
  }
}


/**
 * Triggered: loader_controller → flagDiscrepancy.
 * Recipient: supervisors – a discrepancy was found during manifest unloading.
 */

export async function sendManifestDiscrepancyNotification(
  manifestId: string,
  manifestCode: string,
  missingCount: number,
  extraCount: number,
) {
  try {

    const supervisors = await userModel
      .find({ role: "supervisor", fcm_token: { $exists: true, $ne: null } })
      .select("fcm_token")
      .lean();

    const tokens = supervisors
      .map((s) => (s as any).fcm_token as string)
      .filter(Boolean);

    if (!tokens.length) return;

    const title = "Manifest Discrepancy Reported ⚠️";
    const message = `A discrepancy was flagged on manifest ${manifestCode}: ${missingCount} missing, ${extraCount} extra package(s). Supervisor review required.`;

    const iconType: IconType = "manager_app";

    const notificationData = {
      type: "manifest_discrepancy",
      route: `/manifests/${manifestId}`,
      id: manifestId,
      iconType,
    };

    await sendNotificationToMultipleDevices(tokens, title, message, notificationData);

  } catch (error) {
    console.error("Failed to send manifest discrepancy notification:", error);
  }
}



//  ADMIN / BROADCAST EVENTS


/**
 * Triggered: supervisor_controller → createFreelancer / auth_controller → createManager.
 * Recipient: all admins – a new entity is pending review.
 * Generic helper used for any "admin attention required" scenario.
 */


export async function notifyAdminsNewEntityPending(
  entityId: string,
  entityType: "Freelancer" | "Manager" | "Deliverer" | "Transporter",
  displayName: string,
) {
  try {

    const admins = await userModel
      .find({ role: "admin", fcm_token: { $exists: true, $ne: null } })
      .select("fcm_token")
      .lean();

    const tokens = admins
      .map((a) => (a as any).fcm_token as string)
      .filter(Boolean);

    if (!tokens.length) return;

    const title = `New ${entityType} Registered`;
    const message = `${entityType} "${displayName}" has completed registration and may require your attention.`;

    const iconType: IconType = "manager_app";

    const notificationData = {
      type: "account_created",
      route: "/admin/dashboard",
      id: entityId,
      iconType,
    };

    await sendNotificationToMultipleDevices(tokens, title, message, notificationData);
    
  } catch (error) {
    console.error(`Failed to notify admins of new ${entityType}:`, error);
  }
}