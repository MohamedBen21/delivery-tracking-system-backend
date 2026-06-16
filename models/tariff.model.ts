import mongoose, { Document, Model, Schema } from "mongoose";
import { WILAYA_CODES, isValidWilayaCode, wilayaName } from "./wilayas.constant";



export type DeliveryMode = "stopdesk" | "domicile";



export interface ITariffEntry {
  wilayaA: number;  // lower code  (1–58)
  wilayaB: number;  // higher code (1–58), wilayaA <= wilayaB always
  stopdesk: number; // price in DA
  domicile: number; // price in DA, always >= stopdesk
}



export interface ITariff extends Document {
  companyId: mongoose.Types.ObjectId;
  entries: ITariffEntry[];
  lastUpdatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITariffModel extends Model<ITariff> {

  findByCompany(companyId: string): Promise<ITariff | null>;

  findPrice(
    companyId: string,
    wilayaFrom: number,
    wilayaTo: number
  ): Promise<ITariffEntry | null>;


  setPrice(
    companyId: string,
    wilayaFrom: number,
    wilayaTo: number,
    prices: Pick<ITariffEntry, "stopdesk" | "domicile">,
    updatedBy: string
  ): Promise<ITariff>;


  bulkSetPrices(
    companyId: string,
    entries: ITariffEntry[],
    updatedBy: string
  ): Promise<ITariff>;
}



const tariffEntrySchema = new Schema<ITariffEntry>(
  {
    wilayaA: {
      type: Number,
      required: true,
      enum: {
        values: WILAYA_CODES,
        message: "{VALUE} is not a valid wilaya code",
      },
    },
    wilayaB: {
      type: Number,
      required: true,
      enum: {
        values: WILAYA_CODES,
        message: "{VALUE} is not a valid wilaya code",
      },
    },
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
        validator: function (this: ITariffEntry, v: number) {
          return v >= this.stopdesk;
        },
        message: "Domicile price must be >= stopdesk price",
      },
    },
  },
  { _id: false } 
);



const tariffSchema = new Schema<ITariff, ITariffModel>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "Company reference is required"],
      unique: true, 
    },
    entries: {
      type: [tariffEntrySchema],
      default: [],
    },
    lastUpdatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "lastUpdatedBy (manager userId) is required"],
    },
  },
  {
    timestamps: true,
  }
);



function normalisePair(from: number, to: number): [number, number] {
  return from <= to ? [from, to] : [to, from];
}



function normaliseEntries(entries: ITariffEntry[]): ITariffEntry[] {
  return entries.map((e) => {
    if (!isValidWilayaCode(e.wilayaA) || !isValidWilayaCode(e.wilayaB)) {
      throw new Error(
        `Invalid wilaya code in entry: ${e.wilayaA} / ${e.wilayaB}`
      );
    }
    const [a, b] = normalisePair(e.wilayaA, e.wilayaB);
    return { ...e, wilayaA: a, wilayaB: b };
  });
}



tariffSchema.statics.findByCompany = function (
  companyId: string
): Promise<ITariff | null> {
  return this.findOne({ companyId });
};

tariffSchema.statics.findPrice = async function (
  companyId: string,
  wilayaFrom: number,
  wilayaTo: number
): Promise<ITariffEntry | null> {
  const [a, b] = normalisePair(wilayaFrom, wilayaTo);


  const doc = await this.findOne(
    { companyId, "entries.wilayaA": a, "entries.wilayaB": b },
    { "entries.$": 1 } 
  );

  return doc?.entries?.[0] ?? null;
};

tariffSchema.statics.setPrice = async function (
  companyId: string,
  wilayaFrom: number,
  wilayaTo: number,
  prices: Pick<ITariffEntry, "stopdesk" | "domicile">,
  updatedBy: string
): Promise<ITariff> {
  const [a, b] = normalisePair(wilayaFrom, wilayaTo);


  const updated = await this.findOneAndUpdate(
    {
      companyId,
      "entries.wilayaA": a,
      "entries.wilayaB": b,
    },
    {
      $set: {
        "entries.$.stopdesk": prices.stopdesk,
        "entries.$.domicile": prices.domicile,
        lastUpdatedBy: new mongoose.Types.ObjectId(updatedBy),
      },
    },
    { new: true }
  );

  if (updated) return updated;

  
  return this.findOneAndUpdate(
    { companyId },
    {
      $push: {
        entries: { wilayaA: a, wilayaB: b, ...prices },
      },
      $set: {
        lastUpdatedBy: new mongoose.Types.ObjectId(updatedBy),
      },
      $setOnInsert: {
        companyId: new mongoose.Types.ObjectId(companyId),
      },
    },
    { upsert: true, new: true }
  );
};

tariffSchema.statics.bulkSetPrices = function (
  companyId: string,
  entries: ITariffEntry[],
  updatedBy: string
): Promise<ITariff> {
  const normalised = normaliseEntries(entries);

  return this.findOneAndUpdate(
    { companyId },
    {
      $set: {
        entries: normalised,
        lastUpdatedBy: new mongoose.Types.ObjectId(updatedBy),
      },
      $setOnInsert: {
        companyId: new mongoose.Types.ObjectId(companyId),
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