import mongoose, { Document, Model, Schema } from "mongoose";

export type ManagerAccessLevel = 'full' | 'limited' | 'view_only'; // for companies with mutltiple co-founders or managers
//w kol wa7ed ykoun 3ndou certain access level.

export type ManagerPermission = 
  | 'can_manage_users'
  | 'can_manage_branches'
  | 'can_view_financials'
  | 'can_manage_settings'
  | 'can_manage_subscription'
  | 'can_view_all_branches'
  | 'can_export_data'
  | 'can_manage_vehicles'
  | 'can_manage_deliverers'
  | 'can_manage_supervisors'
  | 'can_view_analytics'
  | 'can_manage_reports';


export interface IBranchAccess {
  allBranches: boolean;
  specificBranches: mongoose.Types.ObjectId[];
}


export interface IManager extends Document {
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  
  accessLevel: ManagerAccessLevel;
  permissions: ManagerPermission[];
  
  branchAccess: IBranchAccess;
  isActive: boolean;
  
  createdAt: Date;
  updatedAt: Date;

  hasFullAccess: boolean;
  hasLimitedAccess: boolean;
  hasViewOnlyAccess: boolean;
  accessibleBranches: mongoose.Types.ObjectId[]; 
  hasPermission: (permission: ManagerPermission) => boolean;
  canAccessBranch: (branchId: mongoose.Types.ObjectId) => boolean;
}

const MANAGER_PERMISSIONS: ManagerPermission[] = [
  'can_manage_users',
  'can_manage_branches',
  'can_view_financials',
  'can_manage_settings',
  'can_manage_subscription',
  'can_view_all_branches',
  'can_export_data',
  'can_manage_vehicles',
  'can_manage_deliverers',
  'can_manage_supervisors',
  'can_view_analytics',
  'can_manage_reports',
];


const getDefaultPermissions = (accessLevel: ManagerAccessLevel): ManagerPermission[] => {
  const basePermissions: ManagerPermission[] = [
    'can_view_all_branches',
    'can_view_analytics',
  ];
  
  switch (accessLevel) {
    case 'full':
      return [
        ...basePermissions,
        'can_manage_users',
        'can_manage_branches',
        'can_view_financials',
        'can_manage_settings',
        'can_export_data',
        'can_manage_vehicles',
        'can_manage_deliverers',
        'can_manage_supervisors',
        'can_manage_reports',
      ];
    case 'limited':
      return [
        ...basePermissions,
        'can_manage_branches',
        'can_manage_vehicles',
        'can_manage_deliverers',
        'can_manage_supervisors',
        'can_export_data',
        'can_manage_reports',
      ];
    case 'view_only':
      return [
        ...basePermissions,
        'can_view_financials',
      ];
    default:
      return basePermissions;
  }
};


const branchAccessSchema = new Schema<IBranchAccess>({
  allBranches: {
    type: Boolean,
    default: true,
  },
  specificBranches: {
    type: [Schema.Types.ObjectId],
    ref: 'Branch',
    default: [],
    validate: {
      validator: function(branches: mongoose.Types.ObjectId[]) {

        if (this.allBranches && branches.length > 0) {
          return false;
        }
        return new Set(branches.map(id => id.toString())).size === branches.length;
      },
      message: 'Cannot have specific branches when you manage all branches, or duplicate branch ids',
    },
  },
}, { _id: false });



const managerSchema = new Schema<IManager>({

  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User reference is required'],
    unique: true,
  },

  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
  },

  accessLevel: {
    type: String,
    enum: {
      values: ['full', 'limited', 'view_only'],
      message: 'Access level must be one of: full, limited, view_only',
    },
    default: 'full', //one manager
  },

  permissions: {
    type: [String],
    enum: {
      values: MANAGER_PERMISSIONS,
      message: 'Invalid permission value: {VALUE}',
    },
    default: function() {
      return getDefaultPermissions(this.accessLevel);
    },

    validate: {
      validator: function(permissions: string[]) {
        const uniquePermissions = [...new Set(permissions)];
        return uniquePermissions.length === permissions.length;
      },
      message: 'Duplicate permissions are not allowed',
    },
  },

  branchAccess: {
    type: branchAccessSchema,
    default: () => ({
      allBranches: true,
      specificBranches: [],
    }),
  },

  isActive: {
    type: Boolean,
    default: true,
  },

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});


managerSchema.virtual('hasFullAccess').get(function() {
  return this.accessLevel === 'full';
});

managerSchema.virtual('hasLimitedAccess').get(function() {
  return this.accessLevel === 'limited';
});

managerSchema.virtual('hasViewOnlyAccess').get(function() {
  return this.accessLevel === 'view_only';
});


managerSchema.virtual('accessibleBranches').get(function() {
  if (!this.branchAccess) {
    return [];
  }
  if (this.branchAccess.allBranches) {
    return [];
  }
  return this.branchAccess.specificBranches;
});

managerSchema.methods.hasPermission = function(permission: ManagerPermission): boolean {
  return this.permissions.includes(permission);
};

managerSchema.methods.hasPermissions = function(permissions: ManagerPermission[]): boolean {
  return permissions.every(permission => this.permissions.includes(permission));
};

managerSchema.methods.canAccessBranch = function(branchId: mongoose.Types.ObjectId): boolean {
  if (!this.branchAccess) return false;
  
  if (this.branchAccess.allBranches) {
    return true; 
  }
  
  return this.branchAccess.specificBranches.some(
    (id :mongoose.Types.ObjectId) => id.toString() === branchId.toString()
  );
};

managerSchema.methods.addPermission = function(permission: ManagerPermission) {
  if (!this.permissions.includes(permission)) {
    this.permissions.push(permission);
  }
  return this.save();
};


managerSchema.methods.removePermission = function(permission: ManagerPermission) {
  this.permissions = this.permissions.filter((p: ManagerPermission) => p !== permission);
  return this.save();
};


managerSchema.methods.enableAllBranchesAccess = function() {
  this.branchAccess.allBranches = true;
  this.branchAccess.specificBranches = [];
  return this.save();
};


managerSchema.pre('save', function(next) {

  this.permissions = [...new Set(this.permissions)];
  
  if (this.branchAccess.allBranches && this.branchAccess.specificBranches.length > 0) {
    return next(new Error('Cannot have specific branches when allBranches access is enabled'));
  }
  
  if (!this.branchAccess.allBranches && this.branchAccess.specificBranches.length === 0) {
    return next(new Error('Must specify at least one branch when allBranches access is disabled'));
  }
  
  if (this.accessLevel === 'view_only') {
    const managementPermissions: ManagerPermission[] = [
      'can_manage_users',
      'can_manage_branches',
      'can_manage_settings',
      'can_manage_subscription',
      'can_manage_vehicles',
      'can_manage_deliverers',
      'can_manage_supervisors',
      'can_manage_reports',
    ];
    
    const hasManagementPermission = managementPermissions.some(p => 
      this.permissions.includes(p)
    );
    
    if (hasManagementPermission) {
    return next(new Error('View-only manager has management permissions'));
    }
  }
  
  next();
});

managerSchema.index({ userId: 1 });
managerSchema.index({ companyId: 1 });
managerSchema.index({ isActive: 1 });
managerSchema.index({ companyId: 1, isActive: 1 });


const ManagerModel: Model<IManager> = mongoose.model<IManager>('Manager', managerSchema);

export default ManagerModel;