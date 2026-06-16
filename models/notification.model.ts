import mongoose, { Document, Model, Schema } from "mongoose";


type NotificationType =

  | "account_created"
  | "account_blocked"
  | "account_unblocked"

  | "package_created"
  | "package_status_update"
  | "package_claimed"      
  | "package_rejected"      
  | "package_cancelled"
  | "package_assigned"      
  | "package_issue"         
  | "package_issue_resolved"

  | "manifest_sealed"
  | "manifest_arrived"
  | "manifest_discrepancy"

  | "payment_confirmation"
  | "payment_failed"

  | "system_update"
  | "general";

type ReferenceType =
  | "User"
  | "Package"
  | "Manifest"
  | "Freelancer"
  | "Deliverer"
  | "Transporter"
  | "Manager"
  | "Supervisor"
  | "Branch"
  | "PaymentTransaction"
  | "System";

type UserType =
  | "admin"
  | "manager"
  | "supervisor"
  | "cashier"
  | "loader"
  | "deliverer"
  | "transporter"
  | "freelancer"
  | "client";

type PriorityType = "low" | "normal" | "high";

type IconType = "delivery_app" | "freelancer_app" | "client_app" | "manager_app";

type RouteType = "to" | "offAll";



export interface INotification extends Document {
  user_id:           mongoose.Types.ObjectId;
  user_type?:        UserType;
  notification_type: NotificationType;
  reference_id?:     mongoose.Types.ObjectId;
  reference_type?:   ReferenceType;
  title:             string;
  message:           string;
  is_read:           boolean;
  priority:          PriorityType;
  route?:            string;
  routeType?:        RouteType;
  iconType:          IconType;
  expiry_date:       Date;

  
  is_expired:        boolean;
  hours_until_expiry: number;
}



function defaultPriority(this: INotification): PriorityType {
  switch (this.notification_type) {
    case "package_rejected":
    case "package_cancelled":
    case "package_issue":
    case "manifest_discrepancy":
    case "account_blocked":
    case "payment_failed":
      return "high";

    case "package_status_update":
    case "package_claimed":
    case "package_assigned":
    case "manifest_sealed":
    case "manifest_arrived":
    case "payment_confirmation":
      return "normal";

    default:
      return "low";
  }
}

function defaultExpiry(this: INotification): Date {
  switch (this.notification_type) {

    case "package_rejected":
    case "package_issue":
    case "manifest_discrepancy":
    case "account_blocked":
    case "payment_failed":
      return new Date(Date.now() + 24 * 60 * 60 * 1000);


    case "package_status_update":
    case "package_claimed":
    case "package_assigned":
    case "package_cancelled":
    case "manifest_sealed":
    case "manifest_arrived":
    case "payment_confirmation":
      return new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);


    default:
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }
}



const notificationSchema = new Schema<INotification>(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"],
    },

    user_type: {
      type: String,
      enum: [
        "admin", "manager", "supervisor", "cashier",
        "loader", "deliverer", "transporter", "freelancer", "client",
      ],
      required: false,
    },

    notification_type: {
      type: String,
      enum: [
        "account_created", "account_blocked", "account_unblocked",
        "package_created", "package_status_update", "package_claimed",
        "package_rejected", "package_cancelled", "package_assigned",
        "package_issue", "package_issue_resolved",
        "manifest_sealed", "manifest_arrived", "manifest_discrepancy",
        "payment_confirmation", "payment_failed",
        "system_update", "general",
      ],
      required: [true, "Notification type is required"],
    },

    reference_id: {
      type: Schema.Types.ObjectId,
      required: false,
    },

    reference_type: {
      type: String,
      enum: [
        "User", "Package", "Manifest", "Freelancer", "Deliverer",
        "Transporter", "Manager", "Supervisor", "Branch",
        "PaymentTransaction", "System",
      ],
      required: function (this: INotification) {
        return this.reference_id != null;
      },
    },

    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
    },

    message: {
      type: String,
      required: [true, "Message is required"],
      trim: true,
    },

    is_read: {
      type: Boolean,
      default: false,
    },

    priority: {
      type: String,
      enum: ["low", "normal", "high"],
      default: defaultPriority,
    },

    route: {
      type: String,
      required: false,
    },

    routeType: {
      type: String,
      enum: ["to", "offAll"],
      required: false,
    },

    iconType: {
      type: String,
      enum: ["delivery_app", "freelancer_app", "client_app", "manager_app"],
      required: true,
    },

    expiry_date: {
      type: Date,
      default: defaultExpiry,
    },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  },
);



notificationSchema.index({ user_id: 1, createdAt: -1 });
notificationSchema.index({ notification_type: 1, expiry_date: 1 });
notificationSchema.index({ is_read: 1, user_id: 1 });
notificationSchema.index({ expiry_date: 1 }, { expireAfterSeconds: 0 }); 



notificationSchema.virtual("is_expired").get(function (this: INotification) {
  return Date.now() > this.expiry_date.getTime();
});

notificationSchema.virtual("hours_until_expiry").get(function (this: INotification) {
  const ms = this.expiry_date.getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (1000 * 60 * 60));
});



const notificationModel: Model<INotification> =
  mongoose.models.Notification ||
  mongoose.model<INotification>("Notification", notificationSchema);

export default notificationModel;