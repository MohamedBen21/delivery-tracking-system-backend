import mongoose, { Document, Model, Schema } from "mongoose";

export interface ICashReturnSession extends Document {
  delivererId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  amount: number;
  todayDeliveries: number;
  todayEarnings: number;
  todayCollected: number;
  code: string;
  expiresAt: Date;
  verified: boolean;
  verifiedAt?: Date;
  createdAt: Date;
}

const cashReturnSessionSchema = new Schema<ICashReturnSession>(
  {
    delivererId: {
      type: Schema.Types.ObjectId,
      ref: "Deliverer",
      required: true,
    },
    
    branchId: {
     type: Schema.Types.ObjectId,
     ref: "Branch", required: true 
    },

    amount: { 
     type: Number, 
     required: true 
    },

    todayDeliveries: {
     type: Number, 
     required: true 
    },

    todayEarnings: {
     type: Number, 
     required: true 
    },

    todayCollected: {
     type: Number,
     required: true 
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
    verifiedAt: {
     type: Date 
    },

  },
  { timestamps: true },
);

// index: auto-delete expired sessions after 1 hour
cashReturnSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const CashReturnSessionModel = mongoose.model<ICashReturnSession>(
  "CashReturnSession",
  cashReturnSessionSchema,
);
