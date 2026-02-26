import mongoose, { Document, Model, Schema } from "mongoose";

export type FreelancerStatus = 'active' | 'inactive' | 'suspended' | 'pending_verification';

export interface IFreelancerStatistics {
  totalPackagesSent: number;
  packagesInTransit: number;
  packagesDelivered: number;
  packagesFailed: number;
  packagesCancelled: number;
  totalSpent: number;
  averagePackageValue: number;
  successRate: number; 
}

export interface IFreelancer extends Document {
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  
  businessName?: string;
  businessType?: 'individual' | 'small_business' | 'ecommerce' | 'other';
  
  status: FreelancerStatus;
  
  statistics: IFreelancerStatistics;

  defaultOriginBranchId: mongoose.Types.ObjectId;
  preferredDeliveryType?: 'home' | 'branch_pickup';
  
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date;
  
  isActive: boolean;
}

const freelancerStatisticsSchema = new Schema<IFreelancerStatistics>({
  totalPackagesSent: {
    type: Number,
    default: 0,
    min: 0,
  },
  packagesInTransit: {
    type: Number,
    default: 0,
    min: 0,
  },
  packagesDelivered: {
    type: Number,
    default: 0,
    min: 0,
  },
  packagesFailed: {
    type: Number,
    default: 0,
    min: 0,
  },
  packagesCancelled: {
    type: Number,
    default: 0,
    min: 0,
  },
  totalSpent: {
    type: Number,
    default: 0,
    min: 0,
  },
  averagePackageValue: {
    type: Number,
    default: 0,
    min: 0,
  },
  successRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
}, { _id: false });

const freelancerSchema = new Schema<IFreelancer>({
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
  
  businessName: {
    type: String,
    trim: true,
    maxlength: [100, 'Business name cannot exceed 100 characters'],
  },
  
  businessType: {
    type: String,
    enum: {
      values: ['individual', 'small_business', 'ecommerce', 'other'],
      message: 'Business type must be one of: individual, small_business, ecommerce, other',
    },
    default: 'individual',
  },
  
  status: {
    type: String,
    enum: {
      values: ['active', 'inactive', 'suspended', 'pending_verification'],
      message: 'Status must be one of: active, inactive, suspended, pending_verification',
    },
    default: 'pending_verification',
  },
  
  statistics: {
    type: freelancerStatisticsSchema,
    default: () => ({
      totalPackagesSent: 0,
      packagesInTransit: 0,
      packagesDelivered: 0,
      packagesFailed: 0,
      packagesCancelled: 0,
      totalSpent: 0,
      averagePackageValue: 0,
      successRate: 0,
    }),
  },
  
  defaultOriginBranchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'Default origin branch reference is required'],
  },
  
  preferredDeliveryType: {
    type: String,
    enum: ['home', 'branch_pickup'],
    default: 'home',
  },
  
  lastActiveAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

freelancerSchema.virtual('isActive').get(function() {
  return this.status === 'active';
});

freelancerSchema.methods.incrementPackageCount = function() {
  this.statistics.totalPackagesSent += 1;
  this.lastActiveAt = new Date();
  return this.save();
};

freelancerSchema.methods.updateStatistics = function(updates: Partial<IFreelancerStatistics>) {
  Object.assign(this.statistics, updates);
  
  if (this.statistics.totalPackagesSent > 0) {
    this.statistics.successRate = 
      (this.statistics.packagesDelivered / this.statistics.totalPackagesSent) * 100;
  }
  
  if (this.statistics.totalPackagesSent > 0) {
    this.statistics.averagePackageValue = 
      this.statistics.totalSpent / this.statistics.totalPackagesSent;
  }
  
  return this.save();
};

freelancerSchema.index({ userId: 1 });
freelancerSchema.index({ companyId: 1 });
freelancerSchema.index({ status: 1 });
freelancerSchema.index({ companyId: 1, status: 1 });
freelancerSchema.index({ lastActiveAt: -1 });

const FreelancerModel: Model<IFreelancer> = mongoose.model<IFreelancer>('Freelancer', freelancerSchema);

export default FreelancerModel;