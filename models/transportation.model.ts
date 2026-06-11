import mongoose, { Document, Model, Schema } from "mongoose";

export type TransportationStatus =
  | 'pending'
  | 'in_transit'
  | 'arrived'
  | 'completed'
  | 'cancelled';

/**
 * A "trip" of one or more sealed manifests being moved from a source
 * location to a destination location by a transporter.
 *
 * This is intentionally lean: it stores rollup totals (weight, volume,
 * package/manifest counts) computed at creation time from the referenced
 * manifests, plus the actual vs. estimated delivery times needed by the
 * transporter mobile app. It does not duplicate per-manifest or
 * per-package detail — those are fetched via `manifestIds` when needed.
 */
export interface ITransportation extends Document {
  transportationCode: string;
  companyId: mongoose.Types.ObjectId;
  sourceRouteId: mongoose.Types.ObjectId;

  source: {
    branchId?: mongoose.Types.ObjectId;
    name?: string;
    location: {
      type: 'Point';
      coordinates: [number, number];
    };
  };

  destination: {
    branchId?: mongoose.Types.ObjectId;
    name?: string;
    location: {
      type: 'Point';
      coordinates: [number, number];
    };
  };

  manifestIds: mongoose.Types.ObjectId[];

  manifestCount: number;
  packageCount: number;
  totalWeight: number;
  totalVolume: number;

  assignedTransporterId?: mongoose.Types.ObjectId;
  assignedVehicleId?: mongoose.Types.ObjectId;

  status: TransportationStatus;

  estimatedDeliveryTime?: Date;
  actualDeliveryTime?: Date;

  departedAt?: Date;

  notes?: string;

  createdAt: Date;
  updatedAt: Date;

  // virtuals
  isInTransit: boolean;
  isCompleted: boolean;
  isOverdue: boolean;
  durationMinutes?: number;

  // methods
  markDeparted: () => Promise<ITransportation>;
  markArrived: () => Promise<ITransportation>;
  markCompleted: (actualDeliveryTime?: Date) => Promise<ITransportation>;
  cancel: (reason?: string) => Promise<ITransportation>;
}

// ── Sub-schema: source / destination point ────────────────────────────────

const transportPointSchema = new Schema({
  branchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
  },
  name: {
    type: String,
    trim: true,
  },
  location: {
    type: new Schema({
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
          validator: function (v: number[]) {
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
    }, { _id: false }),
    required: true,
  },
}, { _id: false });

// ── Main schema ─────────────────────────────────────────────────────────────

const transportationSchema = new Schema<ITransportation>({

  transportationCode: {
    type: String,
    unique: true,
    index: true,
  },

  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'companyId is required'],
    index: true,
  },

  sourceRouteId: {  
    type: Schema.Types.ObjectId,
    ref: 'Route',
    required: [true, 'Source route reference is required'],
    // index: true,
  },

  source: {
    type: transportPointSchema,
    required: [true, 'Source location is required'],
  },

  destination: {
    type: transportPointSchema,
    required: [true, 'Destination location is required'],
  },

  manifestIds: {
    type: [Schema.Types.ObjectId],
    ref: 'Manifest',
    default: [],
  },

  manifestCount: {
    type: Number,
    default: 0,
    min: 0,
  },

  packageCount: {
    type: Number,
    default: 0,
    min: 0,
  },

  totalWeight: {
    type: Number,
    default: 0,
    min: 0,
  },

  totalVolume: {
    type: Number,
    default: 0,
    min: 0,
  },

  assignedTransporterId: {
    type: Schema.Types.ObjectId,
    ref: 'Transporter',
    index: true,
  },

  assignedVehicleId: {
    type: Schema.Types.ObjectId,
    ref: 'Vehicle',
  },

  status: {
    type: String,
    enum: ['pending', 'in_transit', 'arrived', 'completed', 'cancelled'],
    default: 'pending',
    index: true,
  },

  estimatedDeliveryTime: {
    type: Date,
  },

  actualDeliveryTime: {
    type: Date,
  },

  departedAt: {
    type: Date,
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

// ── Virtuals ──────────────────────────────────────────────────────────────────

transportationSchema.virtual('isInTransit').get(function () {
  return this.status === 'in_transit';
});

transportationSchema.virtual('isCompleted').get(function () {
  return this.status === 'completed';
});

transportationSchema.virtual('isOverdue').get(function () {
  if (!this.estimatedDeliveryTime || this.isCompleted) return false;
  return this.estimatedDeliveryTime < new Date();
});

transportationSchema.virtual('durationMinutes').get(function () {
  if (!this.departedAt || !this.actualDeliveryTime) return undefined;
  return Math.round(
    (this.actualDeliveryTime.getTime() - this.departedAt.getTime()) / 60_000
  );
});

// ── Methods ───────────────────────────────────────────────────────────────────

transportationSchema.methods.markDeparted = function () {
  this.status = 'in_transit';
  this.departedAt = new Date();
  return this.save();
};

transportationSchema.methods.markArrived = function () {
  this.status = 'arrived';
  return this.save();
};

transportationSchema.methods.markCompleted = function (actualDeliveryTime?: Date) {
  this.status = 'completed';
  this.actualDeliveryTime = actualDeliveryTime || new Date();
  return this.save();
};

transportationSchema.methods.cancel = function (reason?: string) {
  this.status = 'cancelled';
  if (reason) {
    this.notes = this.notes ? `${this.notes}\nCancelled: ${reason}` : `Cancelled: ${reason}`;
  }
  return this.save();
};

// ── Pre-save: generate transportationCode ──────────────────────────────────────

transportationSchema.pre('save', function (next) {
  if (this.isNew && !this.transportationCode) {
    const prefix = 'TRP';
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(1000 + Math.random() * 9000);
    this.transportationCode = `${prefix}${timestamp}${random}`;
  }
  next();
});



transportationSchema.index({ companyId: 1, status: 1 });
transportationSchema.index({ assignedTransporterId: 1, status: 1 });
transportationSchema.index({ 'source.location': '2dsphere' });
transportationSchema.index({ 'destination.location': '2dsphere' });
transportationSchema.index({ manifestIds: 1 });
transportationSchema.index({ createdAt: -1 });
transportationSchema.index({ sourceRouteId: 1 });

const TransportationModel: Model<ITransportation> = mongoose.model<ITransportation>('Transportation', transportationSchema);

export default TransportationModel;