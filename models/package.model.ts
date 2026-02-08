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

