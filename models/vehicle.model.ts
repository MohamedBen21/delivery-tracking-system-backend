import mongoose, { Document, Model, Schema } from "mongoose";


export type VehicleType = 'motorcycle' | 'car' | 'van' | 'small_truck' | 'large_truck';
export type VehicleStatus = 'available' | 'in_use' | 'maintenance' | 'out_of_service' | 'retired';
export type AssignedUserRole = 'transporter' | 'deliverer' | 'driver';


export interface IVehicleDocuments {
  registrationCard?: string; 
  insurance?: string;
  insuranceExpiry?: Date;
  technicalInspection?: string;
  inspectionExpiry?: Date;
}


export interface IVehicle extends Document {
  companyId: mongoose.Types.ObjectId;
  type: VehicleType;
  registrationNumber: string;
  brand?: string;
  modelName?: string;
  year?: number;
  color?: string;
  
  maxWeight: number; 
  maxVolume: number;
  supportsFragile: boolean;

  documents?: IVehicleDocuments;

  currentBranchId?: mongoose.Types.ObjectId;
  assignedUserId?: mongoose.Types.ObjectId;
  assignedUserRole?: AssignedUserRole;

  status: VehicleStatus;
  notes?: string;
  
  isAvailable: boolean;
  isAssigned: boolean;
  isHeavy: boolean;
  isLight: boolean;
  documentStatus: 'valid' | 'expiring_soon' | 'expired' | 'missing';
  canTransportFragile: boolean;
}


const vehicleDocumentsSchema = new Schema<IVehicleDocuments>({
  registrationCard: {
    type: String,
    trim: true,
  },
  insurance: {
    type: String,
    trim: true,
  },
  insuranceExpiry: {
    type: Date,
  },
  technicalInspection: {
    type: String,
    trim: true,
  },
  inspectionExpiry: {
    type: Date,
  },
}, { _id: false });


const vehicleSchema = new Schema<IVehicle>({

  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
    index: true,
  },
  
  type: {
    type: String,
    enum: {
      values: ['motorcycle', 'car', 'van', 'small_truck', 'large_truck'],
      message: 'Vehicle type must be one of: motorcycle, car, van, small_truck, large_truck',
    },
    required: [true, 'Vehicle type is required'],
  },

  registrationNumber: {
    type: String,
    required: [true, 'Registration number is required'],
    unique: true,
    uppercase: true,
    trim: true,
    match: [/^[A-Z0-9\s\-]{5,20}$/, 'Please enter a valid registration number'],
  },

  brand: {
    type: String,
    trim: true,
    maxlength: [50, 'Brand cannot exceed 50 characters'],
  },

  modelName: {
    type: String,
    trim: true,
    maxlength: [50, 'Model name cannot exceed 50 characters'],
  },

  year: {
    type: Number,
    min: [1900, 'Year must be after 1900'],
    max: [new Date().getFullYear() + 1, 'Year cannot be in the future'],
  },

  color: {
    type: String,
    trim: true,
  },
  
  maxWeight: {
    type: Number,
    required: [true, 'Maximum weight capacity is required'],
    min: [1, 'Maximum weight must be at least 1kg'],
    max: [50000, 'Maximum weight cannot exceed 50.000kg'],
  },

  maxVolume: {
    type: Number,
    required: [true, 'Maximum volume capacity is required'],
    min: [0.1, 'Maximum volume must be at least 0.1 cubic meters'],
    max: [100, 'Maximum volume cannot exceed 100 cubic meters'],
  },
  
  supportsFragile: {
    type: Boolean,
    default: true,
  },
  
  documents: {
    type: vehicleDocumentsSchema,
    required: false,
  },
  
  currentBranchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
  },

  assignedUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  assignedUserRole: {
    type: String,
    enum: {
      values: ['transporter', 'deliverer', 'driver'],
      message: 'Assigned user role must be one of: transporter, deliverer, driver',
    },
  },
  

  status: {
    type: String,
    enum: {
      values: ['available', 'in_use', 'maintenance', 'out_of_service', 'retired'],
      message: 'Status must be one of: available, in_use, maintenance, out_of_service, retired',
    },
    default: 'available',
    index: true,
  },
  

  notes: {
    type: String,
    trim: true,
    maxlength: [500, 'Notes cannot exceed 500 characters'],
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});


vehicleSchema.virtual('isAvailable').get(function() {
  return this.status === 'available' && this.documentStatus === 'valid';
});

vehicleSchema.virtual('isAssigned').get(function() {
  return !!this.assignedUserId && !!this.currentBranchId;
});

vehicleSchema.virtual('isHeavy').get(function() {
  return this.type === 'large_truck' || this.type === 'small_truck';
});

vehicleSchema.virtual('isLight').get(function() {
  return this.type === 'motorcycle' || this.type === 'car';
});

vehicleSchema.virtual('canTransportFragile').get(function() {
  return this.supportsFragile && this.type !== 'motorcycle'; 
});

vehicleSchema.virtual('documentStatus').get(function() {
  if (!this.documents) return 'missing';
  
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  if (this.documents.insuranceExpiry) {
    if (this.documents.insuranceExpiry < now) return 'expired';
    if (this.documents.insuranceExpiry < thirtyDaysFromNow) return 'expiring_soon';
  }
  
  if (this.documents.inspectionExpiry) {
    if (this.documents.inspectionExpiry < now) return 'expired';
    if (this.documents.inspectionExpiry < thirtyDaysFromNow) return 'expiring_soon';
  }
  if (!this.documents.registrationCard || !this.documents.insurance || !this.documents.technicalInspection) {
    return 'missing';
  }
  return 'valid';
});

vehicleSchema.virtual('displayName').get(function() {
  const parts = [];
  if (this.brand) parts.push(this.brand);
  if (this.modelName) parts.push(this.modelName);
  if (this.year) parts.push(this.year.toString());
  parts.push(`(${this.registrationNumber})`);
  return parts.join(' ');
});

vehicleSchema.virtual('category').get(function() {
  const categories = {
    motorcycle: 'Light',
    car: 'Light',
    van: 'Medium',
    small_truck: 'Heavy',
    large_truck: 'Heavy',
  };
  return categories[this.type] || 'Unknown';
});


vehicleSchema.index({ companyId: 1, status: 1 });
vehicleSchema.index({ currentBranchId: 1, status: 1 });
vehicleSchema.index({ assignedUserId: 1 });
vehicleSchema.index({ currentBranchId : 1 });
vehicleSchema.index({ type: 1 });



vehicleSchema.pre('save', function(next) {
  
  if (this.isModified('status') && this.status === 'in_use' && !this.assignedUserId) {
    return next(new Error('Vehicle must be assigned to a user to be marked as in_use'));
  }
  
  if (this.type === 'motorcycle' && this.maxWeight > 50) {
    console.warn('Motorcycle max weight seems high for vehicle type');
  }
  
  if (this.type === 'large_truck' && this.maxWeight < 1000) {
    console.warn('Large truck max weight seems low for vehicle type');
  }
  
  next();
});

vehicleSchema.methods.assign = function(
  userId: mongoose.Types.ObjectId, 
  branchId: mongoose.Types.ObjectId,
  role: AssignedUserRole = 'driver'
) {
  if (this.status !== 'available') {
    throw new Error(`Vehicle cannot be assigned. Current status: ${this.status}`);
  }
  
  if (this.documentStatus !== 'valid') {
    throw new Error('Vehicle documents are not valid for assignment');
  }
  
  this.assignedUserId = userId;
  this.currentBranchId = branchId;
  this.assignedUserRole = role;
  this.status = 'in_use';
  
  return this.save();
};

vehicleSchema.methods.release = function() {
  this.assignedUserId = undefined;
  this.assignedUserRole = undefined;
  this.status = 'available';
  
  return this.save();
};


vehicleSchema.methods.moveToBranch = function(branchId: mongoose.Types.ObjectId) {
  this.currentBranchId = branchId;
  return this.save();
};

vehicleSchema.methods.updateDocument = function(
  type: keyof IVehicleDocuments, 
  url: string, 
  expiryDate?: Date
) {
  if (!this.documents) {
    this.documents = {};
  }
  
  this.documents[type] = url;
  
  if (type === 'insurance' && expiryDate) {
    this.documents.insuranceExpiry = expiryDate;
  }
  
  if (type === 'technicalInspection' && expiryDate) {
    this.documents.inspectionExpiry = expiryDate;
  }
  
  return this.save();
};

const VehicleModel: Model<IVehicle> = mongoose.models.Vehicle || 
  mongoose.model<IVehicle>('Vehicle', vehicleSchema);

export default VehicleModel;