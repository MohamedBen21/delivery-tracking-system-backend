import crypto from "crypto";
import mongoose from "mongoose";
import DelivererModel from "../models/deliverer.model";
import { CashReturnSessionModel } from "../models/cashReturnSession.model";


const CASH_RETURN_QR_EXPIRY_MINUTES = 30;


export async function generateCashReturnQr(
  delivererId: string,
  branchId: string,
  requestedBy: string,
): Promise<{
  code: string;
  qrUrl: string;
  session: {
    sessionId: string;
    delivererId: string;
    branchId: string;
    amount: number;
    todayDeliveries: number;
    todayEarnings: number;
    todayCollected: number;
    expiresAt: Date;
  };
}> {
    
  const deliverer = await DelivererModel.findById(delivererId).lean();
  if (!deliverer) {
    throw new Error("Deliverer not found.");
  }

  if (deliverer.branchId.toString() !== branchId) {
    throw new Error("Deliverer does not belong to this branch.");
  }

  if (deliverer.pendingBranchReturn <= 0) {
    throw new Error("No cash to return. Deliverer has no pending balance.");
  }


  await CashReturnSessionModel.updateMany(
    { delivererId: deliverer._id, verified: false },
    { $set: { verified: true, verifiedAt: new Date() } }
  );

  const code = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + CASH_RETURN_QR_EXPIRY_MINUTES * 60 * 1000);

  const session = await CashReturnSessionModel.create({
    delivererId: deliverer._id,
    branchId: new mongoose.Types.ObjectId(branchId),
    amount: deliverer.pendingBranchReturn,
    todayDeliveries: deliverer.todayDeliveriesCount,
    todayEarnings: deliverer.todayEarnings,
    todayCollected: deliverer.todayCollectedAmount,
    code,
    expiresAt,
    verified: false,
  });

  const qrUrl = `${process.env.CLIENT_APP_URL}/cash-return/qr/${code}`;

  return {
    code,
    qrUrl,
    session: {
      sessionId: session._id.toString(),
      delivererId: session.delivererId.toString(),
      branchId: session.branchId.toString(),
      amount: session.amount,
      todayDeliveries: session.todayDeliveries,
      todayEarnings: session.todayEarnings,
      todayCollected: session.todayCollected,
      expiresAt: session.expiresAt,
    },
  };
}


export async function verifyAndProcessCashReturn(
  code: string,
  delivererUserId: string,
): Promise<{
  amountReturned: number;
  todayEarnings: number;
  todayDeliveries: number;
  todayCollected: number;
}> {
  const session = await CashReturnSessionModel.findOne({ code });

  if (!session) {
    throw new Error("Invalid QR code. Cash return session not found.");
  }

  if (session.verified) {
    throw new Error("This QR code has already been used.");
  }

  if (new Date() > session.expiresAt) {
    throw new Error("QR code has expired. Please request a new one from your branch supervisor.");
  }

 
  const deliverer = await DelivererModel.findById(session.delivererId);
  if (!deliverer) {
    throw new Error("Deliverer not found.");
  }

  if (deliverer.userId.toString() !== delivererUserId) {
    throw new Error("This QR code is for a different deliverer.");
  }


  const summary = await deliverer.returnCashToBranch();


  session.verified = true;
  session.verifiedAt = new Date();
  await session.save();

  return summary;
}


export async function getCashReturnInfo(code: string) {
  const session = await CashReturnSessionModel.findOne({ code })
    .populate("delivererId", "userId")
    .lean();

  if (!session) return null;

  return session;
}