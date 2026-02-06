import mongoose, { Document, Model, Schema } from "mongoose";

const ADMIN_PERMISSIONS = [
  "manage_users",
  "manage_companies",
  "manage_branches",
  "manage_drivers",
  "manage_vehicles",
  "view_packages",
  "update_packages_manually",
  "assign_packages_manually",
  "view_tracking",
  "view_analytics",
  "manage_finances",
] as const;

export type AdminPermission = typeof ADMIN_PERMISSIONS[number];

export interface IAdmin extends Document {
  user_id: mongoose.Types.ObjectId;
  adminLevel: "super_admin" | "admin" | "staff";
  permissions: AdminPermission[];
  isActive: boolean;
  notes?: string;

  hasPermission: (permission: AdminPermission) => boolean;

  hasAllPermissions: () => boolean;
}

const adminSchema: Schema<IAdmin> = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    adminLevel: {
      type: String,
      enum: ["super_admin", "admin", "staff"],
      default: "staff",
    },
    permissions: 
    {
      type: [String],
      enum: {
        values: ADMIN_PERMISSIONS,
        message: "Invalid permission entered: {VALUE}."
      },
      default: [],
      validate: {
        validator: function(permissions: string[]) {

          return permissions.length === new Set(permissions).size;
        },

        message: "Duplicate permissions are not allowed."
      }
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    notes: String,
  },
  { timestamps: true }
);


adminSchema.pre("save", function (next) {
  if (this.adminLevel === "super_admin") {

    this.permissions = [...ADMIN_PERMISSIONS];
  } 
  next();
});

adminSchema.methods.hasPermission = function (permission: AdminPermission): boolean {

  return this.permissions.includes(permission);
};


adminSchema.methods.hasAllPermissions = function (): boolean {

  return ADMIN_PERMISSIONS.every(permission => 
    this.permissions.includes(permission)
  );
};


adminSchema.virtual("isSuperAdmin").get(function() {
  return this.adminLevel === "super_admin" || this.hasAllPermissions();
});


const adminModel: Model<IAdmin> = mongoose.model<IAdmin>("Admin", adminSchema);

export default adminModel;