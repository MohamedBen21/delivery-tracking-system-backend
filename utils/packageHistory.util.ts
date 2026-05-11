import mongoose from 'mongoose';
import PackageHistoryModel from '../models/package-history.model';
import { PackageStatus } from '../models/package.model';

export async function writeHistory(
  entries: {
    packageId: mongoose.Types.ObjectId;
    status: PackageStatus;
    handledBy: mongoose.Types.ObjectId;
    handlerRole: "transporter" | "deliverer";
    branchId?: mongoose.Types.ObjectId;
    manifestId?: mongoose.Types.ObjectId;
    notes?: string;
  }[],
  session?: mongoose.ClientSession,
): Promise<void> {
  if (!entries || entries.length === 0) return;
  
  const now = new Date();
  await PackageHistoryModel.insertMany(
    entries.map((e) => ({
      packageId: e.packageId,
      status: e.status,
      handledBy: e.handledBy,
      handlerRole: e.handlerRole,
      branchId: e.branchId,
      manifestId: e.manifestId,
      notes: e.notes || '',
      timestamp: now,
    })),
    { session },
  );
}