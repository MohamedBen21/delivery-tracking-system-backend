import mongoose, { Document, Model, Schema } from "mongoose";


export type PackageType = 'document' | 'parcel' | 'fragile' | 'heavy' | 'perishable' | 'electronic' | 'clothing';

export type DeliveryType = 'home' | 'branch_pickup' ;

export type PackageStatus = 
  | 'pending'
  | 'accepted'
  | 'at_origin_branch'
  | 'in_transit_to_branch'
  | 'at_destination_branch'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed_delivery'
  | 'rescheduled'
  | 'returned'
  | 'cancelled'
  | 'lost'
  | 'damaged'
  | 'on_hold';

export type PaymentStatus = 'pending' | 'paid' | 'partially_paid' | 'refunded' | 'failed';

export type PaymentMethod = 'cash' | 'card' | 'cod' | 'wallet' | 'bank_transfer';

export type RefundStatus = 'pending' | 'processed' | 'rejected';

export interface IDimensions {
  length: number; 
  width: number;
  height: number;
}

export interface IDestination {
  recipientName: string;
  recipientPhone: string;
  alternativePhone?: string;
  address: string;
  city: string;
  state: string;
  postalCode?: string;
  location?: {
    type: 'Point';
    coordinates: [number, number];
  };
  notes?: string;
}

export interface IIssue {
  type: 'delay' | 'damage' | 'lost' | 'wrong_address' | 'customer_unavailable' | 'traffic' | 'weather' | 'other';
  description: string;
  reportedBy: mongoose.Types.ObjectId;
  reportedAt: Date;
  resolved: boolean;
  resolvedAt?: Date;
  resolution?: string;
  priority?: 'low' | 'medium' | 'high';
}

export interface IReturnInfo {
  isReturn: boolean;
  reason?: string;
  returnDate?: Date;
  refundAmount?: number;
  refundStatus?: RefundStatus;
  returnNotes?: string;
}

export interface ITrackingEvent {
  status: PackageStatus;
  location?: string;
  branchId?: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  notes?: string;
  timestamp: Date;
}


export interface IPackage extends Document {
  trackingNumber: string;
  companyId: mongoose.Types.ObjectId;
  clientId: mongoose.Types.ObjectId;

  weight: number; 
  volume?: number;
  dimensions?: IDimensions;
  isFragile: boolean;
  type: PackageType;
  description?: string;
  declaredValue?: number;
  images?: string[];
  
  originBranchId: mongoose.Types.ObjectId;
  currentBranchId?: mongoose.Types.ObjectId;
  destinationBranchId?: mongoose.Types.ObjectId;

  destination: IDestination;

  status: PackageStatus;

  deliveryType: DeliveryType;
  deliveryPriority: 'standard' | 'express' | 'same_day';
  
  totalPrice: number;
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethod;
  paidAt?: Date;

  assignedTransporterId?: mongoose.Types.ObjectId;
  assignedDelivererId?: mongoose.Types.ObjectId;
  assignedVehicleId?: mongoose.Types.ObjectId;
  currentRouteId?: mongoose.Types.ObjectId;
  
  attemptCount: number;
  lastAttemptDate?: Date;
  nextAttemptDate?: Date;
  maxAttempts: number;
  
  issues: IIssue[];

  returnInfo: IReturnInfo;

  trackingHistory: ITrackingEvent[];
  
  createdAt: Date;
  estimatedDeliveryTime?: Date;
  deliveredAt?: Date;
  updatedAt: Date;

  isDelivered: boolean;
  isInTransit: boolean;
  isAtBranch: boolean;
  needsAttention: boolean;
  deliveryProgress: number;
  estimatedTimeRemaining?: number;
  isOverdue: boolean;
  canBeDelivered: boolean;
}


const dimensionsSchema = new Schema<IDimensions>({
  length: {
    type: Number,
    min: 1,
  },
  width: {
    type: Number,
    min: 1,
  },
  height: {
    type: Number,
    min: 1,
  },
}, { _id: false });


const destinationSchema = new Schema<IDestination>({

  recipientName: {
    type: String,
    required: [true, 'Recipient name is required'],
    trim: true,
  },

  recipientPhone: {
    type: String,
    required: [true, 'Recipient phone is required'],
    trim: true,
  },

  alternativePhone: {
    type: String,
    trim: true,
  },

  address: {
    type: String,
    required: [true, 'Address is required'],
    trim: true,
  },

  city: {
    type: String,
    required: [true, 'City is required'],
    trim: true,
  },

  state: {
    type: String,
    required: [true, 'State is required'],
    trim: true,
  },

  postalCode: {
    type: String,
    trim: true,
  },

  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },

    coordinates: {
      type: [Number],
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
  },

  notes: {
    type: String,
    trim: true,
    maxlength: [500, 'Delivery notes cannot exceed 500 characters'],
  },
}, { _id: false });


const issueSchema = new Schema<IIssue>({

  type: {
    type: String,
    enum: ['delay', 'damage', 'lost', 'wrong_address', 'customer_unavailable', 'traffic', 'weather', 'other'],
    required: true,
  },

  description: {
    type: String,
    required: [true, 'Issue description is required'],
    trim: true,
  },

  reportedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  reportedAt: {
    type: Date,
    default: Date.now,
  },

  resolved: {
    type: Boolean,
    default: false,
  },

  resolvedAt: {
    type: Date,
  },

  resolution: {
    type: String,
    trim: true,
  },

  priority: {
    type: String,
    enum: {
        values: ['low', 'medium', 'high'],
        message: "priority entered : {VALUE} is not valid.",
    },
    default: 'medium',
  },
}, { _id: false });

const returnInfoSchema = new Schema<IReturnInfo>({

  isReturn: {
    type: Boolean,
    default: false,
  },

  reason: {
    type: String,
    trim: true,
  },

  returnDate: {
    type: Date,
  },

  refundAmount: {
    type: Number,
    min: 0,
  },

  refundStatus: {
    type: String,
    enum: ['pending', 'processed', 'rejected'],
  },

  returnNotes: {
    type: String,
    trim: true,
    maxlength: [500, 'Return notes cannot exceed 500 characters'],
  },

}, { _id: false });


const trackingEventSchema = new Schema<ITrackingEvent>({

  status: {
    type: String,
    required: true,
  },

  location: {
    type: String,
    trim: true,
  },

  branchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
  },

  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },

  notes: {
    type: String,
    trim: true,
  },

  timestamp: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });


const packageSchema = new Schema<IPackage>({

  trackingNumber: {
    type: String,
    required: [true, 'Tracking number is required'],
    unique: true,
    uppercase: true,
    trim: true,
    match: [/^[A-Z0-9]{8,20}$/, 'Tracking number must be 8-20 alphanumeric characters'],
  },

  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
  },

  clientId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Client reference is required'],
  },
  
  weight: {
    type: Number,
    required: [true, 'Weight is required'],
    min: [0.01, 'Weight must be at least 0.01kg'],
    max: [500, 'Weight cannot exceed 500kg'],
  },

  volume: {
    type: Number,
    min: [0.001, 'Volume must be at least 0.001m³'],
    max: [10, 'Volume cannot exceed 10m³'],
  },

  dimensions: {
    type: dimensionsSchema,
    required: false,
  },

  isFragile: {
    type: Boolean,
    default: false,
  },

  type: {
    type: String,
    enum: ['document', 'parcel', 'fragile', 'heavy', 'perishable', 'electronic', 'clothing'],
    default: 'parcel',
  },

  description: {
    type: String,
    trim: true,
    maxlength: [1000, 'Description cannot exceed 1000 characters'],
  },

  declaredValue: {
    type: Number,
    min: 0,
  },

  images: {
    type: [String],
    validate: {
      validator: function(images: string[]) {
        return images.length <= 10;
      },
      message: 'Cannot have more than 10 images',
    },
  },
  
  originBranchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'Origin branch is required'],
  },

  currentBranchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
  },

  destinationBranchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
  },
  
  destination: {
    type: destinationSchema,
    required: [true, 'Destination is required'],
  },
  
  status: {
    type: String,
    enum: ['pending', 'accepted', 'at_origin_branch', 'in_transit_to_branch', 
           'at_destination_branch', 'out_for_delivery', 'delivered', 
           'failed_delivery', 'rescheduled', 'returned', 'cancelled', 
           'lost', 'damaged', 'on_hold'],
    default: 'pending',

  },
  
  deliveryType: {
    type: String,
    enum: ['home', 'branch_pickup', 'locker'],
    default: 'home',
  },
  deliveryPriority: {
    type: String,
    enum: ['standard', 'express', 'same_day'],
    default: 'standard',
  },
  
  totalPrice: {
    type: Number,
    required: [true, 'Total price is required'],
    min: 0,
  },
  
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'partially_paid', 'refunded', 'failed'],
    default: 'pending',
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'cod', 'wallet', 'bank_transfer'],
  },
  paidAt: {
    type: Date,
  },

  assignedTransporterId: {
    type: Schema.Types.ObjectId,
    ref: 'Transporter',
  },
  assignedDelivererId: {
    type: Schema.Types.ObjectId,
    ref: 'Deliverer',
  },
  assignedVehicleId: {
    type: Schema.Types.ObjectId,
    ref: 'Vehicle',
  },
  currentRouteId: {
    type: Schema.Types.ObjectId,
    ref: 'Route',
  },
  

  attemptCount: {
    type: Number,
    default: 0,
    min: 0,
  },

  lastAttemptDate: {
    type: Date,
  },
  nextAttemptDate: {
    type: Date,
  },

  maxAttempts: {
    type: Number,
    default: 3,
    min: 1,
    max: 10,
  },
  

  issues: {
    type: [issueSchema],
    default: [],
  },
  
  returnInfo: {
    type: returnInfoSchema,
    default: () => ({
      isReturn: false,
    }),
  },
  
  trackingHistory: {
    type: [trackingEventSchema],
    default: [],
  },
  

  estimatedDeliveryTime: {
    type: Date,
  },
  deliveredAt: {
    type: Date,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});


packageSchema.virtual('isDelivered').get(function() {
  return this.status === 'delivered';
});

packageSchema.virtual('isInTransit').get(function() {
  const transitStatuses: PackageStatus[] = [
    'in_transit_to_branch',
    'out_for_delivery',
    'at_destination_branch',
  ];
  return transitStatuses.includes(this.status);
});

packageSchema.virtual('isAtBranch').get(function() {
  const branchStatuses: PackageStatus[] = [
    'at_origin_branch',
    'at_destination_branch',
  ];
  return branchStatuses.includes(this.status);
});

packageSchema.virtual('needsAttention').get(function() {
  const attentionStatuses: PackageStatus[] = [
    'failed_delivery',
    'damaged',
    'lost',
    'on_hold',
  ];
  return attentionStatuses.includes(this.status) || 
         this.issues.some(issue => !issue.resolved) ||
         (this.nextAttemptDate && this.nextAttemptDate < new Date());
});

packageSchema.virtual('deliveryProgress').get(function() {
  const statusOrder: Record<PackageStatus, number> = {
    'pending': 0,
    'accepted': 10,
    'at_origin_branch': 20,
    'in_transit_to_branch': 40,
    'at_destination_branch': 60,
    'out_for_delivery': 80,
    'delivered': 100,
    'failed_delivery': 80,
    'rescheduled': 70,
    'returned': 100,
    'cancelled': 0,
    'lost': 0,
    'damaged': 100,
    'on_hold': 50,
  };
  return statusOrder[this.status] || 0;
});

packageSchema.virtual('estimatedTimeRemaining').get(function() {
  if (!this.estimatedDeliveryTime || this.isDelivered) return undefined;
  
  const now = new Date();
  const diffMs = this.estimatedDeliveryTime.getTime() - now.getTime();
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60))); 
});

packageSchema.virtual('isOverdue').get(function() {
  if (!this.estimatedDeliveryTime || this.isDelivered) return false;
  return this.estimatedDeliveryTime < new Date();
});

packageSchema.virtual('canBeDelivered').get(function() {
  return (
    this.status === 'at_destination_branch' ||
    this.status === 'out_for_delivery' ||
    this.status === 'failed_delivery'
  ) && this.paymentStatus === 'paid' && !this.returnInfo.isReturn;
});


packageSchema.methods.updateStatus = function(
  newStatus: PackageStatus,
  userId?: mongoose.Types.ObjectId,
  branchId?: mongoose.Types.ObjectId,
  notes?: string,
  location?: string
) {
  const oldStatus = this.status;
  this.status = newStatus;
  
  this.trackingHistory.push({
    status: newStatus,
    location,
    branchId,
    userId,
    notes: notes || `Status changed from ${oldStatus} to ${newStatus}`,
    timestamp: new Date(),
  });
  
  if (newStatus === 'delivered') {
    this.deliveredAt = new Date();
  } else if (newStatus === 'out_for_delivery') {
    this.lastAttemptDate = new Date();
  } else if (newStatus === 'failed_delivery') {
    this.attemptCount += 1;
    this.lastAttemptDate = new Date();
    
    if (this.attemptCount < this.maxAttempts) {
      const nextDate = new Date();
      nextDate.setDate(nextDate.getDate() + 1);
      this.nextAttemptDate = nextDate;
    }
  }
  
  return this.save();
};


packageSchema.methods.assignDelivery = function(
  delivererId: mongoose.Types.ObjectId,
  vehicleId?: mongoose.Types.ObjectId
) {
  this.assignedDelivererId = delivererId;
  if (vehicleId) this.assignedVehicleId = vehicleId;
  this.status = 'out_for_delivery';
  
  this.trackingHistory.push({
    status: 'out_for_delivery',
    notes: `Assigned to deliverer ${delivererId}`,
    timestamp: new Date(),
  });
  
  return this.save();
};


packageSchema.methods.markAsDelivered = function(
  deliveredBy: mongoose.Types.ObjectId,
  notes?: string
) {
  return this.updateStatus(
    'delivered',
    deliveredBy,
    this.currentBranchId,
    notes || 'Package successfully delivered',
    this.deliveryType === 'home' ? this.destination.address : 'Branch pickup'
  );
};


packageSchema.methods.addIssue = function(
  type: IIssue['type'],
  description: string,
  reportedBy: mongoose.Types.ObjectId,
  priority: IIssue['priority'] = 'medium'
) {
  this.issues.push({
    type,
    description,
    reportedBy,
    reportedAt: new Date(),
    resolved: false,
    priority,
  });

  if (type === 'damage') {
    this.status = 'damaged';
  } else if (type === 'lost') {
    this.status = 'lost';
  } else if (type === 'delay') {
    this.status = 'on_hold';
  }
  
  return this.save();
};

packageSchema.methods.resolveIssue = function(
  issueIndex: number,
  resolution: string,
  resolvedBy: mongoose.Types.ObjectId
) {
  if (issueIndex >= 0 && issueIndex < this.issues.length) {
    this.issues[issueIndex].resolved = true;
    this.issues[issueIndex].resolvedAt = new Date();
    this.issues[issueIndex].resolution = resolution;
  }
  
  if (this.status === 'on_hold' && this.issues.every((issue : IIssue) => issue.resolved)) {
    const lastNormalStatus = this.trackingHistory
      .slice()
      .reverse()
      .find((event : any) => 
        !['on_hold', 'damaged', 'lost'].includes(event.status as PackageStatus)
      );
    
    if (lastNormalStatus) {
      this.status = lastNormalStatus.status as PackageStatus;
    }
  }
  
  return this.save();
};


packageSchema.methods.initiateReturn = function(
  reason: string,
  refundAmount?: number,
  notes?: string
) {
  this.returnInfo = {
    isReturn: true,
    reason,
    returnDate: new Date(),
    refundAmount,
    refundStatus: refundAmount ? 'pending' : undefined,
    returnNotes: notes,
  };
  
  this.status = 'returned';
  
  this.trackingHistory.push({
    status: 'returned',
    notes: `Return initiated: ${reason}`,
    timestamp: new Date(),
  });
  
  return this.save();
};


packageSchema.methods.canBeAccepted = function(): boolean {
  return (
    this.status === 'pending' &&
    this.weight > 0 &&
    this.totalPrice > 0 &&
    !!this.destination.recipientPhone
  );
};

packageSchema.pre('save', function(next) {
  if (this.isNew && !this.trackingNumber) {
    const prefix = 'PKG';
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(1000 + Math.random() * 9000);
    this.trackingNumber = `${prefix}${timestamp}${random}`;
  }
  
  if (this.deliveryType === 'branch_pickup' && !this.destinationBranchId) {
    return next(new Error('Destination branch is required for branch pickup'));
  }
  
  
  if (!this.volume && this.dimensions) {
    const { length, width, height } = this.dimensions;
    this.volume = (length * width * height) / 1000000; 
  }
  
  if (this.paidAt && this.paymentStatus === 'pending') {
    this.paymentStatus = 'paid';
  }
  
  if (this.attemptCount >= this.maxAttempts && this.status === 'failed_delivery') {
    this.status = 'returned';
    this.returnInfo.isReturn = true;
    this.returnInfo.reason = 'Maximum delivery attempts exceeded';
  }
  
  next();
});

packageSchema.index({ trackingNumber: 1 });
packageSchema.index({ companyId: 1, status: 1 });
packageSchema.index({ clientId: 1 });
packageSchema.index({ originBranchId: 1, status: 1 });
packageSchema.index({ currentBranchId: 1, status: 1 });
packageSchema.index({ 'destination.location': '2dsphere' });
packageSchema.index({ createdAt: -1 });
packageSchema.index({ 'trackingHistory.timestamp': -1 });


const PackageModel: Model<IPackage> = mongoose.model<IPackage>('Package', packageSchema);

export default PackageModel;