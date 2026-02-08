import mongoose, { Document, Model, Schema } from "mongoose";
import { PackageStatus } from "./package.model"; // Import from package model

export type HandlerRole = 'transporter' | 'deliverer' | 'branch_supervisor' | 'client' | 'system' | 'admin' | 'manager';

export interface ILocation {
  type: 'Point';
  coordinates: [number, number];
}

export interface IPackageHistory extends Document {
  packageId: mongoose.Types.ObjectId;
  status: PackageStatus;
  
  location?: ILocation;
  branchId?: mongoose.Types.ObjectId;
  
  handledBy?: mongoose.Types.ObjectId;
  handlerName?: string; 
  handlerRole?: HandlerRole;
  
  notes?: string;  
  timestamp: Date;
  
  formattedLocation?: string;
  readableStatus: string;
  timeAgo: string;
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


const packageHistorySchema = new Schema<IPackageHistory>({

  packageId: {
    type: Schema.Types.ObjectId,
    ref: 'Package',
    required: [true, 'Package reference is required'],
    index: true,
  },

  status: {
    type: String,
    required: [true, 'Status is required'],
    enum: {
        values:[
      'pending', 'accepted', 'at_origin_branch', 'in_transit_to_branch',
      'at_destination_branch', 'out_for_delivery', 'delivered',
      'failed_delivery', 'rescheduled', 'returned', 'cancelled',
      'lost', 'damaged', 'on_hold'
    ],
    message:"Status must be one of the allowed values."
    },
  },

  location: {
    type: locationSchema,
    required: false,
  },

  branchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    index: true,
  },

  handledBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },

  handlerName: {
    type: String,
    trim: true,
    maxlength: [100, 'Handler name cannot exceed 100 characters'],
  },

  handlerRole: {
    type: String,
    enum: {
        values:['transporter', 'deliverer', 'branch_supervisor', 'client', 'system', 'admin', 'manager'],
        message:"Handler role must be one of the allowed values."
    },
  },
  
  notes: {
    type: String,
    trim: true,
    maxlength: [1000, 'Notes cannot exceed 1000 characters'],
  },

  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});


packageHistorySchema.virtual('formattedLocation').get(function() {
  if (!this.location) return undefined;
  
  const [lng, lat] = this.location.coordinates;
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
});

packageHistorySchema.virtual('readableStatus').get(function() {
  const statusMap: Record<PackageStatus, string> = {
    'pending': 'Package Created',
    'accepted': 'Package Accepted',
    'at_origin_branch': 'At Origin Branch',
    'in_transit_to_branch': 'In Transit to Branch',
    'at_destination_branch': 'At Destination Branch',
    'out_for_delivery': 'Out for Delivery',
    'delivered': 'Delivered',
    'failed_delivery': 'Delivery Failed',
    'rescheduled': 'Rescheduled',
    'returned': 'Returned',
    'cancelled': 'Cancelled',
    'lost': 'Lost',
    'damaged': 'Damaged',
    'on_hold': 'On Hold',
  };
  
  return statusMap[this.status] || this.status.replace(/_/g, ' ').toUpperCase();
});

packageHistorySchema.virtual('timeAgo').get(function() {
  const now = new Date();
  const seconds = Math.floor((now.getTime() - this.timestamp.getTime()) / 1000);
  
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
  
  const years = Math.floor(days / 365);
  return `${years}y ago`;
});



packageHistorySchema.pre('save', function(next) {

  if (!this.timestamp) {
    this.timestamp = new Date();
  }

  if (this.handlerRole && ['transporter','deliverer','branch_supervisor','client','system','admin','manager'].includes(this.handlerRole)  && !this.handledBy) {
         return next(new Error('Handler role set but no handler reference provided'));
  }
  
  if (this.location && this.location.coordinates) {
    const [lng, lat] = this.location.coordinates;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return next(new Error('Invalid coordinates range'));
    }
  }
  
  next();
});


packageHistorySchema.index({ packageId: 1, timestamp: -1 });
packageHistorySchema.index({ status: 1, timestamp: -1 });
packageHistorySchema.index({ branchId: 1, timestamp: -1 });
packageHistorySchema.index({ handledBy: 1, timestamp: -1 });
packageHistorySchema.index({ handlerRole: 1, timestamp: -1 });
packageHistorySchema.index({ 'location.coordinates': '2dsphere' });
packageHistorySchema.index({ packageId: 1, status: 1, timestamp: -1 });


const PackageHistoryModel: Model<IPackageHistory> = mongoose.model<IPackageHistory>('PackageHistory', packageHistorySchema);

export default PackageHistoryModel;