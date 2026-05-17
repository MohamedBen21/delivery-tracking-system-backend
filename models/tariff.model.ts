import mongoose, { Document, Model, Schema } from "mongoose";
import { WILAYA_CODES, isValidWilayaCode, wilayaName } from "./wilayas.constant";

export type DeliveryMode = "stopdesk" | "domicile";

export interface ITariffPrices {
  stopdesk: number;
  domicile: number;
}

export interface ITariff extends Document {
  companyId: mongoose.Types.ObjectId;

  // Always stored so that wilayaA <= wilayaB (canonical order).
  // Enforces bidirectionality: Alger (16) → Oran (31) and
  // Oran (31) → Alger (16) map to the SAME document.

  wilayaA: number;
  wilayaB: number;

  prices: ITariffPrices;
  isActive: boolean;
  lastUpdatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;


  wilayaAName: string;
  wilayaBName: string;
  isSameWilaya: boolean;
}

export interface ITariffModel extends Model<ITariff> {

  /**
   * Main lookup used when quoting a package.
   * Pass the two wilaya codes in ANY order — normalised before querying.
   */

  findPrice(
    companyId: string,
    wilayaFrom: number,
    wilayaTo: number
  ): Promise<ITariff | null>;

  /** All tariffs for a company (for the manager's config page) */

  findByCompany(companyId: string): Promise<ITariff[]>;

  /**
   * Create or update a tariff row.
   * Normalises the wilaya pair automatically.
   */
  
  upsertTariff(
    companyId: string,
    wilayaFrom: number,
    wilayaTo: number,
    prices: ITariffPrices,
    updatedBy: string
  ): Promise<ITariff>;
}


const wilayaValidator = {
  validator: (v: number) => isValidWilayaCode(v),
  message: (props: { value: number }) =>
    `${props.value} is not a valid wilaya code (must be 1–58)`,
};



const tariffSchema = new Schema<ITariff, ITariffModel>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "Company reference is required"],
      index: true,
    },

    wilayaA: {
      type: Number,
      required: [true, "wilayaA is required"],
      enum: {
        values: WILAYA_CODES,
        message: "{VALUE} is not a valid wilaya code",
      },
      validate: wilayaValidator,
    },

    wilayaB: {
      type: Number,
      required: [true, "wilayaB is required"],
      enum: {
        values: WILAYA_CODES,
        message: "{VALUE} is not a valid wilaya code",
      },
      validate: wilayaValidator,
    },

    prices: {
      stopdesk: {
        type: Number,
        required: [true, "Stopdesk price is required"],
        min: [0, "Price cannot be negative"],
      },
      domicile: {
        type: Number,
        required: [true, "Domicile price is required"],
        min: [0, "Price cannot be negative"],
        validate: {
          validator: function (this: ITariff, v: number) {
            return v >= this.prices.stopdesk;
          },
          message: "Domicile price must be greater than or equal to stopdesk price",
        },
      },
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastUpdatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "lastUpdatedBy (manager userId) is required"],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);


tariffSchema.virtual("wilayaAName").get(function () {
  return wilayaName(this.wilayaA);  // e.g. "Alger"
});

tariffSchema.virtual("wilayaBName").get(function () {
  return wilayaName(this.wilayaB);  // e.g. "Oran"
});

tariffSchema.virtual("isSameWilaya").get(function () {
  return this.wilayaA === this.wilayaB;
});


// Core uniqueness: one price row per company per wilaya pair.
// wilayaA <= wilayaB is enforced in the pre-save hook, so
// this index naturally covers both directions.

tariffSchema.index(
  { companyId: 1, wilayaA: 1, wilayaB: 1 },
  { unique: true, name: "unique_company_wilaya_pair" }
);
tariffSchema.index({ companyId: 1, isActive: 1 });


tariffSchema.pre("save", function (next) {
  if (this.wilayaA > this.wilayaB) {
    [this.wilayaA, this.wilayaB] = [this.wilayaB, this.wilayaA];
  }
  next();
});



/**
 * findPrice — hot path, called every time a package is quoted.
 *
 * @example
 *   const tariff = await TariffModel.findPrice(companyId, 16, 31);
 *   // tariff.wilayaAName  → "Alger"
 *   // tariff.wilayaBName  → "Oran"
 *   // tariff.prices       → { stopdesk: 500, domicile: 700 }
 */

tariffSchema.statics.findPrice = function (
  companyId: string,
  wilayaFrom: number,
  wilayaTo: number
): Promise<ITariff | null> {
  const [a, b] = wilayaFrom <= wilayaTo
    ? [wilayaFrom, wilayaTo]
    : [wilayaTo, wilayaFrom];

  return this.findOne({ companyId, wilayaA: a, wilayaB: b, isActive: true });
};

/**
 * findByCompany — returns all tariffs sorted by wilayaA then wilayaB.
 * The virtuals wilayaAName / wilayaBName are available on each document.
 *
 * @example
 *   const tariffs = await TariffModel.findByCompany(companyId);
 *   tariffs.forEach(t =>
 *     console.log(`${t.wilayaAName} → ${t.wilayaBName}: ${t.prices.stopdesk} DA`)
 *   );
 */

tariffSchema.statics.findByCompany = function (
  companyId: string
): Promise<ITariff[]> {
  return this.find({ companyId }).sort({ wilayaA: 1, wilayaB: 1 });
};

/**
 * upsertTariff — create or update a tariff. Safe to call repeatedly from
 * the manager's "save prices" action.
 *
 * @example
 *   await TariffModel.upsertTariff(companyId, 16, 31,
 *     { stopdesk: 500, domicile: 700 }, managerId);
 *   // Oran → Alger would hit the same document (canonical order: 16, 31)
 */


tariffSchema.statics.upsertTariff = async function (
  companyId: string,
  wilayaFrom: number,
  wilayaTo: number,
  prices: ITariffPrices,
  updatedBy: string
): Promise<ITariff> {
  const [a, b] = wilayaFrom <= wilayaTo
    ? [wilayaFrom, wilayaTo]
    : [wilayaTo, wilayaFrom];

  return this.findOneAndUpdate(
    { companyId, wilayaA: a, wilayaB: b },
    {
      $set: {
        prices,
        isActive: true,
        lastUpdatedBy: new mongoose.Types.ObjectId(updatedBy),
      },
      $setOnInsert: {
        companyId: new mongoose.Types.ObjectId(companyId),
        wilayaA: a,
        wilayaB: b,
      },
    },
    { upsert: true, new: true, runValidators: true }
  );
};


const TariffModel = (
  mongoose.models.Tariff ||
  mongoose.model<ITariff, ITariffModel>("Tariff", tariffSchema)
) as ITariffModel;

export default TariffModel;