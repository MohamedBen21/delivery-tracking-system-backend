import mongoose, { Document, Model, Schema } from "mongoose";

export type AvailabilityStatus = 'available' | 'on_route' | 'off_duty' | 'on_break' | 'maintenance';

export type VerificationStatus = 'pending' | 'in_review' | 'verified' | 'rejected';

export interface ILocation {
  type: 'Point';
  coordinates: [number, number]; 
}

export interface IDelivererDocuments {
  contractImage?: string; 
  idCardImage?: string; 
  licenseImage?: string;
  licenseNumber?: string;
  licenseExpiry?: Date;
  backgroundCheck?: string;
  insuranceImage?: string;
}

export interface IPerformance {
  averageDeliveryTime: number; 
  onTimeDeliveryRate: number;
  customerSatisfaction: number;//avg rating
  totalDistanceCovered: number;
}

export interface IDeliverer extends Document {
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  
  currentLocation?: ILocation;
  lastLocationUpdate?: Date;

  currentVehicleId?: mongoose.Types.ObjectId;
  currentRouteId?: mongoose.Types.ObjectId;

  availabilityStatus: AvailabilityStatus;
  
  verificationStatus: VerificationStatus;
  documents?: IDelivererDocuments;
  verificationNotes?: string;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  rejectionReason?: string;

  rating: number;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  
  performance: IPerformance;

  isActive: boolean;
  isSuspended: boolean;
  suspensionReason?: string;
  
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date;
  
  isVerified: boolean;
  isAvailable: boolean;
  isOnDuty: boolean;
  successRate: number;
  canAcceptDeliveries: boolean;
  hasValidLicense: boolean;
  documentStatus: 'complete' | 'incomplete' | 'expired';
  efficiencyScore: number;
}

const locationSchema = new Schema<ILocation>({
  type: {
    type: String,
    enum: ['Point'],
    default: 'Point',
    required: true,
  },
  coordinates: {
    type: [Number],
    required: true,
    validate: {
      validator: function(v: number[]) {
        return (
          Array.isArray(v) &&
          v.length === 2 &&
          v[0] >= -180 && v[0] <= 180 && 
          v[1] >= -90 && v[1] <= 90      
        );
      },
      message: 'Coordinates must be valid [longitude, latitude] values',
    },
  },
}, { _id: false });


const delivererDocumentsSchema = new Schema<IDelivererDocuments>({

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

const performanceSchema = new Schema<IPerformance>({

  averageDeliveryTime: {
    type: Number,
    default: 0,
    min: 0,
  },

  onTimeDeliveryRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },

  customerSatisfaction: {
    type: Number,
    default: 0,
    min: 0,
    max: 5,
  },

  totalDistanceCovered: {
    type: Number,
    default: 0,
    min: 0,
  },

}, { _id: false });


const delivererSchema = new Schema<IDeliverer>({

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

  branchId: {

    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'Branch reference is required'],
    index: true,
  },
  
  currentLocation: {
    type: locationSchema,
    required: false,
  },

  lastLocationUpdate: {
    type: Date,
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
  
  availabilityStatus: {
    type: String,
    enum: {
      values: ['available', 'on_route', 'off_duty', 'on_break', 'maintenance'],
      message: 'Availability status entered: {VALUE} is not valid.',
    },
    default: 'available',
    index: true,
  },
  
  verificationStatus: {
    type: String,
    enum: {
      values: ['pending', 'in_review', 'verified', 'rejected'],
      message: 'Verification status entered: {VALUE} is not valid.',
    },
    default: 'pending',
    index: true,
  },

  documents: {
    type: delivererDocumentsSchema,
    required: false,
  },

  verificationNotes: {
    type: String,
    trim: true,
    maxlength: [500, 'Notes cannot exceed 500 characters'],
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

  totalDeliveries: {
    type: Number,
    default: 0,
    min: 0,
  },

  successfulDeliveries: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator: function(v: number) {
        return v <= this.totalDeliveries;
      },
      message: 'Successful deliveries cannot exceed total deliveries.',
    },
  },

  failedDeliveries: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator: function(v: number) {
        return v <= this.totalDeliveries;
      },
      message: 'Failed deliveries cannot exceed total deliveries.',
    },
  },
  
  performance: {
    type: performanceSchema,
    default: () => ({
      averageDeliveryTime: 0,
      onTimeDeliveryRate: 0,
      customerSatisfaction: 0,
      totalDistanceCovered: 0,
    }),
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

  lastActiveAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});



delivererSchema.virtual('isVerified').get(function() {
  return this.verificationStatus === 'verified';
});

delivererSchema.virtual('isAvailable').get(function() {
  return (
    this.availabilityStatus === 'available' &&
    this.isActive &&
    !this.isSuspended &&
    this.isVerified
  );
});

delivererSchema.virtual('isOnDuty').get(function() {
  return (
    this.availabilityStatus === 'available' || 
    this.availabilityStatus === 'on_route'
  );
});

delivererSchema.virtual('successRate').get(function() {
  if (this.totalDeliveries === 0) return 0;
  return (this.successfulDeliveries / this.totalDeliveries) * 100;
});

delivererSchema.virtual('canAcceptDeliveries').get(function() {
  return (
    this.isAvailable &&
    this.isOnDuty &&
    this.documentStatus === 'complete' &&
    this.hasValidLicense &&
    !!this.currentLocation
  );
});

delivererSchema.virtual('hasValidLicense').get(function() {
  if (!this.documents?.licenseExpiry) return false;
  return this.documents.licenseExpiry > new Date();
});

delivererSchema.virtual('documentStatus').get(function() {
  if (!this.documents) return 'incomplete';
  
  const requiredDocs = [
    'contractImage',
    'idCardImage', 
    'licenseImage',
    'licenseNumber',
    'licenseExpiry',
    'backgroundCheck',
  ];
  
  const missingDocs = requiredDocs.filter(doc => !this.documents?.[doc as keyof IDelivererDocuments]);
  
  if (missingDocs.length > 0) return 'incomplete';
  
  if (this.documents.licenseExpiry && this.documents.licenseExpiry < new Date()) {
    return 'expired';
  }
  
  return 'complete';
});


delivererSchema.methods.verify = function(
  verifiedBy: mongoose.Types.ObjectId,
  notes?: string
) {
  this.verificationStatus = 'verified';
  this.verifiedBy = verifiedBy;
  this.verifiedAt = new Date();
  this.verificationNotes = notes;
  return this.save();
};


delivererSchema.methods.reject = function(
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


delivererSchema.methods.setAvailability = function(status: AvailabilityStatus) {
  this.availabilityStatus = status;
  this.lastActiveAt = new Date();
  return this.save();
};


delivererSchema.methods.updateLocation = function(coordinates: [number, number]) {
  this.currentLocation = {
    type: 'Point',
    coordinates: coordinates,
  };
  this.lastLocationUpdate = new Date();
  this.lastActiveAt = new Date();
  return this.save();
};


delivererSchema.methods.assignVehicle = function(vehicleId: mongoose.Types.ObjectId) {
  this.currentVehicleId = vehicleId;
  this.lastActiveAt = new Date();
  return this.save();
};


delivererSchema.methods.release = function() {
  this.currentVehicleId = undefined;
  this.currentRouteId = undefined;
  this.availabilityStatus = 'available';
  this.lastActiveAt = new Date();
  return this.save();
};

delivererSchema.methods.canAcceptDelivery = function() {
  return (
    this.canAcceptDeliveries &&
    !this.isSuspended &&
    this.currentVehicleId 
  );
};

delivererSchema.pre('save', function(next) {

  if (this.isModified('availabilityStatus')) {
    this.lastActiveAt = new Date();
  }
  
  if (this.successfulDeliveries + this.failedDeliveries > this.totalDeliveries) {
    return next(new Error('Sum of successful and failed deliveries cannot exceed total deliveries'));
  }
  
  if (this.successfulDeliveries === 0 && this.performance.averageDeliveryTime > 0) {
    return next(new Error('Cannot have average delivery time without successful deliveries'));
  }
  
  next();
});

delivererSchema.index({ userId: 1 });
delivererSchema.index({ companyId: 1 });
delivererSchema.index({ branchId: 1 });
delivererSchema.index({ verificationStatus: 1, availabilityStatus: 1 });
delivererSchema.index({ rating: -1 });
delivererSchema.index({ currentLocation: '2dsphere' }); 

const DelivererModel: Model<IDeliverer> = mongoose.model<IDeliverer>('Deliverer', delivererSchema);

export default DelivererModel;