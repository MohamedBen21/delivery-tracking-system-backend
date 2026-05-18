import mongoose, { Document, Model, Schema } from "mongoose";

export interface IStopQrSession extends Document {

  routeId: mongoose.Types.ObjectId;
  stopIndex: number;
  stopId: mongoose.Types.ObjectId;
  transporterId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  manifestCount: number;
  packageCount: number;
  isLastStop: boolean;
  code: string;
  expiresAt: Date;
  verified: boolean;
  verifiedAt?: Date;
  verifiedBy?: mongoose.Types.ObjectId;
  createdAt: Date;

}

const stopQrSessionSchema = new Schema<IStopQrSession>(
  {
    routeId: { 
     type: Schema.Types.ObjectId, 
     ref: "Route", required: true, 
     index: true 
    },

    stopIndex: { 
     type: Number, 
     required: true 
    },

    stopId: {
     type: Schema.Types.ObjectId, 
     required: true 
    },

    transporterId: {
     type: Schema.Types.ObjectId, 
     ref: "Transporter", 
     required: true 
    },

    branchId: {
     type: Schema.Types.ObjectId, 
     ref: "Branch", 
     required: true 
    },

    manifestCount: {
     type: Number, 
     default: 0 
    },

    packageCount: {
     type: Number, 
     default: 0 
    },

    isLastStop: {
     type: Boolean, 
     default: false 
    },

    code: {
     type: String, 
     required: true, 
     unique: true, 
     index: true 
    },

    expiresAt: {
     type: Date, 
     required: true,

    },

    verified: {
     type: Boolean, 
     default: false 
    },

    verifiedAt: { type: Date },
    verifiedBy: {
     type: Schema.Types.ObjectId, 
     ref: "User" 
    },

  },
  { timestamps: true }
);

stopQrSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

const StopQrSessionModel = mongoose.model<IStopQrSession>("StopQrSession", stopQrSessionSchema);
export default StopQrSessionModel;