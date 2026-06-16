import mongoose, { Document, Model, Schema } from "mongoose";

export interface IStopQrSession extends Document {
  routeId:       mongoose.Types.ObjectId;
  stopIndex:     number;
  stopId:        mongoose.Types.ObjectId;
  transporterId: mongoose.Types.ObjectId;
  branchId?:     mongoose.Types.ObjectId;

  manifestCount: number;
  packageCount:  number;
  isLastStop:    boolean;

  code:      string;
  expiresAt: Date;

  verified:   boolean;
  verifiedBy?: mongoose.Types.ObjectId;   
  verifiedAt?: Date;

  createdAt: Date;
  updatedAt: Date;

  // Virtuals
  isValid: boolean;
  isExpired: boolean;
  minutesRemaining: number;
}

const stopQrSessionSchema = new Schema<IStopQrSession>(
  {
    routeId: {
      type: Schema.Types.ObjectId,
      ref: "Route",
      required: [true, "Route reference is required"],
      index: true,
    },
    stopIndex: {
      type: Number,
      required: [true, "Stop index is required"],
      min: -1, // -1 is used for start-route QR sessions
    },
    stopId: {
      type: Schema.Types.ObjectId,
      required: [true, "Stop ID is required"],
    },
    transporterId: {
      type: Schema.Types.ObjectId,
      ref: "Transporter",
      required: [true, "Transporter reference is required"],
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
    },

    manifestCount: { type: Number, default: 0, min: 0 },
    packageCount:  { type: Number, default: 0, min: 0 },
    isLastStop:    { type: Boolean, default: false },

    code: {
      type: String,
      required: [true, "QR code is required"],
    },
    expiresAt: {
      type: Date,
      required: [true, "Expiry is required"],
    },

    verified:   { type: Boolean, default: false, index: true },
    verifiedAt: { type: Date },
    verifiedBy: {                          
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  },
);



stopQrSessionSchema.virtual("isValid").get(function () {
  return !this.verified && this.expiresAt > new Date();
});

stopQrSessionSchema.virtual("isExpired").get(function () {
  return this.expiresAt <= new Date();
});

stopQrSessionSchema.virtual("minutesRemaining").get(function () {
  if (this.verified || this.expiresAt <= new Date()) return 0;
  return Math.max(
    0,
    Math.round((this.expiresAt.getTime() - Date.now()) / 60_000),
  );
});



stopQrSessionSchema.index({ routeId: 1, stopIndex: 1, verified: 1 });
stopQrSessionSchema.index({ routeId: 1, stopIndex: 1, transporterId: 1, verified: 1 });
stopQrSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 86400 },
);

const StopQrSessionModel: Model<IStopQrSession> =
  mongoose.models.StopQrSession ||
  mongoose.model<IStopQrSession>("StopQrSession", stopQrSessionSchema);

export default StopQrSessionModel;