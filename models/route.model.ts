
import mongoose, { Document, Model, Schema } from "mongoose";

export type RouteType = 'inter_branch' | 'local_delivery' | 'pickup_route' | 'return_route';

export type RouteStatus = 'planned' | 'assigned' | 'active' | 'paused' | 'completed' | 'cancelled';

export type StopStatus = 'pending' | 'arrived' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export type StopAction = 'pickup' | 'delivery' | 'transfer' | 'service';

export interface IRouteStop {
  _id?: mongoose.Types.ObjectId;
  packageIds: mongoose.Types.ObjectId[];
  order: number;
  action: StopAction;
  location: {
    type: 'Point';
    coordinates: [number, number];
  };
  address?: string;
  branchId?: mongoose.Types.ObjectId; 
  clientId?: mongoose.Types.ObjectId; 

  expectedArrival?: Date;
  actualArrival?: Date;
  expectedDeparture?: Date;
  actualDeparture?: Date;
  status: StopStatus;

  notes?: string;
  contactPerson?: string;
  contactPhone?: string;
  stopDuration: number;
  
  completedPackages: mongoose.Types.ObjectId[];
  failedPackages: mongoose.Types.ObjectId[];
  skippedPackages: mongoose.Types.ObjectId[];
  issues?: string[];
}

export interface IOptimizedPath {
  lat: number;
  lng: number;
  order: number;
  stopId?: mongoose.Types.ObjectId;
  estimatedArrival?: Date;
  segmentDistance?: number;
  segmentTime?: number;
  isStop: boolean;
}


export interface IRoute extends Document {
  routeNumber: string;
  companyId: mongoose.Types.ObjectId;
  
  name: string;
  type: RouteType;
  
  originBranchId?: mongoose.Types.ObjectId;
  destinationBranchId?: mongoose.Types.ObjectId;
  
  assignedVehicleId?: mongoose.Types.ObjectId;
  assignedTransporterId?: mongoose.Types.ObjectId;
  assignedDelivererId?: mongoose.Types.ObjectId;

  stops: IRouteStop[];

  optimizedPath: IOptimizedPath[];

  distance: number;
  estimatedTime: number;
  actualTime?: number; 
  fuelEstimate?: number;
  costEstimate?: number;

  status: RouteStatus;
  currentStopIndex: number; 

  completedStops: number;
  failedStops: number;
  skippedStops: number;
  onTimePerformance: number;
  
  createdAt: Date;
  scheduledStart: Date;
  actualStart?: Date;
  scheduledEnd: Date;
  actualEnd?: Date;
  pausedAt?: Date;
  resumedAt?: Date;
  updatedAt: Date;
  
  cancellationReason?: string;
  completionNotes?: string;
  
  isActive: boolean;
  isCompleted: boolean;
  isDelayed: boolean;
  progressPercentage: number;
  estimatedTimeRemaining?: number;
  currentStop?: IRouteStop;
  nextStop?: IRouteStop;
  remainingStops: IRouteStop[];
  totalPackages: number;
  completedPackages: number;
}

const routeStopSchema = new Schema<IRouteStop>({

  packageIds: {
    type: [Schema.Types.ObjectId],
    ref: 'Package',
    default: [],
  },

  order: {
    type: Number,
    required: [true, 'Stop order is required'],
    min: 1,
  },
  action: {
    type: String,
    enum: ['pickup', 'delivery', 'transfer', 'service'],
    required: [true, 'Stop action is required'],
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
  },
  address: {
    type: String,
    trim: true,
  },
  branchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
  },
  clientId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  expectedArrival: {
    type: Date,
  },
  actualArrival: {
    type: Date,
  },
  expectedDeparture: {
    type: Date,
  },
  actualDeparture: {
    type: Date,
  },
  status: {
    type: String,
    enum: ['pending', 'arrived', 'in_progress', 'completed', 'failed', 'skipped'],
    default: 'pending',
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [500, 'Notes cannot exceed 500 characters'],
  },
  contactPerson: {
    type: String,
    trim: true,
  },
  contactPhone: {
    type: String,
    trim: true,
  },
  stopDuration: {
    type: Number,
    default: 15,
    min: 1,
    max: 240,
  },
  completedPackages: {
    type: [Schema.Types.ObjectId],
    ref: 'Package',
    default: [],
  },

  failedPackages: {
    type: [Schema.Types.ObjectId],
    ref: 'Package',
    default: [],
  },

  skippedPackages: {
    type: [Schema.Types.ObjectId],
    ref: 'Package',
    default: [],
  },
  issues: {
    type: [String],
    default: [],
  },
}, { _id: true });

const optimizedPathSchema = new Schema<IOptimizedPath>({
  lat: {
    type: Number,
    required: true,
  },
  lng: {
    type: Number,
    required: true,
  },
  order: {
    type: Number,
    required: true,
    min: 1,
  },
  stopId: {
    type: Schema.Types.ObjectId,
  },
  estimatedArrival: {
    type: Date,
  },
  segmentDistance: {
    type: Number,
    min: 0,
  },
  segmentTime: {
    type: Number,
    min: 0,
  },
  isStop: {
    type: Boolean,
    default: false,
  },
}, { _id: false });


const routeSchema = new Schema<IRoute>({
  routeNumber: {
    type: String,
    unique: true,
    uppercase: true,
    trim: true,
    match: [/^R-\d{8}-\d{3,4}$/, 'Route number must be in format: R-YYYYMMDD-001'],
  },
  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
  },
  name: {
    type: String,
    trim: true,
    maxlength: [100, 'Route name cannot exceed 100 characters'],
  },
  type: {
    type: String,
    enum: ['inter_branch', 'local_delivery', 'pickup_route', 'return_route'],
    required: [true, 'Route type is required'],
  },

  originBranchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',

  },
  destinationBranchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',

  },
  assignedVehicleId: {
    type: Schema.Types.ObjectId,
    ref: 'Vehicle',
  },
  assignedTransporterId: {
    type: Schema.Types.ObjectId,
    ref: 'Transporter',
  },
  assignedDelivererId: {
    type: Schema.Types.ObjectId,
    ref: 'Deliverer',
  },
  stops: {
    type: [routeStopSchema],
    default: [],
    validate: {
      validator: function(stops: IRouteStop[]) {
        const orders = stops.map(s => s.order);
        return new Set(orders).size === orders.length;
      },
      message: 'Stop orders must be unique',
    },
  },
  optimizedPath: {
    type: [optimizedPathSchema],
    default: [],
  },
  distance: {
    type: Number,
    required: [true, 'Distance is required'],
    min: [0.1, 'Distance must be at least 0.1km'],
    max: [1000, 'Distance cannot exceed 1000km'],
  },
  estimatedTime: {
    type: Number,
    required: [true, 'Estimated time is required'],
    min: [1, 'Estimated time must be at least 1 minute'],
    max: [1440, 'Estimated time cannot exceed 24 hours'],
  },
  actualTime: {
    type: Number,
    min: 0,
  },
  fuelEstimate: {
    type: Number,
    min: 0,
  },
  costEstimate: {
    type: Number,
    min: 0,
  },
  status: {
    type: String,
    enum: ['planned', 'assigned', 'active', 'paused', 'completed', 'cancelled'],
    default: 'planned',
    index: true,
  },
  currentStopIndex: {
    type: Number,
    default: 0,
    min: 0,
  },
  completedStops: {
    type: Number,
    default: 0,
    min: 0,
  },
  failedStops: {
    type: Number,
    default: 0,
    min: 0,
  },
  skippedStops: {
    type: Number,
    default: 0,
    min: 0,
  },
  onTimePerformance: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  scheduledStart: {
    type: Date,
    required: [true, 'Scheduled start time is required'],
    index: true,
  },
  actualStart: {
    type: Date,
    index: true,
  },
  scheduledEnd: {
    type: Date,
    required: [true, 'Scheduled end time is required'],
  },
  actualEnd: {
    type: Date,
  },
  pausedAt: {
    type: Date,
  },
  resumedAt: {
    type: Date,
  },
  cancellationReason: {
    type: String,
    trim: true,
    maxlength: [500, 'Cancellation reason cannot exceed 500 characters'],
  },
  completionNotes: {
    type: String,
    trim: true,
    maxlength: [1000, 'Completion notes cannot exceed 1000 characters'],
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});



routeSchema.virtual('isActive').get(function() {
  return this.status === 'active' || this.status === 'paused';
});

routeSchema.virtual('isCompleted').get(function() {
  return this.status === 'completed';
});

routeSchema.virtual('isDelayed').get(function() {
  if (!this.scheduledEnd || this.isCompleted) return false;
  const now = new Date();
  return now > this.scheduledEnd;
});

routeSchema.virtual('progressPercentage').get(function() {
  if (this.stops.length === 0) return 0;
  return Math.round((this.currentStopIndex / this.stops.length) * 100);
});

routeSchema.virtual('estimatedTimeRemaining').get(function() {
  if (this.isCompleted || !this.actualStart) return 0;
  
  const now = new Date();
  const elapsedMinutes = (now.getTime() - this.actualStart.getTime()) / (1000 * 60);
  return Math.max(0, this.estimatedTime - elapsedMinutes);
});

routeSchema.virtual('currentStop').get(function() {
  if (this.currentStopIndex >= 0 && this.currentStopIndex < this.stops.length) {
    return this.stops[this.currentStopIndex];
  }
  return undefined;
});

routeSchema.virtual('nextStop').get(function() {
  if (this.currentStopIndex + 1 < this.stops.length) {
    return this.stops[this.currentStopIndex + 1];
  }
  return undefined;
});

routeSchema.virtual('remainingStops').get(function() {
  return this.stops.slice(this.currentStopIndex);
});

routeSchema.virtual('totalPackages').get(function() {
  return this.stops.reduce((total, stop) => total + stop.packageIds.length, 0);
});

routeSchema.virtual('completedPackages').get(function() {
  return this.stops.reduce((total, stop) => total + stop.completedPackages.length, 0);
});


routeSchema.virtual('efficiencyScore').get(function() {
  if (this.stops.length === 0) return 0;
  const stopCompletionRate = (this.completedStops / this.stops.length) * 100;
  const packageCompletionRate = this.totalPackages > 0 ? 
    (this.completedPackages / this.totalPackages) * 100 : 100;
  const timeEfficiency = this.actualTime && this.estimatedTime ? 
    Math.max(0, 100 - ((this.actualTime - this.estimatedTime) / this.estimatedTime) * 100) : 100;
  
  return Math.round((stopCompletionRate + packageCompletionRate + timeEfficiency) / 3);
});



routeSchema.methods.startRoute = function(startedBy?: mongoose.Types.ObjectId) {
  this.status = 'active';
  this.actualStart = new Date();
  this.currentStopIndex = 0;
  
  if (this.stops.length > 0) {
    this.stops[0].expectedArrival = new Date();
    this.stops[0].status = 'pending';
  }
  
  return this.save();
};


routeSchema.methods.pauseRoute = function(reason?: string) {
  if (this.status !== 'active') {
    throw new Error(`Cannot pause route. Current status: ${this.status}`);
  }
  
  this.status = 'paused';
  this.pausedAt = new Date();
  
  return this.save();
};

routeSchema.methods.resumeRoute = function() {
  if (this.status !== 'paused') {
    throw new Error(`Cannot resume route. Current status: ${this.status}`);
  }
  
  this.status = 'active';
  this.resumedAt = new Date();
  
  return this.save();
};

routeSchema.methods.completeStop = function(
  stopIndex: number,
  completedPackages?: mongoose.Types.ObjectId[],
  failedPackages?: mongoose.Types.ObjectId[],
  notes?: string
) {
  if (stopIndex < 0 || stopIndex >= this.stops.length) {
    throw new Error('Invalid stop index');
  }
  
  const stop = this.stops[stopIndex];
  stop.status = 'completed';
  stop.actualDeparture = new Date();
  stop.notes = notes;
  
  if (completedPackages) {
    stop.completedPackages = [...new Set([...stop.completedPackages, ...completedPackages])];
  }
  
  if (failedPackages) {
    stop.failedPackages = [...new Set([...stop.failedPackages, ...failedPackages])];
  }
  
  this.completedStops += 1;
  this.currentStopIndex = stopIndex + 1;
  
  if (this.currentStopIndex < this.stops.length) {
    const nextStop = this.stops[this.currentStopIndex];
    nextStop.expectedArrival = new Date();
    nextStop.status = 'pending';
  }
  
  return this.save();
};


routeSchema.methods.failStop = function(
  stopIndex: number,
  reason: string,
  skippedPackages?: mongoose.Types.ObjectId[]
) {
  if (stopIndex < 0 || stopIndex >= this.stops.length) {
    throw new Error('Invalid stop index');
  }
  
  const stop = this.stops[stopIndex];
  stop.status = 'failed';
  stop.issues = [...(stop.issues || []), reason];
  
  if (skippedPackages) {
    stop.skippedPackages = [...new Set([...stop.skippedPackages, ...skippedPackages])];
  }
  
  this.failedStops += 1;
  this.currentStopIndex = stopIndex + 1;
  
  return this.save();
};


routeSchema.methods.skipStop = function(stopIndex: number, reason: string) {
  if (stopIndex < 0 || stopIndex >= this.stops.length) {
    throw new Error('Invalid stop index');
  }
  
  const stop = this.stops[stopIndex];
  stop.status = 'skipped';
  stop.issues = [...(stop.issues || []), reason];
  
  this.skippedStops += 1;
  this.currentStopIndex = stopIndex + 1;
  
  return this.save();
};


routeSchema.methods.completeRoute = function(notes?: string) {
  this.status = 'completed';
  this.actualEnd = new Date();
  this.completionNotes = notes;
  
  if (this.actualStart) {
    this.actualTime = (this.actualEnd.getTime() - this.actualStart.getTime()) / (1000 * 60);
  }
  

  const totalStops = this.stops.length;
  const completedOnTime = this.stops.filter((stop: IRouteStop) => {
    if (!stop.expectedArrival || !stop.actualArrival) return false;
    const delay = stop.actualArrival.getTime() - stop.expectedArrival.getTime();
    return delay <= 15 * 60 * 1000;
  }).length;
  
  this.onTimePerformance = totalStops > 0 ? (completedOnTime / totalStops) * 100 : 100;
  
  return this.save();
};

routeSchema.methods.cancelRoute = function(reason: string) {
  this.status = 'cancelled';
  this.cancellationReason = reason;
  return this.save();
};


routeSchema.methods.addStop = function(stopData: Partial<IRouteStop>) {
  const newStop = {
    ...stopData,
    _id: new mongoose.Types.ObjectId(),
    order: this.stops.length + 1,
    status: 'pending' as StopStatus,
    packageIds: stopData.packageIds || [],
    completedPackages: [],
    failedPackages: [],
    skippedPackages: [],
    stopDuration: stopData.stopDuration || 15,
  };
  
  this.stops.push(newStop as IRouteStop);
  return this.save();
};


routeSchema.methods.reorderStops = function(newOrder: number[]) {
  if (newOrder.length !== this.stops.length) {
    throw new Error('New order must include all stops');
  }
  
  const stopsCopy = [...this.stops];
  const reorderedStops = newOrder.map((newIndex, arrayIndex) => {
    const stop = stopsCopy[newIndex - 1]; 
    return {
      ...stop.toObject?.(),
      order: arrayIndex + 1,
    };
  });
  
  this.stops = reorderedStops;
  return this.save();
};


const RouteModel: Model<IRoute> = mongoose.model<IRoute>('Route', routeSchema);

export default RouteModel;