import mongoose, { Document, Model, Schema } from "mongoose";


export type AvailabilityStatus = 'available' | 'on_route' | 'off_duty' | 'on_break' | 'maintenance';

export type VerificationStatus = 'pending' | 'in_review' | 'verified' | 'rejected';

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
}


const transporterDocumentsSchema = new Schema<ITransporterDocuments>({

  contractImage: {
    type: String,
    trim: true,
  },

  idCardImage: {
    type: String,
    trim: true,
  },

  licenseImage: {
    type: String,
    trim: true,
  },

  licenseNumber: {
    type: String,
    trim: true,
    uppercase: true,
  },

  licenseExpiry: {
    type: Date,
  },

  backgroundCheck: {
    type: String,
    trim: true,
  },

  insuranceImage: {
    type: String,
    trim: true,
  },

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
    ref:'Route',
    index: true,
  },
  
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

  verifiedAt: {
    type: Date,
  },

  rejectionReason: {
    type: String,
    trim: true,
    maxlength: [500, 'Rejection reason cannot exceed 500 characters'],
  },
  
  rating: {
    type: Number,
    default: 0,
    min: [0, 'Rating cannot be less than 0'],
    max: [5, 'Rating cannot exceed 5'],
  },
  totalTrips: {
    type: Number,
    default: 0,
    min: 0,
  },

  completedTrips: {
    type: Number,
    default: 0,
    min: 0,
  },
  cancelledTrips: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator: function(v: number) {
        return v <= this.totalTrips;
      },
      message: 'Cancelled trips cannot exceed total trips.',
    },
  },

  totalDistance: {
    type: Number,
    default: 0,
    min: 0,
  },
  totalDeliveryTime: {
    type: Number,
    default: 0,
    min: 0,
  },
  averageDeliveryTime: {
    type: Number,
    default: 0,
    min: 0,
  },
  
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  isSuspended: {
    type: Boolean,
    default: false,
    index: true,
  },
  suspensionReason: {
    type: String,
    trim: true,
    maxlength: [500, 'Suspension reason cannot exceed 500 characters'],
  },

  suspensionEndDate: {
    type: Date,
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

transporterSchema.index({ userId: 1 });
transporterSchema.index({ companyId: 1 });
transporterSchema.index({ verificationStatus: 1, availabilityStatus: 1 });
transporterSchema.index({ rating: -1 });
transporterSchema.index({ lastActiveAt: -1 });


const TransporterModel: Model<ITransporter> = mongoose.model<ITransporter>('Transporter', transporterSchema);

export default TransporterModel;