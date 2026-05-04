import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * The different scanning actions a loader can perform.
 *
 *  scan_in_package       → scanning a package into a manifest (loading)
 *  scan_out_package      → scanning a package out of a manifest (unloading)
 *  scan_manifest_on_truck→ scanning a sealed manifest onto a vehicle
 *  scan_manifest_off_truck→ scanning a manifest off a vehicle at destination
 *  create_manifest       → opening a new manifest bag
 *  seal_manifest         → physically sealing a manifest bag
 *  close_manifest        → completing unloading and closing the manifest
 *  flag_discrepancy      → reporting a count/damage issue
 */

export type LoaderScanAction =
  | 'scan_in_package'
  | 'scan_out_package'
  | 'scan_manifest_on_truck'
  | 'scan_manifest_off_truck'
  | 'create_manifest'
  | 'seal_manifest'
  | 'close_manifest'
  | 'flag_discrepancy';

export type LoaderShiftStatus = 'active' | 'on_break' | 'ended';

export type LoaderStatus = 'active' | 'inactive' | 'suspended';



export interface ILoaderScanEntry {
  action: LoaderScanAction;

  /** Scanned entity – either a package or a manifest */
  scannedId: mongoose.Types.ObjectId;
  scannedCode: string;           // trackingNumber or manifestCode

  /** The manifest this action was applied to (if applicable) */
  manifestId?: mongoose.Types.ObjectId;
  manifestCode?: string;

  /** Vehicle involved (for on/off-truck scans) */
  vehicleId?: mongoose.Types.ObjectId;

  branchId: mongoose.Types.ObjectId;
  timestamp: Date;
  notes?: string;

  /** true = action completed without error */
  success: boolean;
  errorMessage?: string;
}


export interface ILoaderShift {
  branchId: mongoose.Types.ObjectId;
  startedAt: Date;
  endedAt?: Date;
  status: LoaderShiftStatus;

  /** Total packages loaded into manifests this shift */
  packagesLoadedCount: number;
  /** Total packages unloaded from manifests this shift */
  packagesUnloadedCount: number;
  /** Total manifests loaded onto vehicles this shift */
  manifestsLoadedCount: number;
  /** Total manifests unloaded from vehicles this shift */
  manifestsUnloadedCount: number;

  /** Duration in minutes (computed on shift end) */
  durationMinutes?: number;
  notes?: string;
}

/**
 * Aggregate performance stats maintained as a rolling counter.
 * Updated by the application layer on each action.
 */
export interface ILoaderStats {
  totalPackagesLoaded: number;
  totalPackagesUnloaded: number;
  totalManifestsCreated: number;
  totalManifestsSealed: number;
  totalManifestsLoaded: number;
  totalManifestsUnloaded: number;
  totalDiscrepanciesFlagged: number;
  totalShifts: number;
  lastActiveAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader document interface
// ─────────────────────────────────────────────────────────────────────────────

export interface ILoader extends Document {

  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;

 
  assignedBranchId: mongoose.Types.ObjectId;

  /**
   * A loader can be temporarily assigned to assist another branch.
   * Null when working at their home branch.
   */
  temporaryBranchId?: mongoose.Types.ObjectId | null;

  employeeCode: string;   // e.g. LDR-ALG-0042

  status: LoaderStatus;

  /** The loader's current open shift (null when not checked in) */
  currentShift?: ILoaderShift | null;

  /** Last N shifts kept in-document for quick access (older shifts → separate collection) */
  recentShifts: ILoaderShift[];

  /** Recent scan activity kept in-document (ring-buffer of last 200 scans) */
  recentScans: ILoaderScanEntry[];

  stats: ILoaderStats;

  notes?: string;
  createdAt: Date;
  updatedAt: Date;

  // virtuals
  isCheckedIn: boolean;
  activeBranchId: mongoose.Types.ObjectId;   // temporaryBranchId ?? assignedBranchId
  currentShiftDurationMinutes?: number;

  // methods
  checkIn(branchId: mongoose.Types.ObjectId): Promise<ILoader>;
  checkOut(notes?: string): Promise<ILoader>;
  logScan(entry: Omit<ILoaderScanEntry, 'timestamp'>): Promise<ILoader>;
  incrementStats(action: LoaderScanAction): Promise<ILoader>;
}

export interface ILoaderModel extends Model<ILoader> {
  findAvailableAtBranch(branchId: string): Promise<ILoader[]>;
  findCheckedIn(companyId?: string): Promise<ILoader[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-schemas
// ─────────────────────────────────────────────────────────────────────────────

const loaderScanEntrySchema = new Schema<ILoaderScanEntry>(
  {
    action: {
      type: String,
      required: [true, 'Scan action is required'],
      enum: {
        values: [
          'scan_in_package', 'scan_out_package',
          'scan_manifest_on_truck', 'scan_manifest_off_truck',
          'create_manifest', 'seal_manifest', 'close_manifest', 'flag_discrepancy',
        ],
        message: 'Scan action must be one of the allowed values',
      },
    },
    scannedId: {
      type: Schema.Types.ObjectId,
      required: [true, 'Scanned entity reference is required'],
    },
    scannedCode: {
      type: String,
      required: [true, 'Scanned code is required'],
      trim: true,
      uppercase: true,
    },
    manifestId: {
      type: Schema.Types.ObjectId,
      ref: 'Manifest',
    },
    manifestCode: {
      type: String,
      trim: true,
      uppercase: true,
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle',
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: [true, 'Branch reference is required'],
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
    success: {
      type: Boolean,
      default: true,
    },
    errorMessage: {
      type: String,
      trim: true,
      maxlength: [500, 'Error message cannot exceed 500 characters'],
    },
  },
  { _id: true, timestamps: false }
);

const loaderShiftSchema = new Schema<ILoaderShift>(
  {
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: [true, 'Branch reference is required'],
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: Date,
    status: {
      type: String,
      enum: {
        values: ['active', 'on_break', 'ended'],
        message: 'Shift status must be one of: active, on_break, ended',
      },
      default: 'active',
    },
    packagesLoadedCount: { type: Number, default: 0, min: 0 },
    packagesUnloadedCount: { type: Number, default: 0, min: 0 },
    manifestsLoadedCount: { type: Number, default: 0, min: 0 },
    manifestsUnloadedCount: { type: Number, default: 0, min: 0 },
    durationMinutes: { type: Number, min: 0 },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
  },
  { _id: true, timestamps: false }
);

const loaderStatsSchema = new Schema<ILoaderStats>(
  {
    totalPackagesLoaded: { type: Number, default: 0, min: 0 },
    totalPackagesUnloaded: { type: Number, default: 0, min: 0 },
    totalManifestsCreated: { type: Number, default: 0, min: 0 },
    totalManifestsSealed: { type: Number, default: 0, min: 0 },
    totalManifestsLoaded: { type: Number, default: 0, min: 0 },
    totalManifestsUnloaded: { type: Number, default: 0, min: 0 },
    totalDiscrepanciesFlagged: { type: Number, default: 0, min: 0 },
    totalShifts: { type: Number, default: 0, min: 0 },
    lastActiveAt: Date,
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Loader Schema
// ─────────────────────────────────────────────────────────────────────────────

const loaderSchema = new Schema<ILoader, ILoaderModel>(
  {
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
    assignedBranchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: [true, 'Assigned branch is required'],
      index: true,
    },
    temporaryBranchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
    },
    employeeCode: {
      type: String,
      required: [true, 'Employee code is required'],
      unique: true,
      trim: true,
      uppercase: true,
      match: [/^LDR-[A-Z]{2,5}-\d{3,6}$/, 'Employee code must be in format: LDR-XX-000'],
      index: true,
    },
    status: {
      type: String,
      enum: {
        values: ['active', 'inactive', 'suspended'],
        message: 'Status must be one of: active, inactive, suspended',
      },
      default: 'active',
      index: true,
    },
    currentShift: {
      type: loaderShiftSchema,
      default: null,
    },
    recentShifts: {
      type: [loaderShiftSchema],
      default: [],
      validate: {
        validator: (v: ILoaderShift[]) => v.length <= 30,
        message: 'recentShifts buffer cannot exceed 30 entries',
      },
    },
    recentScans: {
      type: [loaderScanEntrySchema],
      default: [],
      validate: {
        validator: (v: ILoaderScanEntry[]) => v.length <= 200,
        message: 'recentScans buffer cannot exceed 200 entries',
      },
    },
    stats: {
      type: loaderStatsSchema,
      default: () => ({}),
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

loaderSchema.pre('save', function (next) {
  if (
    this.temporaryBranchId &&
    this.temporaryBranchId.toString() === this.assignedBranchId.toString()
  ) {
    this.temporaryBranchId = null; // clear if same as home branch
  }
  next();
});

loaderSchema.index({ companyId: 1, status: 1 });
loaderSchema.index({ assignedBranchId: 1, status: 1 });
loaderSchema.index({ 'currentShift.status': 1 });
loaderSchema.index({ 'stats.lastActiveAt': -1 });

const LoaderModel: ILoaderModel =
  (mongoose.models.Loader ||
    mongoose.model<ILoader, ILoaderModel>('Loader', loaderSchema)) as ILoaderModel;

export default LoaderModel;