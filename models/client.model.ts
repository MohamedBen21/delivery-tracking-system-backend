import mongoose, { Document, Model, Schema } from "mongoose";


export interface IDeliveryAddress {
  _id?: mongoose.Types.ObjectId;
  label: string;
  street: string;
  city: string;
  state: string;
  isDefault: boolean;
}

export interface ICurrentLocation {
  type: "Point";
  coordinates: [number, number];
  timestamp: Date;
}

export interface IClient extends Document {
  userId: mongoose.Types.ObjectId;
  deliveryAddresses: IDeliveryAddress[];
  currentLocation?: ICurrentLocation;
}


const locationSchema = new Schema<ICurrentLocation>({
  type: {
    type: String,
    enum: ['Point'],
    default: 'Point',
    required: true
  },
  coordinates: {
    type: [Number],
    required: [true, 'Coordinates are required'],
    validate: {
      validator: function(v: number[]) {
        return (
          Array.isArray(v) &&
          v.length === 2 &&
          v[0] >= -180 && v[0] <= 180 && 
          v[1] >= -90 && v[1] <= 90     
        );
      },
      message: 'Coordinates must be valid [longitude, latitude] values'
    }
  },
  timestamp: {
    type: Date,
    default: Date.now,
    required: true
  }
});

const deliveryAddressSchema = new Schema<IDeliveryAddress>(
  {
    label: {
      type: String,
      required: true,
      trim: true,
    },

    street: {
      type: String,
      required: true,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },

    state: {
      type: String,
      required: true,
      trim: true,
    },
    
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);


const clientSchema: Schema<IClient> = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    deliveryAddresses: {
      type: [deliveryAddressSchema],
      default: [],
    },

    currentLocation: {
      type : locationSchema,
      required: false
    },
  },
  { timestamps: true }
);


clientSchema.index({ userId: 1 });
clientSchema.index({ currentLocation: '2dsphere' });


const clientModel: Model<IClient> = mongoose.model("Client", clientSchema);

export default clientModel;
