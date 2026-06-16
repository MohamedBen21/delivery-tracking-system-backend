import mongoose, { Document, Model, Schema } from "mongoose";





export type CashierScanAction =
  | 'claim_package'
  | 'reject_package'
  | 'weigh_package'
  | 'update_package'
  | 'print_label'
  | 'collect_payment'
  | 'issue_receipt'
  | 'assign_to_manifest'
  | 'hold_package'
  | 'release_hold';

export type CashierShiftStatus = 'active' | 'on_break' | 'ended';

export type CashierStatus = 'active' | 'inactive' | 'suspended';


export type RejectionReason =
  | 'damaged_on_arrival'
  | 'prohibited_item'
  | 'wrong_dimensions'
  | 'overweight'
  | 'missing_documentation'
  | 'payment_declined'
  | 'address_unserviceable'
  | 'duplicate_package'
  | 'other';




export interface ICashierScanEntry {
  action: CashierScanAction;
  packageId?: mongoose.Types.ObjectId;
  trackingNumber?: string;           

  manifestId?: mongoose.Types.ObjectId;
  manifestCode?: string;

  branchId: mongoose.Types.ObjectId;
  timestamp: Date;
  notes?: string;
  success: boolean;
  errorMessage?: string;


  amountCollected?: number;


  rejectionReason?: RejectionReason;
}


export interface ICashierShift {
  branchId: mongoose.Types.ObjectId;
  startedAt: Date;
  endedAt?: Date;
  status: CashierShiftStatus;

  packagesClaimedCount: number;
  packagesRejectedCount: number;
  labelsIssuedCount: number;
  paymentsCollectedCount: number;
  totalAmountCollected: number;    

  durationMinutes?: number;
  notes?: string;
}


export interface ICashierStats {
  totalPackagesClaimed: number;
  totalPackagesRejected: number;
  totalLabelsIssued: number;
  totalPaymentsCollected: number;
  totalAmountCollected: number;
  totalManifestsAssigned: number;
  totalShifts: number;
  lastActiveAt?: Date;
}


export interface IMerchantVisit {
  merchantId: mongoose.Types.ObjectId;      
  merchantName: string;                     
  visitedAt: Date;
  packageCount: number;
  totalWeight: number;
  totalAmount: number;
  paymentMethod?: string;
  notes?: string;
}



export interface ICashier extends Document {

  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;


  assignedBranchId: mongoose.Types.ObjectId;

  
  counterNumber?: number;

  employeeCode: string;  

  status: CashierStatus;


  currentShift?: ICashierShift | null;


  recentShifts: ICashierShift[];


  recentScans: ICashierScanEntry[];


  recentMerchantVisits: IMerchantVisit[];

  stats: ICashierStats;

  notes?: string;
  createdAt: Date;
  updatedAt: Date;

  isCheckedIn: boolean;
  currentShiftDurationMinutes?: number;


  checkIn(branchId: mongoose.Types.ObjectId): Promise<ICashier>;
  checkOut(notes?: string): Promise<ICashier>;
  logScan(entry: Omit<ICashierScanEntry, 'timestamp'>): Promise<ICashier>;
  logMerchantVisit(visit: IMerchantVisit): Promise<ICashier>;
  incrementStats(action: CashierScanAction, amount?: number): Promise<ICashier>;
}

export interface ICashierModel extends Model<ICashier> {
  findAvailableAtBranch(branchId: string): Promise<ICashier[]>;
  findCheckedIn(companyId?: string): Promise<ICashier[]>;
}



const cashierScanEntrySchema = new Schema<ICashierScanEntry>(
  {
    action: {
      type: String,
      required: [true, 'Scan action is required'],
      enum: {
        values: [
          'claim_package', 'reject_package', 'weigh_package', 'update_package',
          'print_label', 'collect_payment', 'issue_receipt',
          'assign_to_manifest', 'hold_package', 'release_hold',
        ],
        message: 'Scan action must be one of the allowed values',
      },
    },
    packageId: {
      type: Schema.Types.ObjectId,
      ref: 'Package',
    },
    trackingNumber: {
      type: String,
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
    amountCollected: {
      type: Number,
      min: [0, 'Amount collected cannot be negative'],
    },
    rejectionReason: {
      type: String,
      enum: {
        values: [
          'damaged_on_arrival', 'prohibited_item', 'wrong_dimensions',
          'overweight', 'missing_documentation', 'payment_declined',
          'address_unserviceable', 'duplicate_package', 'other',
        ],
        message: 'Rejection reason must be one of the allowed values',
      },
    },
  },
  { _id: true, timestamps: false }
);

const cashierShiftSchema = new Schema<ICashierShift>(
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
    packagesClaimedCount: { type: Number, default: 0, min: 0 },
    packagesRejectedCount: { type: Number, default: 0, min: 0 },
    labelsIssuedCount: { type: Number, default: 0, min: 0 },
    paymentsCollectedCount: { type: Number, default: 0, min: 0 },
    totalAmountCollected: { type: Number, default: 0, min: 0 },
    durationMinutes: { type: Number, min: 0 },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
  },
  { _id: true, timestamps: false }
);

const cashierStatsSchema = new Schema<ICashierStats>(
  {
    totalPackagesClaimed: { type: Number, default: 0, min: 0 },
    totalPackagesRejected: { type: Number, default: 0, min: 0 },
    totalLabelsIssued: { type: Number, default: 0, min: 0 },
    totalPaymentsCollected: { type: Number, default: 0, min: 0 },
    totalAmountCollected: { type: Number, default: 0, min: 0 },
    totalManifestsAssigned: { type: Number, default: 0, min: 0 },
    totalShifts: { type: Number, default: 0, min: 0 },
    lastActiveAt: Date,
  },
  { _id: false }
);

const merchantVisitSchema = new Schema<IMerchantVisit>(
  {
    merchantId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Merchant reference is required'],
    },
    merchantName: {
      type: String,
      required: [true, 'Merchant name is required'],
      trim: true,
      maxlength: [100, 'Merchant name cannot exceed 100 characters'],
    },
    visitedAt: {
      type: Date,
      default: Date.now,
    },
    packageCount: {
      type: Number,
      required: true,
      min: [1, 'Package count must be at least 1'],
    },
    totalWeight: {
      type: Number,
      required: true,
      min: [0, 'Total weight cannot be negative'],
    },
    totalAmount: {
      type: Number,
      required: true,
      min: [0, 'Total amount cannot be negative'],
    },
    paymentMethod: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
  },
  { _id: true, timestamps: false }
);



const cashierSchema = new Schema<ICashier, ICashierModel>(
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
    counterNumber: {
      type: Number,
      min: [1, 'Counter number must be at least 1'],
      max: [999, 'Counter number cannot exceed 999'],
    },
    employeeCode: {
      type: String,
      required: [true, 'Employee code is required'],
      unique: true,
      trim: true,
      uppercase: true,
      match: [/^CSH-[A-Z]{2,5}-\d{3,6}$/, 'Employee code must be in format: CSH-XX-000'],
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
      type: cashierShiftSchema,
      default: null,
    },
    recentShifts: {
      type: [cashierShiftSchema],
      default: [],
      validate: {
        validator: (v: ICashierShift[]) => v.length <= 30,
        message: 'recentShifts buffer cannot exceed 30 entries',
      },
    },
    recentScans: {
      type: [cashierScanEntrySchema],
      default: [],
      validate: {
        validator: (v: ICashierScanEntry[]) => v.length <= 200,
        message: 'recentScans buffer cannot exceed 200 entries',
      },
    },
    recentMerchantVisits: {
      type: [merchantVisitSchema],
      default: [],
      validate: {
        validator: (v: IMerchantVisit[]) => v.length <= 100,
        message: 'recentMerchantVisits buffer cannot exceed 100 entries',
      },
    },
    stats: {
      type: cashierStatsSchema,
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




cashierSchema.virtual('isCheckedIn').get(function () {
  return !!this.currentShift && this.currentShift.status === 'active';
});

cashierSchema.virtual('currentShiftDurationMinutes').get(function () {
  if (!this.currentShift) return undefined;
  return Math.round((Date.now() - this.currentShift.startedAt.getTime()) / 60000);
});




cashierSchema.methods.checkIn = function (
  branchId: mongoose.Types.ObjectId
): Promise<ICashier> {
  if (this.status !== 'active') {
    throw new Error(`Cashier account is '${this.status}' and cannot check in`);
  }
  if (this.currentShift && this.currentShift.status === 'active') {
    throw new Error('Cashier already has an active shift');
  }

  this.currentShift = {
    branchId,
    startedAt: new Date(),
    status: 'active',
    packagesClaimedCount: 0,
    packagesRejectedCount: 0,
    labelsIssuedCount: 0,
    paymentsCollectedCount: 0,
    totalAmountCollected: 0,
  };

  this.stats.totalShifts += 1;
  this.stats.lastActiveAt = new Date();

  return this.save();
};

cashierSchema.methods.checkOut = function (notes?: string): Promise<ICashier> {
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

cashierSchema.methods.logScan = function (
  entry: Omit<ICashierScanEntry, 'timestamp'>
): Promise<ICashier> {
  const scanEntry: ICashierScanEntry = { ...entry, timestamp: new Date() };


  this.recentScans.unshift(scanEntry);
  if (this.recentScans.length > 200) {
    this.recentScans = this.recentScans.slice(0, 200);
  }

  this.stats.lastActiveAt = new Date();


  if (this.currentShift && entry.success) {
    switch (entry.action) {
      case 'claim_package':
        this.currentShift.packagesClaimedCount += 1;
        break;
      case 'reject_package':
        this.currentShift.packagesRejectedCount += 1;
        break;
      case 'print_label':
        this.currentShift.labelsIssuedCount += 1;
        break;
      case 'collect_payment':
        this.currentShift.paymentsCollectedCount += 1;
        if (entry.amountCollected) {
          this.currentShift.totalAmountCollected += entry.amountCollected;
        }
        break;
    }
  }

  return this.save();
};

cashierSchema.methods.logMerchantVisit = function (
  visit: IMerchantVisit
): Promise<ICashier> {

  this.recentMerchantVisits.unshift(visit);
  if (this.recentMerchantVisits.length > 100) {
    this.recentMerchantVisits = this.recentMerchantVisits.slice(0, 100);
  }
  return this.save();
};

cashierSchema.methods.incrementStats = function (
  action: CashierScanAction,
  amount?: number
): Promise<ICashier> {
  switch (action) {
    case 'claim_package':
      this.stats.totalPackagesClaimed += 1;
      break;
    case 'reject_package':
      this.stats.totalPackagesRejected += 1;
      break;
    case 'print_label':
      this.stats.totalLabelsIssued += 1;
      break;
    case 'collect_payment':
      this.stats.totalPaymentsCollected += 1;
      if (amount) this.stats.totalAmountCollected += amount;
      break;
    case 'assign_to_manifest':
      this.stats.totalManifestsAssigned += 1;
      break;
  }
  return this.save();
};



cashierSchema.statics.findAvailableAtBranch = function (branchId: string) {
  return this.find({
    assignedBranchId: branchId,
    status: 'active',
  });
};

cashierSchema.statics.findCheckedIn = function (companyId?: string) {
  const query: Record<string, unknown> = {
    'currentShift.status': 'active',
    status: 'active',
  };
  if (companyId) query.companyId = companyId;
  return this.find(query);
};



cashierSchema.index({ companyId: 1, status: 1 });
cashierSchema.index({ assignedBranchId: 1, status: 1 });
cashierSchema.index({ 'currentShift.status': 1 });
cashierSchema.index({ 'stats.lastActiveAt': -1 });



const CashierModel: ICashierModel =
  (mongoose.models.Cashier ||
    mongoose.model<ICashier, ICashierModel>('Cashier', cashierSchema)) as ICashierModel;

export default CashierModel;