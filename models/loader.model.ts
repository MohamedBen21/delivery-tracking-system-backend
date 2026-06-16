import mongoose, { Document, Model, Schema } from "mongoose";



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


  scannedId: mongoose.Types.ObjectId;
  scannedCode: string;           

 
  manifestId?: mongoose.Types.ObjectId;
  manifestCode?: string;


  vehicleId?: mongoose.Types.ObjectId;

  branchId: mongoose.Types.ObjectId;
  timestamp: Date;
  notes?: string;


  success: boolean;
  errorMessage?: string;
}


export interface ILoaderShift {
  branchId: mongoose.Types.ObjectId;
  startedAt: Date;
  endedAt?: Date;
  status: LoaderShiftStatus;


  packagesLoadedCount: number;

  packagesUnloadedCount: number;

  manifestsLoadedCount: number;

  manifestsUnloadedCount: number;


  durationMinutes?: number;
  notes?: string;
}


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



export interface ILoader extends Document {

  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;

 
  assignedBranchId: mongoose.Types.ObjectId;

  
  temporaryBranchId?: mongoose.Types.ObjectId | null;

  employeeCode: string;   // e.g. LDR-ALG-0042

  status: LoaderStatus;


  currentShift?: ILoaderShift | null;


  recentShifts: ILoaderShift[];


  recentScans: ILoaderScanEntry[];

  stats: ILoaderStats;

  notes?: string;
  createdAt: Date;
  updatedAt: Date;


  isCheckedIn: boolean;
  activeBranchId: mongoose.Types.ObjectId;   
  currentShiftDurationMinutes?: number;


  checkIn(branchId: mongoose.Types.ObjectId): Promise<ILoader>;
  checkOut(notes?: string): Promise<ILoader>;
  logScan(entry: Omit<ILoaderScanEntry, 'timestamp'>): Promise<ILoader>;
  incrementStats(action: LoaderScanAction): Promise<ILoader>;
}

export interface ILoaderModel extends Model<ILoader> {
  findAvailableAtBranch(branchId: string): Promise<ILoader[]>;
  findCheckedIn(companyId?: string): Promise<ILoader[]>;
}



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



loaderSchema.virtual('isCheckedIn').get(function () {
  return !!this.currentShift && this.currentShift.status === 'active';
});

loaderSchema.virtual('activeBranchId').get(function () {
  return this.temporaryBranchId ?? this.assignedBranchId;
});

loaderSchema.virtual('currentShiftDurationMinutes').get(function () {
  if (!this.currentShift) return undefined;
  return Math.round((Date.now() - this.currentShift.startedAt.getTime()) / 60000);
});



loaderSchema.methods.checkIn = function (
  branchId: mongoose.Types.ObjectId
): Promise<ILoader> {
  if (this.status !== 'active') {
    throw new Error(`Loader account is '${this.status}' and cannot check in`);
  }
  if (this.currentShift && this.currentShift.status === 'active') {
    throw new Error('Loader already has an active shift');
  }

  this.currentShift = {
    branchId,
    startedAt: new Date(),
    status: 'active',
    packagesLoadedCount: 0,
    packagesUnloadedCount: 0,
    manifestsLoadedCount: 0,
    manifestsUnloadedCount: 0,
  };

  this.stats.totalShifts += 1;
  this.stats.lastActiveAt = new Date();

  return this.save();
};

loaderSchema.methods.checkOut = function (notes?: string): Promise<ILoader> {
  if (!this.currentShift || this.currentShift.status !== 'active') {
    throw new Error('No active shift to end');
  }

  const now = new Date();
  this.currentShift.endedAt = now;
  this.currentShift.status = 'ended';
  this.currentShift.durationMinutes = Math.round(
    (now.getTime() - this.currentShift.startedAt.getTime()) / 60000
  );
  if (notes) this.currentShift.notes = notes;


  this.recentShifts.unshift(this.currentShift);
  if (this.recentShifts.length > 30) {
    this.recentShifts = this.recentShifts.slice(0, 30);
  }

  this.currentShift = null;

  return this.save();
};


loaderSchema.methods.logScan = function (
  entry: Omit<ILoaderScanEntry, 'timestamp'>
): Promise<ILoader> {
  const scanEntry: ILoaderScanEntry = { ...entry, timestamp: new Date() };


  this.recentScans.unshift(scanEntry);
  if (this.recentScans.length > 200) {
    this.recentScans = this.recentScans.slice(0, 200);
  }

  this.stats.lastActiveAt = new Date();


  if (this.currentShift && entry.success) {
    switch (entry.action) {
      case 'scan_in_package':
        this.currentShift.packagesLoadedCount += 1;
        break;
      case 'scan_out_package':
        this.currentShift.packagesUnloadedCount += 1;
        break;
      case 'scan_manifest_on_truck':
        this.currentShift.manifestsLoadedCount += 1;
        break;
      case 'scan_manifest_off_truck':
        this.currentShift.manifestsUnloadedCount += 1;
        break;
    }
  }

  return this.save();
};

loaderSchema.methods.incrementStats = function (
  action: LoaderScanAction
): Promise<ILoader> {
  switch (action) {
    case 'scan_in_package':
      this.stats.totalPackagesLoaded += 1;
      break;
    case 'scan_out_package':
      this.stats.totalPackagesUnloaded += 1;
      break;
    case 'create_manifest':
      this.stats.totalManifestsCreated += 1;
      break;
    case 'seal_manifest':
      this.stats.totalManifestsSealed += 1;
      break;
    case 'scan_manifest_on_truck':
      this.stats.totalManifestsLoaded += 1;
      break;
    case 'scan_manifest_off_truck':
      this.stats.totalManifestsUnloaded += 1;
      break;
    case 'flag_discrepancy':
      this.stats.totalDiscrepanciesFlagged += 1;
      break;
  }
  return this.save();
};



loaderSchema.statics.findAvailableAtBranch = function (branchId: string) {
  return this.find({
    $or: [
      { assignedBranchId: branchId, temporaryBranchId: null },
      { temporaryBranchId: branchId },
    ],
    status: 'active',
  });
};

loaderSchema.statics.findCheckedIn = function (companyId?: string) {
  const query: Record<string, unknown> = {
    'currentShift.status': 'active',
    status: 'active',
  };
  if (companyId) query.companyId = companyId;
  return this.find(query);
};



loaderSchema.pre('save', function (next) {
  if (
    this.temporaryBranchId &&
    this.temporaryBranchId.toString() === this.assignedBranchId.toString()
  ) {
    this.temporaryBranchId = null; 
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