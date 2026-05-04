import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Lifecycle of a manifest from creation to closure.
 *
 *  open          → being loaded at origin branch (cashier/loader scanning packages in)
 *  sealed        → bag physically closed & labelled; ready for truck loading
 *  loaded        → placed on a truck (transporter assigned)
 *  in_transit    → truck departed origin branch
 *  arrived       → truck arrived at destination branch
 *  unloading     → loader actively scanning packages out at destination branch
 *  closed        → all packages accounted for and removed; manifest complete
 *  discrepancy   → count/scan mismatch found; under investigation
 *  cancelled     → voided before departure (e.g. route change, error)
 */

export type ManifestStatus =
  | 'open'
  | 'sealed'
  | 'loaded'
  | 'in_transit'
  | 'arrived'
  | 'unloading'
  | 'closed'
  | 'discrepancy'
  | 'cancelled';


export type ManifestEventType =
  | 'created'             // manifest opened at origin branch
  | 'package_added'       // package scanned in
  | 'package_removed'     // package removed before sealing
  | 'sealed'              // manifest physically sealed
  | 'loaded_on_vehicle'   // manifest placed on truck
  | 'departed'            // truck left origin branch
  | 'arrived'             // truck arrived at destination branch
  | 'unload_started'      // first package scanned out at destination
  | 'package_unloaded'    // single package scanned out
  | 'package_remanifested'// package moved into a new outbound manifest
  | 'closed'              // all packages accounted for
  | 'discrepancy_flagged' // mismatch detected
  | 'discrepancy_resolved'// mismatch resolved
  | 'cancelled'           // manifest voided
  | 'note_added';         // free-form note by any handler

export type ManifestPriority = 'standard' | 'express' | 'urgent';


/**
 * Each package entry inside the manifest.
 * Tracks the scan-in, scan-out and any re-manifest action per package.
 */
export interface IManifestPackageEntry {
  packageId: mongoose.Types.ObjectId;
  trackingNumber: string;                     // denormalised for fast look-up / display
  weight: number;                             // kg at time of loading
  sequence: number;                           // scan-in order (1-based)

  scannedInBy: mongoose.Types.ObjectId;       // loader / cashier who added it
  scannedInAt: Date;

  scannedOutBy?: mongoose.Types.ObjectId;     // loader who removed it at destination
  scannedOutAt?: Date;

  remanifestId?: mongoose.Types.ObjectId;     // if package was put into a new manifest
  remanifestAt?: Date;

  /** Current state of this package within the manifest */
  entryStatus: 'in_manifest' | 'unloaded' | 'remanifested' | 'missing' | 'damaged';
  notes?: string;
}

/**
 * Discrepancy record when expected vs actual counts differ on arrival.
 */
export interface IManifestDiscrepancy {
  reportedBy: mongoose.Types.ObjectId;
  reportedAt: Date;
  expectedCount: number;
  actualCount: number;
  missingPackageIds: mongoose.Types.ObjectId[];
  extraPackageIds: mongoose.Types.ObjectId[];   // unexpected packages found in bag
  notes: string;
  resolvedBy?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
  resolution?: string;
}

/**
 * Seal information recorded when the manifest bag is physically closed.
 */
export interface IManifestSeal {
  sealedBy: mongoose.Types.ObjectId;
  sealedAt: Date;
  sealNumber: string;   // barcode / label printed on the bag
  totalWeight: number;  // gross weight of sealed bag (kg) //sum of all the packages inside
  packageCount: number;
  notes?: string;
}

/**
 * Transport leg — one truck trip carrying this manifest.
 * A manifest can have a single leg (direct) or two legs
 * (origin → hub → destination) but typically one per manifest.
 */
export interface IManifestTransportLeg {
  vehicleId?: mongoose.Types.ObjectId;
  transporterId: mongoose.Types.ObjectId;     // driver / transporter user
  assignedAt: Date;
  departedAt?: Date;
  arrivedAt?: Date;
  estimatedArrival?: Date;
  notes?: string;
}



export interface IManifest extends Document {
  // Human-readable code printed on the manifest label, e.g. MAN-ALG-ORA-20240101-0042
  manifestCode: string;
  companyId: mongoose.Types.ObjectId;

  originBranchId: mongoose.Types.ObjectId;
  destinationBranchId: mongoose.Types.ObjectId;

  status: ManifestStatus;
  priority: ManifestPriority;

  /** User who opened (created) the manifest — a cashier or loader */
  createdBy: mongoose.Types.ObjectId;
  /** User who sealed the manifest */
  sealInfo?: IManifestSeal;

  transportLeg?: IManifestTransportLeg;

  packages: IManifestPackageEntry[];

  discrepancy?: IManifestDiscrepancy;

  /** Declared total weight (sum of all package weights) — updated on each scan */
  totalDeclaredWeight: number;
  /** Total package count per manifest (convenience — equals packages.length) */
  packageCount: number;

  notes?: string;
  /** Internal reference (waybill, routing slip, etc.) */
  internalReference?: string;

  createdAt: Date;
  updatedAt: Date;
  sealedAt?: Date;
  closedAt?: Date;
  departedAt?: Date;
  arrivedAt?: Date;
  estimatedArrival?: Date;

  // virtual
  isSealed: boolean;
  isInTransit: boolean;
  isClosed: boolean;
  hasDiscrepancy: boolean;
  unloadedCount: number;
  remainingCount: number;
  durationMinutes?: number;

  // method
  addPackage(
    packageId: mongoose.Types.ObjectId,
    trackingNumber: string,
    weight: number,
    scannedBy: mongoose.Types.ObjectId
  ): Promise<IManifest>;

  removePackage(
    packageId: mongoose.Types.ObjectId,
    removedBy: mongoose.Types.ObjectId,
    notes?: string
  ): Promise<IManifest>;

  seal(
    sealedBy: mongoose.Types.ObjectId,
    sealNumber: string,
    notes?: string
  ): Promise<IManifest>;

  assignTransport(
    transporterId: mongoose.Types.ObjectId,
    vehicleId?: mongoose.Types.ObjectId,
    estimatedArrival?: Date
  ): Promise<IManifest>;

  markDeparted(by: mongoose.Types.ObjectId): Promise<IManifest>;

  markArrived(by: mongoose.Types.ObjectId): Promise<IManifest>;

  unloadPackage(
    packageId: mongoose.Types.ObjectId,
    unloadedBy: mongoose.Types.ObjectId,
    notes?: string
  ): Promise<IManifest>;

  remanifestPackage(
    packageId: mongoose.Types.ObjectId,
    newManifestId: mongoose.Types.ObjectId,
    performedBy: mongoose.Types.ObjectId
  ): Promise<IManifest>;

  flagDiscrepancy(
    reportedBy: mongoose.Types.ObjectId,
    missingIds: mongoose.Types.ObjectId[],
    extraIds: mongoose.Types.ObjectId[],
    notes: string
  ): Promise<IManifest>;

  close(closedBy: mongoose.Types.ObjectId): Promise<IManifest>;
}

export interface IManifestModel extends Model<IManifest> {
  generateManifestCode(
    originCode: string,
    destinationCode: string
  ): Promise<string>;
  findActiveByBranch(branchId: string): Promise<IManifest[]>;
  findByStatus(status: ManifestStatus, companyId?: string): Promise<IManifest[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────────────────────────────────────

const manifestPackageEntrySchema = new Schema<IManifestPackageEntry>(
  {
    packageId: {
      type: Schema.Types.ObjectId,
      ref: 'Package',
      required: [true, 'Package reference is required'],
    },
    trackingNumber: {
      type: String,
      required: [true, 'Tracking number is required'],
      trim: true,
      uppercase: true,
    },
    weight: {
      type: Number,
      required: [true, 'Package weight is required'],
      min: [0, 'Weight cannot be negative'],
    },
    sequence: {
      type: Number,
      required: true,
      min: 1,
    },
    scannedInBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Scanner reference is required'],
    },
    scannedInAt: {
      type: Date,
      default: Date.now,
    },
    scannedOutBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    scannedOutAt: {
      type: Date,
    },
    remanifestId: {
      type: Schema.Types.ObjectId,
      ref: 'Manifest',
    },
    remanifestAt: {
      type: Date,
    },
    entryStatus: {
      type: String,
      enum: {
        values: ['in_manifest', 'unloaded', 'remanifested', 'missing', 'damaged'],
        message: 'Entry status must be one of the allowed values',
      },
      default: 'in_manifest',
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
  },
  { _id: true, timestamps: false }
);

const manifestDiscrepancySchema = new Schema<IManifestDiscrepancy>(
  {
    reportedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reportedAt: {
      type: Date,
      default: Date.now,
    },
    expectedCount: {
      type: Number,
      required: true,
      min: 0,
    },
    actualCount: {
      type: Number,
      required: true,
      min: 0,
    },
    missingPackageIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Package',
      },
    ],
    extraPackageIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Package',
      },
    ],
    notes: {
      type: String,
      required: [true, 'Discrepancy notes are required'],
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    resolvedAt: Date,
    resolution: {
      type: String,
      trim: true,
      maxlength: [1000, 'Resolution cannot exceed 1000 characters'],
    },
  },
  { _id: false }
);

const manifestSealSchema = new Schema<IManifestSeal>(
  {
    sealedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    sealedAt: {
      type: Date,
      default: Date.now,
    },
    sealNumber: {
      type: String,
      required: [true, 'Seal number is required'],
      trim: true,
      uppercase: true,
      match: [/^SEAL-[A-Z0-9]{6,12}$/, 'Seal number must be in format: SEAL-XXXXXXXX'],
    },
    totalWeight: {
      type: Number,
      required: true,
      min: 0,
    },
    packageCount: {
      type: Number,
      required: true,
      min: 1,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
  },
  { _id: false }
);

const manifestTransportLegSchema = new Schema<IManifestTransportLeg>(
  {
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle',
    },
    transporterId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Transporter reference is required'],
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    departedAt: Date,
    arrivedAt: Date,
    estimatedArrival: Date,
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Manifest Schema
// ─────────────────────────────────────────────────────────────────────────────

const manifestSchema = new Schema<IManifest, IManifestModel>(
  {
    manifestCode: {
      type: String,
      required: [true, 'Manifest code is required'],
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: [true, 'Company reference is required'],
      index: true,
    },
    originBranchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: [true, 'Origin branch is required'],
      index: true,
    },
    destinationBranchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: [true, 'Destination branch is required'],
      index: true,
    },
    status: {
      type: String,
      enum: {
        values: [
          'open', 'sealed', 'loaded', 'in_transit',
          'arrived', 'unloading', 'closed',
          'discrepancy', 'cancelled',
        ],
        message: 'Status must be one of the allowed values',
      },
      default: 'open',
      index: true,
    },
    priority: {
      type: String,
      enum: {
        values: ['standard', 'express', 'urgent'],
        message: 'Priority must be one of: standard, express, urgent',
      },
      default: 'standard',
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Creator reference is required'],
    },
    sealInfo: {
      type: manifestSealSchema,
      default: null,
    },
    transportLeg: {
      type: manifestTransportLegSchema,
      default: null,
    },
    packages: {
      type: [manifestPackageEntrySchema],
      default: [],
    },
    discrepancy: {
      type: manifestDiscrepancySchema,
      default: null,
    },
    totalDeclaredWeight: {
      type: Number,
      default: 0,
      min: [0, 'Total weight cannot be negative'],
    },
    packageCount: {
      type: Number,
      default: 0,
      min: [0, 'Package count cannot be negative'],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
    },
    internalReference: {
      type: String,
      trim: true,
      maxlength: [100, 'Internal reference cannot exceed 100 characters'],
    },
    sealedAt: Date,
    closedAt: Date,
    departedAt: Date,
    arrivedAt: Date,
    estimatedArrival: Date,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

manifestSchema.pre('save', function (next) {
  if (
    this.originBranchId &&
    this.destinationBranchId &&
    this.originBranchId.toString() === this.destinationBranchId.toString()
  ) {
    return next(new Error('Origin and destination branches cannot be the same'));
  }

  // Keep packageCount in sync
  this.packageCount = this.packages.length;

  next();
});


manifestSchema.index({ companyId: 1, status: 1 });
manifestSchema.index({ originBranchId: 1, status: 1 });
manifestSchema.index({ destinationBranchId: 1, status: 1 });
manifestSchema.index({ 'transportLeg.transporterId': 1, status: 1 });
manifestSchema.index({ createdAt: -1 });
manifestSchema.index({ status: 1, createdAt: -1 });
manifestSchema.index({ 'packages.packageId': 1 });
manifestSchema.index({ 'packages.trackingNumber': 1 });


// ─────────────────────────────────────────────────────────────────────────────
// Models
// ─────────────────────────────────────────────────────────────────────────────

export const ManifestModel: IManifestModel =
  (mongoose.models.Manifest ||
    mongoose.model<IManifest, IManifestModel>('Manifest', manifestSchema)) as IManifestModel;

export default ManifestModel;