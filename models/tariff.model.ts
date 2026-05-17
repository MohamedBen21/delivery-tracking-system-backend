import mongoose, { Document, Model, Schema } from "mongoose";
import { WILAYA_CODES, isValidWilayaCode, wilayaName } from "./wilayas.constant";

// ─────────────────────────────────────────────────────────────────────────────
//  One document per company.
//  Prices are stored as an embedded array of entries, each covering one
//  wilaya pair in canonical order (wilayaA ≤ wilayaB).
//
//  Full matrix:  58 × 57 / 2 + 58 = 1,653 entries  ≈ 80 KB  (well under 16 MB)
//
//  Reads:   one findOne(companyId) to get everything — no joins, no bulk reads.
//  Writes:  $set on the matching array element (positional $ operator).
// ─────────────────────────────────────────────────────────────────────────────

export type DeliveryMode = "stopdesk" | "domicile";

// ── Subdocument: one wilaya-pair entry ───────────────────────────────────────

export interface ITariffEntry {
  wilayaA: number;  // lower code  (1–58)
  wilayaB: number;  // higher code (1–58), wilayaA <= wilayaB always
  stopdesk: number; // price in DA
  domicile: number; // price in DA, always >= stopdesk
}

// ── Root document ─────────────────────────────────────────────────────────────

export interface ITariff extends Document {
  companyId: mongoose.Types.ObjectId;
  entries: ITariffEntry[];
  lastUpdatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITariffModel extends Model<ITariff> {
  /**
   * Returns the single tariff document for a company.
   * Use this on the manager's config page to render the full price table.
   */
  findByCompany(companyId: string): Promise<ITariff | null>;

  /**
   * Look up the price for a specific wilaya pair.
   * Codes can be passed in either order — normalised automatically.
   *
   * Returns the matching entry or null if no tariff is configured for that pair.
   *
   * @example
   *   const entry = await TariffModel.findPrice(companyId, 31, 16);
   *   entry?.stopdesk  // 500
   *   entry?.domicile  // 700
   */
  findPrice(
    companyId: string,
    wilayaFrom: number,
    wilayaTo: number
  ): Promise<ITariffEntry | null>;

  /**
   * Update (or insert) a single entry inside the company's tariff document.
   * Creates the root document if it doesn't exist yet.
   * Codes can be passed in either order.
   *
   * @example
   *   await TariffModel.setPrice(companyId, 16, 31,
   *     { stopdesk: 500, domicile: 700 }, managerId);
   */
  setPrice(
    companyId: string,
    wilayaFrom: number,
    wilayaTo: number,
    prices: Pick<ITariffEntry, "stopdesk" | "domicile">,
    updatedBy: string
  ): Promise<ITariff>;

  /**
   * Replace the entire entries array in one shot.
   * Useful for bulk imports or seeding a new company's price table.
   *
   * @example
   *   await TariffModel.bulkSetPrices(companyId, [
   *     { wilayaA: 16, wilayaB: 31, stopdesk: 500, domicile: 700 },
   *     { wilayaA:  9, wilayaB: 16, stopdesk: 400, domicile: 600 },
   *     ...
   *   ], managerId);
   */
  bulkSetPrices(
    companyId: string,
    entries: ITariffEntry[],
    updatedBy: string
  ): Promise<ITariff>;
}

// ─── Subdocument schema ───────────────────────────────────────────────────────

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
  { _id: false } // no ObjectId per entry — wilayaA+wilayaB is the natural key
);

// ─── Root schema ──────────────────────────────────────────────────────────────

const tariffSchema = new Schema<ITariff, ITariffModel>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "Company reference is required"],
      unique: true, // one document per company, enforced at DB level
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

// ─── Helper: normalise a pair so wilayaA <= wilayaB ──────────────────────────

function normalisePair(from: number, to: number): [number, number] {
  return from <= to ? [from, to] : [to, from];
}

// ─── Helper: validate and normalise a full entries array ─────────────────────

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

// ─── Statics ──────────────────────────────────────────────────────────────────

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

  // Project only the matching entry to avoid sending the full array over the wire
  const doc = await this.findOne(
    { companyId, "entries.wilayaA": a, "entries.wilayaB": b },
    { "entries.$": 1 } // positional projection: returns only the matched element
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

  // Try to update an existing entry first (positional $ operator)
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

  // Entry doesn't exist yet — push it, or create the root document entirely
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

// ─── Model ────────────────────────────────────────────────────────────────────

const TariffModel = (
  mongoose.models.Tariff ||
  mongoose.model<ITariff, ITariffModel>("Tariff", tariffSchema)
) as ITariffModel;

export default TariffModel;