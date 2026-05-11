import mongoose, { Document, Model, Schema } from "mongoose";


export type AvailabilityStatus = 'available' | 'on_route' | 'off_duty' | 'on_break' | 'maintenance';

export type VerificationStatus = 'pending' | 'in_review' | 'verified' | 'rejected';

/**
 * Two transporter sub-types introduced with the hub/spoke model:
 *
 *  hub_to_hub      — Works a fixed line between exactly two main hubs
 *                    (e.g. Algiers main hub ↔ Constantine main hub).
 *                    assignedLine holds [hubAId, hubBId].
 *                    The transporter always drives the full A→B or B→A leg;
 *                    there are no intermediate stops.
 *
 *  hub_to_branch   — Works from ONE main hub outward to a fixed set of
 *                    local branches that the hub serves.
 *                    assignedBranches holds the branch IDs they visit.
 *                    Multi-stop route; the optimizer assigns manifests (not
 *                    raw packages) to this transporter.
 */
export type TransporterType = 'hub_to_hub' | 'hub_to_branch';

export interface ITransporterDocuments {
  contractImage?: string;
  idCardImage?: string;
  licenseImage?: string;
  licenseNumber?: string;
  licenseExpiry?: Date;
  backgroundCheck?: string;
  insuranceImage?: string;
}

export interface ITransporter extends Document {
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;

  currentBranchId?: mongoose.Types.ObjectId;
  currentVehicleId?: mongoose.Types.ObjectId;
  currentRouteId?: mongoose.Types.ObjectId;

  // ── Hub model fields ────────────────────────────────────────────────────────

  /**
   * Sub-type of this transporter.
   * Required once the transporter is assigned to a hub configuration.
   * Defaults to null (legacy / unset) so the field is optional until onboarding.
   */
  transporterType?: TransporterType;

  /**
   * hub_to_hub only.
   * The two main-hub branch IDs this transporter shuttles between.
   * Always exactly 2 entries — [originHubId, destinationHubId].
   * The transporter may travel in either direction; which end is "home" is
   * determined by currentBranchId at departure time.
   */
  assignedLine?: [mongoose.Types.ObjectId, mongoose.Types.ObjectId];

  /**
   * hub_to_branch only.
   * The array of branch IDs (local branches) this transporter serves from
   * their home hub.  The optimizer builds a multi-stop manifest route using
   * exactly these branches.
   */
  
  assignedBranches?: mongoose.Types.ObjectId[];



  availabilityStatus: AvailabilityStatus;

  verificationStatus: VerificationStatus;
  documents?: ITransporterDocuments;
  verificationNotes?: string;
  verifiedBy?: mongoose.Types.ObjectId;

  verifiedAt?: Date;
  rejectionReason?: string;

  rating: number;
  totalTrips: number;
  completedTrips: number;
  cancelledTrips: number;
  totalDistance: number;
  totalDeliveryTime: number;
  averageDeliveryTime: number;

  isActive: boolean;
  isOnline: boolean;
  isSuspended: boolean;
  suspensionReason?: string;
  suspensionEndDate?: Date;

  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date;


  isVerified: boolean;
  isAvailable: boolean;
  isOnDuty: boolean;
  completionRate: number;
  canAcceptJobs: boolean;
  hasValidLicense: boolean;
  documentStatus: 'complete' | 'incomplete' | 'expired';
  isHubTransporter: boolean;
  isHubToHub: boolean;
  isHubToBranch: boolean;
}


const transporterDocumentsSchema = new Schema<ITransporterDocuments>({

  contractImage: { type: String, trim: true },
  idCardImage:   { type: String, trim: true },
  licenseImage:  { type: String, trim: true },
  licenseNumber: { type: String, trim: true, uppercase: true },
  licenseExpiry: { type: Date },
  backgroundCheck: { type: String, trim: true },
  insuranceImage:  { type: String, trim: true },

}, { _id: false });


const transporterSchema = new Schema<ITransporter>({

  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User reference is required'],
    unique: true,
    index: true,
  },

  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
    index: true,
  },

  currentBranchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    index: true,
  },

  currentVehicleId: {
    type: Schema.Types.ObjectId,
    ref: 'Vehicle',
    index: true,
  },

  currentRouteId: {
    type: Schema.Types.ObjectId,
    ref: 'Route',
    index: true,
  },

 

  transporterType: {
    type: String,
    enum: {
      values: ['hub_to_hub', 'hub_to_branch'],
      message: 'Transporter type must be hub_to_hub or hub_to_branch',
    },
    
    default: null,
    index: true,
  },

  assignedLine: {
    type: [Schema.Types.ObjectId],
    ref: 'Branch',
    validate: {
      validator: function (v: mongoose.Types.ObjectId[]) {
        // Must be exactly 2 entries when present, or empty/null when absent.
        return !v || v.length === 0 || v.length === 2;
      },
      message: 'assignedLine must contain exactly 2 hub branch IDs',
    },
    default: undefined,
  },

  assignedBranches: {
    type: [Schema.Types.ObjectId],
    ref: 'Branch',
    default: undefined,
  },

  // ── Availability / verification ─────────────────────────────────────────────

  availabilityStatus: {
    type: String,
    enum: {
      values: ['available', 'on_route', 'off_duty', 'on_break', 'maintenance'],
      message: 'Availability status entered : {VALUE} is not valid.',
    },
    default: 'available',
    index: true,
  },

  verificationStatus: {
    type: String,
    enum: {
      values: ['pending', 'in_review', 'verified', 'rejected'],
      message: 'Verification status entered : {VALUE} is not valid.',
    },
    default: 'pending',
    index: true,
  },

  documents: {
    type: transporterDocumentsSchema,
    required: false,
  },

  verificationNotes: {
    type: String,
    trim: true,
    maxlength: [500, 'Verification notes cannot exceed 500 characters'],
  },

  verifiedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },

  verifiedAt: { type: Date },

  rejectionReason: {
    type: String,
    trim: true,
    maxlength: [500, 'Rejection reason cannot exceed 500 characters'],
  },

  // ── Statistics ──────────────────────────────────────────────────────────────

  rating: {
    type: Number,
    default: 0,
    min: [0, 'Rating cannot be less than 0'],
    max: [5, 'Rating cannot exceed 5'],
  },
  totalTrips: { type: Number, default: 0, min: 0 },
  completedTrips: { type: Number, default: 0, min: 0 },
  cancelledTrips: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator: function (v: number) { return v <= this.totalTrips; },
      message: 'Cancelled trips cannot exceed total trips.',
    },
  },
  totalDistance:       { type: Number, default: 0, min: 0 },
  totalDeliveryTime:   { type: Number, default: 0, min: 0 },
  averageDeliveryTime: { type: Number, default: 0, min: 0 },

  // ── Status flags ────────────────────────────────────────────────────────────

  isActive:    { type: Boolean, default: true,  index: true },
  isOnline:    { type: Boolean, default: false },
  isSuspended: { type: Boolean, default: false, index: true },
  suspensionReason: {
    type: String,
    trim: true,
    maxlength: [500, 'Suspension reason cannot exceed 500 characters'],
  },
  suspensionEndDate: { type: Date },

  lastActiveAt: { type: Date, default: Date.now },

}, {
  timestamps: true,
  toJSON:   { virtuals: true },
  toObject: { virtuals: true },
});


// ── Virtuals ─────────────────────────────────────────────────────────────────

transporterSchema.virtual('isVerified').get(function () {
  return this.verificationStatus === 'verified';
});

transporterSchema.virtual('isAvailable').get(function () {
  return (
    this.availabilityStatus === 'available' &&
    this.isActive &&
    !this.isSuspended &&
    this.isVerified
  );
});

transporterSchema.virtual('isOnDuty').get(function () {
  return (
    this.availabilityStatus === 'available' ||
    this.availabilityStatus === 'on_route'
  );
});

transporterSchema.virtual('completionRate').get(function () {
  if (this.totalTrips === 0) return 0;
  return (this.completedTrips / this.totalTrips) * 100;
});

transporterSchema.virtual('hasValidLicense').get(function () {
  if (!this.documents?.licenseExpiry) return false;
  return this.documents.licenseExpiry > new Date();
});

transporterSchema.virtual('documentStatus').get(function () {
  if (!this.documents) return 'incomplete';

  const requiredDocs = [
    'contractImage',
    'idCardImage',
    'licenseImage',
    'licenseNumber',
    'licenseExpiry',
    'backgroundCheck',
  ];

  const missingDocs = requiredDocs.filter(
    doc => !this.documents?.[doc as keyof ITransporterDocuments]
  );
  if (missingDocs.length > 0) return 'incomplete';

  if (this.documents.licenseExpiry && this.documents.licenseExpiry < new Date()) {
    return 'expired';
  }
  return 'complete';
});

/**
 * True when the transporter has been configured for the hub model.
 * False for legacy transporters with no transporterType set.
 */
transporterSchema.virtual('isHubTransporter').get(function () {
  return !!this.transporterType;
});

/** Convenience: true when transporterType === 'hub_to_hub'. */
transporterSchema.virtual('isHubToHub').get(function () {
  return this.transporterType === 'hub_to_hub';
});

/** Convenience: true when transporterType === 'hub_to_branch'. */
transporterSchema.virtual('isHubToBranch').get(function () {
  return this.transporterType === 'hub_to_branch';
});

/**
 * canAcceptJobs — extended for hub logic:
 *
 *  hub_to_hub    → must have assignedLine set (2 hubs).
 *  hub_to_branch → must have at least one assignedBranch.
 *  legacy        → no hub-config check (backward-compatible).
 */
transporterSchema.virtual('canAcceptJobs').get(function () {
  if (!this.isAvailable || !this.isOnDuty) return false;
  if (this.documentStatus !== 'complete') return false;
  if (!this.hasValidLicense) return false;

  if (this.transporterType === 'hub_to_hub') {
    return Array.isArray(this.assignedLine) && this.assignedLine.length === 2;
  }
  if (this.transporterType === 'hub_to_branch') {
    return Array.isArray(this.assignedBranches) && this.assignedBranches.length > 0;
  }
  // Legacy transporter (no type set) — original check passes.
  return true;
});


// ── Instance methods ──────────────────────────────────────────────────────────

transporterSchema.methods.verify = function (
  verifiedBy: mongoose.Types.ObjectId,
  notes?: string
) {
  this.verificationStatus = 'verified';
  this.verifiedBy = verifiedBy;
  this.verifiedAt = new Date();
  this.verificationNotes = notes;
  return this.save();
};

transporterSchema.methods.reject = function (
  verifiedBy: mongoose.Types.ObjectId,
  reason: string,
  notes?: string
) {
  this.verificationStatus = 'rejected';
  this.verifiedBy = verifiedBy;
  this.verifiedAt = new Date();
  this.rejectionReason = reason;
  this.verificationNotes = notes;
  return this.save();
};

transporterSchema.methods.setAvailability = function (status: AvailabilityStatus) {
  this.availabilityStatus = status;
  this.lastActiveAt = new Date();
  return this.save();
};

transporterSchema.methods.assign = function (
  branchId: mongoose.Types.ObjectId,
  vehicleId: mongoose.Types.ObjectId
) {
  this.currentBranchId = branchId;
  this.currentVehicleId = vehicleId;
  this.lastActiveAt = new Date();
  return this.save();
};

transporterSchema.methods.release = function () {
  this.currentBranchId = undefined;
  this.currentVehicleId = undefined;
  this.currentRouteId = undefined;
  this.availabilityStatus = 'available';
  return this.save();
};

/**
 * Configures a transporter for the hub-to-hub line.
 * Validates that exactly 2 distinct hub IDs are provided.
 */
transporterSchema.methods.assignHubLine = function (
  hubAId: mongoose.Types.ObjectId,
  hubBId: mongoose.Types.ObjectId
) {
  if (hubAId.toString() === hubBId.toString()) {
    throw new Error('Hub A and Hub B must be different branches');
  }
  this.transporterType = 'hub_to_hub';
  this.assignedLine    = [hubAId, hubBId];
  this.assignedBranches = undefined;
  return this.save();
};

/**
 * Configures a transporter for the hub-to-branch run.
 * Replaces (does not merge) the existing assignedBranches array.
 */
transporterSchema.methods.assignBranches = function (
  branchIds: mongoose.Types.ObjectId[]
) {
  if (!branchIds || branchIds.length === 0) {
    throw new Error('At least one branch must be assigned');
  }
  this.transporterType  = 'hub_to_branch';
  this.assignedBranches = branchIds;
  this.assignedLine     = undefined;
  return this.save();
};


// ── Hooks ────────────────────────────────────────────────────────────────────

transporterSchema.pre('save', function (next) {
  if (this.isModified('availabilityStatus') || this.isModified('verificationStatus')) {
    this.lastActiveAt = new Date();
  }

  if (this.completedTrips + this.cancelledTrips > this.totalTrips) {
    return next(new Error('Sum of completed and cancelled trips cannot exceed total trips'));
  }

  if (this.isSuspended && this.suspensionEndDate && this.suspensionEndDate < new Date()) {
    this.isSuspended = false;
    this.suspensionReason = undefined;
    this.suspensionEndDate = undefined;
    this.availabilityStatus = 'available';
  }

  // Consistency guard: hub_to_hub must have assignedLine, hub_to_branch must
  // have assignedBranches.  We only enforce this when these fields are
  // explicitly modified so that partial saves during onboarding are allowed.
  if (this.isModified('transporterType')) {
    if (this.transporterType === 'hub_to_hub') {
      if (!this.assignedLine || this.assignedLine.length !== 2) {
        return next(new Error('hub_to_hub transporter must have exactly 2 hub IDs in assignedLine'));
      }
    }
    if (this.transporterType === 'hub_to_branch') {
      if (!this.assignedBranches || this.assignedBranches.length === 0) {
        return next(new Error('hub_to_branch transporter must have at least one branch in assignedBranches'));
      }
    }
  }

  next();
});


// ── Indexes ──────────────────────────────────────────────────────────────────

transporterSchema.index({ verificationStatus: 1, availabilityStatus: 1 });
transporterSchema.index({ transporterType: 1, availabilityStatus: 1 });
transporterSchema.index({ assignedLine: 1 });
transporterSchema.index({ assignedBranches: 1 });
transporterSchema.index({ rating: -1 });
transporterSchema.index({ lastActiveAt: -1 });


const TransporterModel: Model<ITransporter> = mongoose.model<ITransporter>('Transporter', transporterSchema);

export default TransporterModel;