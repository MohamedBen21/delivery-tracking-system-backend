import mongoose, { Document, Model, Schema } from "mongoose";


export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 
'friday' | 'saturday' | 'sunday';


export interface IOperatingHours {
  open: string;  
  close: string; 
}


export interface IBranchAddress {
  street: string;
  city: string;
  state: string;
  postalCode?: string;
}

export type BranchStatus = 'active' | 'inactive' | 'maintenance' | 'pending';

const operatingHoursRegex: RegExp = /^(?:([0-1]?[0-9]|2[0-3]):[0-5][0-9]|Closed)$/;
const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex: RegExp = /^(\+213|0)(5|6|7)[0-9]{8}$/;

const defaultOperatingHours = {
  monday: { open: "08:00", close: "20:00" },
  tuesday: { open: "08:00", close: "20:00" },
  wednesday: { open: "08:00", close: "20:00" },
  thursday: { open: "08:00", close: "20:00" },
  friday: { open: "08:00", close: "20:00" },
  saturday: { open: "10:00", close: "18:00" },
  sunday: { open: "Closed", close: "Closed" }
};

export interface IBranch extends Document {
  companyId: mongoose.Types.ObjectId;
  name: string;
  code: string;
  
  address: IBranchAddress;
  location: {
    type: 'Point';
    coordinates: [number, number]; 
  };
  
  phone: string;
  email: string;
  
  operatingHours: Record<WeekDay, IOperatingHours>;
  
  capacityLimit?: number;
  currentLoad: number;

  status: BranchStatus;
  
  createdAt: Date;
  updatedAt: Date;

  isFull: boolean;
  isOpen: boolean;
  isAvailable: boolean;
  fullAddress: string;
}

const branchAddressSchema = new Schema<IBranchAddress>({
  street: {
    type: String,
    required: [true, 'Street address is required'],
    trim: true,
    minlength: [2, 'street name must be at least 2 characters'],
    maxlength: [50, 'street name cannot exceed 50 characters'],
  },
  city: {
    type: String,
    required: [true, 'City is required'],
    trim: true,
    minlength: [2, 'City name must be at least 2 characters'],
    maxlength: [20, 'City name cannot exceed 20 characters'],
  },
  state: {
    type: String,
    required: [true, 'State is required'],
    trim: true,
    minlength: [2, 'state name must be at least 2 characters'],
    maxlength: [20, 'state name cannot exceed 20 characters'],
  },
  postalCode: {
    type: String,
    trim: true,
  },
}, { _id: false });


const operatingHoursSchema = new Schema<IOperatingHours>({
  open: {
    type: String,
    required: true,
    match: [ operatingHoursRegex, 'Open time must be in HH:MM format'],
  },
  close: {
    type: String,
    required: true,
    match: [ operatingHoursRegex, 'Close time must be in HH:MM format'],
  },
}, { _id: false });


const branchSchema = new Schema<IBranch>({
  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Branch name is required'],
    trim: true,
    maxlength: [100, 'Branch name cannot exceed 100 characters'],
  },
  code: {
    type: String,
    required: [true, 'Branch code is required'],
    unique: true,
    trim: true,
    uppercase: true,
    match: [/^[A-Z]{3,5}-\d{2,4}$/, 'Branch code must be in format: ABC-01 or CITY-001'],
  },
  address: {
    type: branchAddressSchema,
    required: [true, 'Address is required'],
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
      required: true,
    },
    coordinates: {
      type: [Number],
      required: [true, 'Coordinates are required'],
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
  phone: {
    type: String,
    trim: true,
    match: [phoneRegex, 'Please enter a valid phone number'],
    required: [true, 'Phone number is required'],
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    match: [emailRegex, 'Please enter a valid email address'],
    required: [true, 'email is required'],
  },
  operatingHours: {
    type: {
      monday: operatingHoursSchema,
      tuesday: operatingHoursSchema,
      wednesday: operatingHoursSchema,
      thursday: operatingHoursSchema,
      friday: operatingHoursSchema,
      saturday: operatingHoursSchema,
      sunday: operatingHoursSchema,
    },
    default: defaultOperatingHours,
    required: true,
  },
  capacityLimit: {
    type: Number,
    min: [1, 'Capacity limit must be at least 1'],
    max: [100000, 'Capacity limit cannot exceed 100000'],
  },
  currentLoad: {
    type: Number,
    default: 0,
    min: [0, 'Current load cannot be negative'],
    validate: {
      validator: function(v: number) {
        if (this.capacityLimit && v > this.capacityLimit) {
          return false;
        }
        return true;
      },
      message: 'Current load cannot exceed capacity limit',
    },
  },
  status: {
    type: String,
    enum: {
      values: ['active', 'inactive', 'maintenance', 'pending'],
      message: 'Status must be one of: active, inactive, maintenance, pending',
    },
    default: 'active',
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});


branchSchema.virtual('isFull').get(function() {
  if (!this.capacityLimit) return false;
  return this.currentLoad >= this.capacityLimit;
});

branchSchema.virtual('isOpen').get(function() {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() as WeekDay;
  const time = now.toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit',
  });

  const hours = this.operatingHours[day];
  if (hours.open === 'Closed' || hours.close === 'Closed') return false;

  return time >= hours.open && time <= hours.close;
});

branchSchema.virtual('isAvailable').get(function() {
  return this.status === 'active' && !this.isFull && this.isOpen;
});

branchSchema.virtual('fullAddress').get(function() {
  const { street, city, state, postalCode } = this.address;
  const parts = [street, city, state];
  if (postalCode) parts.push(postalCode);
  return parts.join(', ');
});

branchSchema.virtual('availableCapacity').get(function() {
  if (!this.capacityLimit) return Infinity;
  return this.capacityLimit - this.currentLoad;
});

branchSchema.index({ companyId: 1, status: 1 });
branchSchema.index({ code: 1 });
branchSchema.index({ location: '2dsphere' });
branchSchema.index({ status: 1 });
branchSchema.index({ 'address.city': 1 });

branchSchema.pre('save', function(next) {

  if (this.operatingHours) {
    const days = Object.keys(this.operatingHours) as WeekDay[];
    days.forEach(day => {
      const hours = this.operatingHours[day];
      if (hours.open !== 'Closed' && hours.close !== 'Closed') {
        if (hours.open >= hours.close) {
          return next(new Error(`${day}: Open time must be before close time`));
        }
      }
    });
  }
  
  next();
});

branchSchema.statics.findActiveByCompany = function(companyId: string) {
  return this.find({ companyId, status: 'active' });
};

branchSchema.statics.findWithAvailableCapacity = function(companyId?: string) {
  const query: any = { 
    status: 'active',
    $or: [
      { capacityLimit: { $exists: false } },
      { $expr: { $lt: ['$currentLoad', '$capacityLimit'] } }
    ]
  };
  
  if (companyId) query.companyId = companyId;
  
  return this.find(query);
};

branchSchema.statics.findNearLocation = function(coordinates: [number, number], maxDistance: number = 10000) {
  return this.find({
    location: {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates,
        },
        $maxDistance: maxDistance,
      },
    },
    status: 'active',
  });
};

branchSchema.methods.updateDayHours = function(day: WeekDay, hours: IOperatingHours) {
  this.operatingHours[day] = hours;
  return this.save();
};

branchSchema.methods.canAcceptPackages = function(count: number = 1) {
  if (this.status !== 'active') return false;
  if (this.isFull) return false;
  
  if (this.capacityLimit) {
    return (this.currentLoad + count) <= this.capacityLimit;
  }
  
  return true;
};

const BranchModel: Model<IBranch> = mongoose.models.Branch || 
  mongoose.model<IBranch>('Branch', branchSchema);

export default BranchModel;