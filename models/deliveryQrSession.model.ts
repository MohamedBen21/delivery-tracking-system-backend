// models/deliveryQrSession.model.ts
import mongoose from "mongoose";

export interface IDeliveryQrSession {
  packageId: mongoose.Types.ObjectId;
  routeId: mongoose.Types.ObjectId;
  stopIndex: number;
  delivererId: mongoose.Types.ObjectId;
  code: string;
  expiresAt: Date;
  verified: boolean;
  verifiedAt?: Date;
  qrImageUrl?: string;
}

const deliveryQrSessionSchema = new mongoose.Schema({
  packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', required: true },
  routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', required: true },
  stopIndex: { type: Number, required: true },
  delivererId: { type: mongoose.Schema.Types.ObjectId, ref: 'Deliverer', required: true },
  code: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date },
  qrImageUrl: { type: String },
}, { timestamps: true });


deliveryQrSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });


const DeliveryQrSession = mongoose.model<IDeliveryQrSession>('DeliveryQrSession', deliveryQrSessionSchema);

export default DeliveryQrSession;