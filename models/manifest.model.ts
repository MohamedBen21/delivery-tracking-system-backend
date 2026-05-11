import mongoose, { Document, Model, Schema } from "mongoose";
import PackageModel from "./package.model";
import { writeHistory } from "../utils/packageHistory.util";

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

// ─────────────────────────────────────────────────────────────────────────────
// Manifest Event interface (separate collection)
// ─────────────────────────────────────────────────────────────────────────────

export interface IManifestEvent extends Document {
  manifestId: mongoose.Types.ObjectId;
  manifestCode: string;               // denormalised for human-readable queries
  eventType: ManifestEventType;

  performedBy: mongoose.Types.ObjectId;
  performerName?: string;
  performerRole?: string;

  branchId?: mongoose.Types.ObjectId; // branch where the event happened
  packageId?: mongoose.Types.ObjectId;// relevant package (for per-package events)
  packageTrackingNumber?: string;

  previousStatus?: ManifestStatus;
  newStatus?: ManifestStatus;

  notes?: string;
  metadata?: Record<string, unknown>; // flexible payload (e.g. vehicle plate, seal no.)
  timestamp: Date;

  // virtual
  timeAgo: string;
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
// Virtuals
// ─────────────────────────────────────────────────────────────────────────────

manifestSchema.virtual('isSealed').get(function () {
  return ['sealed', 'loaded', 'in_transit', 'arrived', 'unloading', 'closed'].includes(this.status);
});

manifestSchema.virtual('isInTransit').get(function () {
  return this.status === 'in_transit';
});

manifestSchema.virtual('isClosed').get(function () {
  return this.status === 'closed' || this.status === 'cancelled';
});

manifestSchema.virtual('hasDiscrepancy').get(function () {
  return this.status === 'discrepancy' || !!this.discrepancy;
});

manifestSchema.virtual('unloadedCount').get(function () {
  return this.packages.filter(
    (p) => p.entryStatus === 'unloaded' || p.entryStatus === 'remanifested'
  ).length;
});

manifestSchema.virtual('remainingCount').get(function () {
  return this.packages.filter((p) => p.entryStatus === 'in_manifest').length;
});

manifestSchema.virtual('durationMinutes').get(function () {
  if (!this.departedAt || !this.arrivedAt) return undefined;
  return Math.round((this.arrivedAt.getTime() - this.departedAt.getTime()) / 60000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Instance Methods
// ─────────────────────────────────────────────────────────────────────────────

manifestSchema.methods.addPackage = function (
  packageId: mongoose.Types.ObjectId,
  trackingNumber: string,
  weight: number,
  scannedBy: mongoose.Types.ObjectId
): Promise<IManifest> {
  if (this.status !== 'open') {
    throw new Error(`Cannot add packages to a manifest with status '${this.status}'`);
  }

  const alreadyIn = this.packages.some(
    (p: IManifestPackageEntry) => p.packageId.toString() === packageId.toString()
  );
  if (alreadyIn) {
    throw new Error(`Package ${trackingNumber} is already in this manifest`);
  }

  const sequence = this.packages.length + 1;
  this.packages.push({
    packageId,
    trackingNumber,
    weight,
    sequence,
    scannedInBy: scannedBy,
    scannedInAt: new Date(),
    entryStatus: 'in_manifest',
  });

  this.packageCount = this.packages.length;
  this.totalDeclaredWeight = parseFloat(
    this.packages.reduce((sum: number, p: IManifestPackageEntry) => sum + p.weight, 0).toFixed(3)
  );

  return this.save();
};

manifestSchema.methods.removePackage = function (
  packageId: mongoose.Types.ObjectId,
  removedBy: mongoose.Types.ObjectId,
  notes?: string
): Promise<IManifest> {
  if (this.status !== 'open') {
    throw new Error(`Cannot remove packages from a manifest with status '${this.status}'`);
  }

  const idx = this.packages.findIndex(
    (p: IManifestPackageEntry) => p.packageId.toString() === packageId.toString()
  );
  if (idx === -1) throw new Error('Package not found in this manifest');

  this.packages.splice(idx, 1);

  // Re-sequence remaining entries
  this.packages.forEach((p: IManifestPackageEntry, i: number) => {
    p.sequence = i + 1;
  });

  this.packageCount = this.packages.length;
  this.totalDeclaredWeight = parseFloat(
    this.packages.reduce((sum: number, p: IManifestPackageEntry) => sum + p.weight, 0).toFixed(3)
  );

  return this.save();
};

manifestSchema.methods.seal = function (
  sealedBy: mongoose.Types.ObjectId,
  sealNumber: string,
  notes?: string
): Promise<IManifest> {
  if (this.status !== 'open') {
    throw new Error(`Cannot seal a manifest with status '${this.status}'`);
  }
  if (this.packages.length === 0) {
    throw new Error('Cannot seal an empty manifest');
  }

  this.sealInfo = {
    sealedBy,
    sealedAt: new Date(),
    sealNumber,
    totalWeight: this.totalDeclaredWeight,
    packageCount: this.packageCount,
    notes,
  };
  this.status = 'sealed';
  this.sealedAt = new Date();

  return this.save();
};

manifestSchema.methods.assignTransport = function (
  transporterId: mongoose.Types.ObjectId,
  vehicleId?: mongoose.Types.ObjectId,
  estimatedArrival?: Date
): Promise<IManifest> {
  if (this.status !== 'sealed') {
    throw new Error(`Cannot assign transport to a manifest with status '${this.status}'`);
  }

  this.transportLeg = {
    transporterId,
    vehicleId,
    assignedAt: new Date(),
    estimatedArrival,
  };
  this.status = 'loaded';
  if (estimatedArrival) this.estimatedArrival = estimatedArrival;

  return this.save();
};



manifestSchema.methods.markDeparted = async function (
  by: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<IManifest> {
  if (this.status !== 'loaded') {
    throw new Error(`Cannot mark departure for a manifest with status '${this.status}'`);
  }

  if (this.transportLeg) {
    this.transportLeg.departedAt = new Date();
  }
  this.status = 'in_transit';
  this.departedAt = new Date();


  const saved = await this.save({ session });

  await (saved as any)._cascadeDepartedToPackages(by, session);

  return saved;
};


manifestSchema.methods.markArrived = async function (

  by: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<IManifest> {
  if (this.status !== 'in_transit') {
    throw new Error(`Cannot mark arrival for a manifest with status '${this.status}'`);
  }

  if (this.transportLeg) {
    this.transportLeg.arrivedAt = new Date();
  }
  this.status = 'arrived';
  this.arrivedAt = new Date();

  const saved = await this.save({ session });

  // Cascade to packages
  await (saved as any)._cascadeArrivedToPackages(by, session);

  return saved;
};





// ─────────────────────────────────────────────────────────────────────────────
// Cascade Methods — update contained packages when manifest status changes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called internally by markDeparted().
 * Updates all packages inside this manifest to 'in_transit_to_branch'.
 * Runs in the same transaction session if one is passed.
 */

manifestSchema.methods._cascadeDepartedToPackages = async function (
  performedBy: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<number> {

  
  if (!this.packages || this.packages.length === 0) return 0;

  const packageIds = this.packages.map((p: IManifestPackageEntry) => p.packageId);
  const now = new Date();

  await PackageModel.updateMany(
    { _id: { $in: packageIds } },
    {
      $set: {
        status: 'in_transit_to_branch',
        currentManifestId: this._id,
        ...(this.transportLeg?.transporterId && {
          assignedTransporterId: this.transportLeg.transporterId,
        }),
      },
      $push: {
        trackingHistory: {
          status: 'in_transit_to_branch',
          userId: performedBy,
          notes: `Manifest ${this.manifestCode} departed — package in transit to branch`,
          timestamp: now,
        },
      },
    },
    { session }
  );

  await writeHistory(
    packageIds.map((pid : mongoose.Types.ObjectId) => ({
      packageId: pid,
      status: 'in_transit_to_branch' as import('./package.model').PackageStatus,
      handledBy: performedBy,
      handlerRole: 'transporter' as const,
      manifestId: this._id,
      notes: `Manifest ${this.manifestCode} departed`,
    })),
    session
  );

  return packageIds.length;
};

/**
 * Called internally by markArrived().
 * Packages whose final destination IS this branch → 'at_destination_branch'
 * Packages just passing through → stay 'in_transit_to_branch' but update currentBranchId
 */
manifestSchema.methods._cascadeArrivedToPackages = async function (
  performedBy: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<{ atDestination: number; intermediate: number }> {

  
  if (!this.packages || this.packages.length === 0) {
    return { atDestination: 0, intermediate: 0 };
  }

  const packageIds = this.packages.map((p: IManifestPackageEntry) => p.packageId);
  const destBranchId = this.destinationBranchId;
  const now = new Date();

  // Fetch packages to determine final vs intermediate
  const packages = await PackageModel.find(
    { _id: { $in: packageIds } },
    { _id: 1, destinationBranchId: 1 }
  ).session(session || null).lean();

  const finalDestinationIds: mongoose.Types.ObjectId[] = [];
  const intermediateIds: mongoose.Types.ObjectId[] = [];

  for (const pkg of packages) {
    const isFinal = pkg.destinationBranchId &&
      pkg.destinationBranchId.toString() === destBranchId.toString();
    if (isFinal) {
      finalDestinationIds.push(pkg._id);
    } else {
      intermediateIds.push(pkg._id);
    }
  }

  // ── Final destination packages ──────────────────────────────────────────
  if (finalDestinationIds.length > 0) {
    await PackageModel.updateMany(
      { _id: { $in: finalDestinationIds } },
      {
        $set: {
          status: 'at_destination_branch',
          currentBranchId: destBranchId,
        },
        $push: {
          trackingHistory: {
            status: 'at_destination_branch',
            branchId: destBranchId,
            userId: performedBy,
            notes: `Manifest ${this.manifestCode} arrived — package at destination branch`,
            timestamp: now,
          },
        },
      },
      { session }
    );

    await writeHistory(
      finalDestinationIds.map(pid => ({
        packageId: pid,
        status: 'at_destination_branch' as import('./package.model').PackageStatus,
        handledBy: performedBy,
        handlerRole: 'transporter' as const,
        branchId: destBranchId,
        manifestId: this._id,
        notes: `Manifest ${this.manifestCode} arrived — at destination`,
      })),
      session
    );
  }

  // ── Intermediate (pass-through) packages ─────────────────────────────────
  if (intermediateIds.length > 0) {
    await PackageModel.updateMany(
      { _id: { $in: intermediateIds } },
      {
        $set: {
          status: 'in_transit_to_branch',
          currentBranchId: destBranchId,
        },
        $push: {
          trackingHistory: {
            status: 'in_transit_to_branch',
            branchId: destBranchId,
            userId: performedBy,
            notes: `Manifest ${this.manifestCode} arrived at intermediate hub — continuing to final destination`,
            timestamp: now,
          },
        },
      },
      { session }
    );

    await writeHistory(
      intermediateIds.map(pid => ({
        packageId: pid,
        status: 'in_transit_to_branch' as import('./package.model').PackageStatus,
        handledBy: performedBy,
        handlerRole: 'transporter' as const,
        branchId: destBranchId,
        manifestId: this._id,
        notes: `Manifest ${this.manifestCode} arrived — intermediate hub`,
      })),
      session
    );
  }

  return {
    atDestination: finalDestinationIds.length,
    intermediate: intermediateIds.length,
  };
};



manifestSchema.methods.unloadPackage = function (
  packageId: mongoose.Types.ObjectId,
  unloadedBy: mongoose.Types.ObjectId,
  notes?: string
): Promise<IManifest> {
  const allowedStatuses: ManifestStatus[] = ['arrived', 'unloading'];
  if (!allowedStatuses.includes(this.status)) {
    throw new Error(`Cannot unload packages from a manifest with status '${this.status}'`);
  }

  const entry = this.packages.find(
    (p: IManifestPackageEntry) => p.packageId.toString() === packageId.toString()
  );
  if (!entry) throw new Error('Package not found in this manifest');
  if (entry.entryStatus !== 'in_manifest') {
    throw new Error(`Package entry is already '${entry.entryStatus}'`);
  }

  entry.scannedOutBy = unloadedBy;
  entry.scannedOutAt = new Date();
  entry.entryStatus = 'unloaded';
  if (notes) entry.notes = notes;

  // Transition manifest status to 'unloading' on first scan-out
  if (this.status === 'arrived') {
    this.status = 'unloading';
  }

  return this.save();
};

manifestSchema.methods.remanifestPackage = function (
  packageId: mongoose.Types.ObjectId,
  newManifestId: mongoose.Types.ObjectId,
  performedBy: mongoose.Types.ObjectId
): Promise<IManifest> {
  const entry = this.packages.find(
    (p: IManifestPackageEntry) => p.packageId.toString() === packageId.toString()
  );
  if (!entry) throw new Error('Package not found in this manifest');
  if (entry.entryStatus !== 'in_manifest' && entry.entryStatus !== 'unloaded') {
    throw new Error(`Cannot re-manifest a package with entry status '${entry.entryStatus}'`);
  }

  entry.scannedOutBy = performedBy;
  entry.scannedOutAt = new Date();
  entry.entryStatus = 'remanifested';
  entry.remanifestId = newManifestId;
  entry.remanifestAt = new Date();

  return this.save();
};

manifestSchema.methods.flagDiscrepancy = function (
  reportedBy: mongoose.Types.ObjectId,
  missingIds: mongoose.Types.ObjectId[],
  extraIds: mongoose.Types.ObjectId[],
  notes: string
): Promise<IManifest> {
  const allowedStatuses: ManifestStatus[] = ['arrived', 'unloading', 'closed'];
  if (!allowedStatuses.includes(this.status)) {
    throw new Error(`Cannot flag discrepancy on a manifest with status '${this.status}'`);
  }

  this.discrepancy = {
    reportedBy,
    reportedAt: new Date(),
    expectedCount: this.packageCount,
    actualCount: this.packageCount - missingIds.length + extraIds.length,
    missingPackageIds: missingIds,
    extraPackageIds: extraIds,
    notes,
  };
  this.status = 'discrepancy';

  return this.save();
};

manifestSchema.methods.close = function (
  closedBy: mongoose.Types.ObjectId
): Promise<IManifest> {
  const allowedStatuses: ManifestStatus[] = ['unloading', 'arrived', 'discrepancy'];
  if (!allowedStatuses.includes(this.status)) {
    throw new Error(`Cannot close a manifest with status '${this.status}'`);
  }

  // Mark any remaining 'in_manifest' entries as 'missing'
  this.packages.forEach((p: IManifestPackageEntry) => {
    if (p.entryStatus === 'in_manifest') {
      p.entryStatus = 'missing';
    }
  });

  this.status = 'closed';
  this.closedAt = new Date();

  return this.save();
};

// ─────────────────────────────────────────────────────────────────────────────
// Static Methods
// ─────────────────────────────────────────────────────────────────────────────

manifestSchema.statics.generateManifestCode = async function (
  originCode: string,
  destinationCode: string
): Promise<string> {
  const dateStr = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');
  const count = await this.countDocuments({
    createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
  });
  const seq = String(count + 1).padStart(4, '0');
  return `MAN-${originCode.toUpperCase()}-${destinationCode.toUpperCase()}-${dateStr}-${seq}`;
};

manifestSchema.statics.findActiveByBranch = function (branchId: string) {
  return this.find({
    $or: [{ originBranchId: branchId }, { destinationBranchId: branchId }],
    status: { $nin: ['closed', 'cancelled'] },
  }).sort({ createdAt: -1 });
};

manifestSchema.statics.findByStatus = function (
  status: ManifestStatus,
  companyId?: string
) {
  const query: Record<string, unknown> = { status };
  if (companyId) query.companyId = companyId;
  return this.find(query).sort({ createdAt: -1 });
};

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
// Manifest Event Schema  (separate collection — high-volume audit trail)
// ─────────────────────────────────────────────────────────────────────────────

const manifestEventSchema = new Schema<IManifestEvent>(
  {
    manifestId: {
      type: Schema.Types.ObjectId,
      ref: 'Manifest',
      required: [true, 'Manifest reference is required'],
      index: true,
    },
    manifestCode: {
      type: String,
      required: [true, 'Manifest code is required'],
      trim: true,
      uppercase: true,
      index: true,
    },
    eventType: {
      type: String,
      required: [true, 'Event type is required'],
      enum: {
        values: [
          'created', 'package_added', 'package_removed', 'sealed',
          'loaded_on_vehicle', 'departed', 'arrived', 'unload_started',
          'package_unloaded', 'package_remanifested', 'closed',
          'discrepancy_flagged', 'discrepancy_resolved', 'cancelled', 'note_added',
        ],
        message: 'Event type must be one of the allowed values',
      },
      index: true,
    },
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Performer reference is required'],
    },
    performerName: {
      type: String,
      trim: true,
      maxlength: [100, 'Performer name cannot exceed 100 characters'],
    },
    performerRole: {
      type: String,
      trim: true,
      maxlength: [50, 'Performer role cannot exceed 50 characters'],
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      index: true,
    },
    packageId: {
      type: Schema.Types.ObjectId,
      ref: 'Package',
    },
    packageTrackingNumber: {
      type: String,
      trim: true,
      uppercase: true,
    },
    previousStatus: {
      type: String,
      enum: {
        values: [
          'open', 'sealed', 'loaded', 'in_transit',
          'arrived', 'unloading', 'closed', 'discrepancy', 'cancelled',
        ],
        message: 'Previous status must be one of the allowed values',
      },
    },
    newStatus: {
      type: String,
      enum: {
        values: [
          'open', 'sealed', 'loaded', 'in_transit',
          'arrived', 'unloading', 'closed', 'discrepancy', 'cancelled',
        ],
        message: 'New status must be one of the allowed values',
      },
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

manifestEventSchema.virtual('timeAgo').get(function () {
  const seconds = Math.floor((Date.now() - this.timestamp.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
});

manifestEventSchema.index({ manifestId: 1, timestamp: -1 });
manifestEventSchema.index({ eventType: 1, timestamp: -1 });
manifestEventSchema.index({ performedBy: 1, timestamp: -1 });
manifestEventSchema.index({ packageId: 1, timestamp: -1 });
manifestEventSchema.index({ branchId: 1, eventType: 1, timestamp: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// Models
// ─────────────────────────────────────────────────────────────────────────────

export const ManifestModel: IManifestModel =
  (mongoose.models.Manifest ||
    mongoose.model<IManifest, IManifestModel>('Manifest', manifestSchema)) as IManifestModel;

export const ManifestEventModel: Model<IManifestEvent> =
  mongoose.models.ManifestEvent ||
  mongoose.model<IManifestEvent>('ManifestEvent', manifestEventSchema);

export default ManifestModel;