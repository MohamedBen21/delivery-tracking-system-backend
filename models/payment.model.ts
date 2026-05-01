import mongoose, { Document, Model, Schema } from "mongoose";

export type PaymentType = 'cod' | 'branch_payment' | 'online' | 'wallet' | 'bank_transfer';
export type PaymentStatus = 'pending' | 'collected' | 'settled' | 'disputed' | 'refunded' | 'failed' | 'cancelled';
export type PaymentCollectionMethod = 'home_delivery' | 'branch_pickup';

export interface IPayment extends Document {
  companyId: mongoose.Types.ObjectId;
  packageId: mongoose.Types.ObjectId;
  trackingNumber: string;

  delivererId?: mongoose.Types.ObjectId;

  branchId: mongoose.Types.ObjectId;
  
  processedById?: mongoose.Types.ObjectId;
  
  clientId: mongoose.Types.ObjectId;
  
  collectionMethod: PaymentCollectionMethod;

  amount: number;
  paymentMethod: PaymentType;
  
  status: PaymentStatus;
  isSettled: boolean;
  
  collectedAt: Date;
  settlementDeadline?: Date;
  settledAt?: Date;
  
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  receiptNumber?: string;
  
  notes?: string;
  proofOfPayment?: {
    signature?: string;
    photo?: string;
    otpCode?: string;
  };
  
  createdAt: Date;
  updatedAt: Date;
  
  isOverdue: boolean;
  daysUntilDeadline: number;
  
  setSettlementDeadline(): Promise<IPayment>;
  markAsSettled(processedBy: mongoose.Types.ObjectId): Promise<IPayment>;
  markAsDisputed(reason: string, reportedBy: mongoose.Types.ObjectId): Promise<IPayment>;
  verifyPayment(verifiedBy: mongoose.Types.ObjectId): Promise<IPayment>;
  markAsRefunded(reason: string, processedBy: mongoose.Types.ObjectId): Promise<IPayment>;
}


const paymentSchema = new Schema<IPayment>({
  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
    index: true,
  },
  
  packageId: {
    type: Schema.Types.ObjectId,
    ref: 'Package',
    required: [true, 'Package reference is required'],
    index: true,
  },
  
  trackingNumber: {
    type: String,
    required: [true, 'Tracking number is required'],
    uppercase: true,
    trim: true,
  },
  
  delivererId: {
    type: Schema.Types.ObjectId,
    ref: 'Deliverer',
    index: true,
  },
  
  branchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'Branch reference is required'],
    index: true,
  },
  
  processedById: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  
  clientId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Client reference is required'],
  },
  
  collectionMethod: {
    type: String,
    enum: ['home_delivery', 'branch_pickup'],
    required: [true, 'Collection method is required'],
  },
  
  amount: {
    type: Number,
    required: [true, 'Amount is required'],
    min: [0, 'Amount cannot be negative'],
  },
  
  paymentMethod: {
    type: String,
    enum: ['cod', 'branch_payment', 'online', 'wallet', 'bank_transfer'],
    required: [true, 'Payment method is required'],
  },
  
  status: {
    type: String,
    enum: ['pending', 'collected', 'settled', 'disputed', 'refunded', 'failed','cancelled'],
    default: 'pending',
    index: true,
  },
  
  isSettled: {
    type: Boolean,
    default: false,
    index: true,
  },
  
  collectedAt: {
    type: Date,
    default: Date.now,
    required: true,
  },
  
  settlementDeadline: {
    type: Date,
  },
  
  settledAt: {
    type: Date,
  },
  
  verifiedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  
  verifiedAt: {
    type: Date,
  },
  
  receiptNumber: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
  },
  
  notes: {
    type: String,
    trim: true,
    maxlength: [500, 'Notes cannot exceed 500 characters'],
  },
  
  proofOfPayment: {
    type: {
      signature: String,
      photo: String,
      otpCode: String,
    },
    _id: false,
  },
  
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});


paymentSchema.virtual('isOverdue').get(function() {
  if (this.isSettled || !this.settlementDeadline) return false;
  return new Date() > this.settlementDeadline;
});


paymentSchema.virtual('daysUntilDeadline').get(function() {
  if (!this.settlementDeadline || this.isSettled) return 0;
  const now = new Date();
  const diffMs = this.settlementDeadline.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
});


paymentSchema.methods.setSettlementDeadline = function() {
  if (this.collectionMethod === 'home_delivery' && !this.settlementDeadline && this.status === 'collected') {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);
    this.settlementDeadline = deadline;
  }
  return this.save();
};


paymentSchema.methods.markAsSettled = function(
  processedBy: mongoose.Types.ObjectId
) {
  this.isSettled = true;
  this.status = 'settled';
  this.settledAt = new Date();
  this.verifiedBy = processedBy;
  this.verifiedAt = new Date();
  
  return this.save();
};


paymentSchema.methods.markAsDisputed = function(
  reason: string,
  reportedBy: mongoose.Types.ObjectId
) {
  this.status = 'disputed';
  this.notes = reason;
  
  return this.save();
};


paymentSchema.methods.verifyPayment = function(
  verifiedBy: mongoose.Types.ObjectId
) {
  this.verifiedBy = verifiedBy;
  this.verifiedAt = new Date();
  
  return this.save();
};


paymentSchema.methods.markAsRefunded = function(
  reason: string,
  processedBy: mongoose.Types.ObjectId
) {
  this.status = 'refunded';
  this.notes = reason;
  this.verifiedBy = processedBy;
  this.verifiedAt = new Date();
  
  return this.save();
};


paymentSchema.pre('save', function(next) {
  if (this.isNew) {
    
    if (this.collectionMethod === 'home_delivery') {
      this.settlementDeadline = undefined;
    } else {
      this.isSettled = true;
      this.status = 'settled';
      this.settledAt = new Date();
    }
    

    if (!this.receiptNumber) {
      const prefix = 'RCP';
      const timestamp = Date.now().toString().slice(-8);
      const random = Math.floor(1000 + Math.random() * 9000);
      this.receiptNumber = `${prefix}${timestamp}${random}`;
    }
  }
  

  if (this.isModified('status') && this.status === 'collected' && this.collectionMethod === 'home_delivery' && !this.settlementDeadline) {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);
    this.settlementDeadline = deadline;
  }
  

  if (this.collectionMethod === 'home_delivery' && !this.delivererId) {
    return next(new Error('Deliverer is required for home delivery payments'));
  }
  
  if (this.collectionMethod === 'branch_pickup' && !this.processedById) {
    return next(new Error('Staff member who processed the payment is required for branch pickup'));
  }
  
  next();
});


paymentSchema.index({ delivererId: 1, isSettled: 1 });
paymentSchema.index({ branchId: 1, isSettled: 1 });
paymentSchema.index({ companyId: 1, status: 1 });
paymentSchema.index({ packageId: 1 }, { unique: true });
paymentSchema.index({ collectedAt: -1 });
paymentSchema.index({ settlementDeadline: 1 }, { sparse: true });
paymentSchema.index({ receiptNumber: 1 });


paymentSchema.statics.findByDeliverer = function(
  delivererId: string,
  isSettled?: boolean
) {
  const query: any = { delivererId };
  if (isSettled !== undefined) query.isSettled = isSettled;
  return this.find(query).sort({ collectedAt: -1 });
};

paymentSchema.statics.findPendingSettlements = function(companyId?: string) {
  const query: any = {
    isSettled: false,
    collectionMethod: 'home_delivery',
    status: 'collected',
    settlementDeadline: { $ne: null },
  };
  if (companyId) query.companyId = companyId;
  return this.find(query).sort({ settlementDeadline: 1 });
};

paymentSchema.statics.findOverdueSettlements = function(companyId?: string) {
  const query: any = {
    isSettled: false,
    collectionMethod: 'home_delivery',
    settlementDeadline: { $lt: new Date(), $ne: null },
    status: 'collected',
  };
  if (companyId) query.companyId = companyId;
  return this.find(query);
};

paymentSchema.statics.getDelivererBalance = async function(
  delivererId: string
) {
  const result = await this.aggregate([
    {
      $match: {
        delivererId: new mongoose.Types.ObjectId(delivererId),
        collectionMethod: 'home_delivery',
        isSettled: false,
        status: 'collected',
      },
    },
    {
      $group: {
        _id: null,
        totalOwed: { $sum: '$amount' },
        paymentsCount: { $sum: 1 },
        oldestPayment: { $min: '$collectedAt' },
      },
    },
  ]);
  
  return result[0] || { totalOwed: 0, paymentsCount: 0, oldestPayment: null };
};

paymentSchema.statics.getBranchPaymentSummary = async function(
  branchId: string,
  startDate?: Date,
  endDate?: Date
) {
  const matchStage: any = {
    branchId: new mongoose.Types.ObjectId(branchId),
  };
  
  if (startDate || endDate) {
    matchStage.collectedAt = {};
    if (startDate) matchStage.collectedAt.$gte = startDate;
    if (endDate) matchStage.collectedAt.$lte = endDate;
  }
  
  return this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: {
          collectionMethod: '$collectionMethod',
          status: '$status',
        },
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);
};

paymentSchema.statics.findByPackage = function(packageId: string) {
  return this.findOne({ packageId });
};

const PaymentModel: Model<IPayment> = mongoose.model<IPayment>('Payment', paymentSchema);

export default PaymentModel;