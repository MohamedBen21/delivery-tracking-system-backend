import mongoose, { Document, Model, Schema } from "mongoose";

export type BusinessType = "solo" | "company";

export type CompanyStatus = "active" | "inactive" | "suspended" | "pending";

const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex: RegExp = /^(\+213|0)(5|6|7)[0-9]{8}$/;

export interface IHeadquarters {
  street: string;
  city: string;
  state: string;
  location: {
    type: "Point";
    coordinates: [number, number]; 
  };
}

export interface ICompany extends Document {
  name: string;
  businessType: BusinessType;
  userId: mongoose.Types.ObjectId; // Freelancer or manager
  registrationNumber?: string;
  email?: string;
  phone?: string;
  logo?: string;

  headquarters?: IHeadquarters;

  status: CompanyStatus;
  
  createdAt: Date;
  updatedAt: Date;
  
  // attribut virtuel (for use in controller)
  isSolo: boolean;
  isActive: boolean;
  formattedAddress?: string;
}

const headquartersSchema = new Schema<IHeadquarters>({
  street: {
    type: String,
    trim: true,
    required: [true, "Street is required if headquarters is provided"],
  },
  city: {
    type: String,
    trim: true,
    required: [true, "City is required if headquarters is provided"],
  },
  state: {
    type: String,
    trim: true,
    required: [true, "State is required if headquarters is provided"],
  },
  location: {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
    },
    coordinates: {
      type: [Number],
      required: [true, "Location coordinates are required if headquarters is provided"],
      validate: {
        validator: function(v: number[]) {
          return (
            Array.isArray(v) &&
            v.length === 2 &&
            v[0] >= -180 && v[0] <= 180 && 
            v[1] >= -90 && v[1] <= 90    
          );
        },
        message: "Coordinates must be valid [longitude, latitude] values"
      }
    },
  },
}, { _id: false });


const companySchema: Schema<ICompany> = new Schema(
  {
    name: {
      type: String,
      required: [true, "Company name is required"],
      unique: true,
      trim: true,
      minlength: [2, "Company name must be at least 2 characters"],
      maxlength: [100, "Company name cannot exceed 100 characters"],
    },
    
    businessType: {
      type: String,
      enum: {
        values: ["solo", "company"],
        message: "Business type must be either 'solo' or 'company'"
      },
      required: [true, "Business type is required"],
      default: "company",
    },
    
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
    },
    

    registrationNumber: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      required: [
        function() {
          return this.businessType === "company";
        },
        "registration number is required for company business types"
      ],
    },
    
    email: {
      type: String,
      trim: true,
      lowercase: true,

      validate:{
        validator: (value: string) => emailRegex.test(value),
        message:"Please enter a valid email address."   
    }
    },
    
    phone: {
      type: String,
      trim: true,

      validate:{
        validator: (value: string) => phoneRegex.test(value),
        message:"Please enter a valid Algerian phone number."
      }
    },
    
    logo: {
      type: String,
      trim: true,
    },
    
    headquarters: {
      type: headquartersSchema,
      required: false,
    },
    

    status: {
      type: String,
      enum: {
        values: ["active", "inactive", "suspended", "pending"],
        message: "status entered is invalid: {VALUE}.",
      },
      default: "active",
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

companySchema.virtual("isSolo").get(function() {
  return this.businessType === "solo";
});

companySchema.virtual("isActive").get(function() {
  return this.status === "active";
});

companySchema.virtual("formattedAddress").get(function() {
  if (!this.headquarters) return undefined;
  
  const { street, city, state } = this.headquarters;
  const parts = [];
  
  if (street) parts.push(street);
  if (city) parts.push(city);
  if (state) parts.push(state);
  
  return parts.join(", ") || undefined;
});


companySchema.index({ name: 1 }); 
companySchema.index({ userId: 1 });
companySchema.index({ status: 1 });
companySchema.index({ "headquarters.location": "2dsphere" });
companySchema.index({ businessType: 1, status: 1 });
companySchema.index({ registrationNumber: 1 }, { unique: true, sparse: true });


companySchema.pre("save", function(next) {
  const headquarters = this.headquarters;
  
  if (headquarters && typeof headquarters === 'object') {
    const hasSomeFields = 
      headquarters.street !== undefined ||
      headquarters.city !== undefined ||
      headquarters.state !== undefined ||
      headquarters.location !== undefined;
    
    const hasAllRequiredFields = 
      headquarters.street &&
      headquarters.city &&
      headquarters.state &&
      headquarters.location &&
      headquarters.location.coordinates &&
      Array.isArray(headquarters.location.coordinates) &&
      headquarters.location.coordinates.length === 2;
    
    if (hasSomeFields && !hasAllRequiredFields) {
      const missingFields = [];
      if (!headquarters.street) missingFields.push('street');
      if (!headquarters.city) missingFields.push('city');
      if (!headquarters.state) missingFields.push('state');
      if (!headquarters.location?.coordinates || 
          !Array.isArray(headquarters.location.coordinates) || 
          headquarters.location.coordinates.length !== 2) {
        missingFields.push('location.coordinates');
      }
      
      const error = new mongoose.Error.ValidationError();
      error.errors.headquarters = new mongoose.Error.ValidatorError({
        message: `If headquarters is provided, all fields must be provided. Missing: ${missingFields.join(', ')}`,
        path: 'headquarters',
        value: headquarters
      });
      return next(error);
    }
  }
  
  next();
});


companySchema.pre("findOneAndUpdate", function(next) {
  const update = this.getUpdate() as any;
  
  if (update && update.headquarters) {
    const headquarters = update.headquarters;
    
    const headquartersData = headquarters.$set ? headquarters.$set : headquarters;
    
    if (headquartersData && typeof headquartersData === 'object') {
      const hasSomeFields = 
        headquartersData.street !== undefined ||
        headquartersData.city !== undefined ||
        headquartersData.state !== undefined ||
        headquartersData.location !== undefined;
      
      const hasAllRequiredFields = 
        headquartersData.street &&
        headquartersData.city &&
        headquartersData.state &&
        headquartersData.location &&
        headquartersData.location.coordinates &&
        Array.isArray(headquartersData.location.coordinates) &&
        headquartersData.location.coordinates.length === 2;
      
      if (hasSomeFields && !hasAllRequiredFields) {
        const missingFields = [];
        if (!headquartersData.street) missingFields.push('street');
        if (!headquartersData.city) missingFields.push('city');
        if (!headquartersData.state) missingFields.push('state');
        if (!headquartersData.location?.coordinates || 
            !Array.isArray(headquartersData.location.coordinates) || 
            headquartersData.location.coordinates.length !== 2) {
          missingFields.push('location.coordinates');
        }
        
        const error = new mongoose.Error.ValidationError();
        error.errors.headquarters = new mongoose.Error.ValidatorError({
          message: `If headquarters is provided, all fields must be provided. Missing: ${missingFields.join(', ')}`,
          path: 'headquarters',
          value: headquartersData
        });
        return next(error);
      }
    }
  }
  
  next();
});

companySchema.statics.findActive = function() {
  return this.find({ status: "active" });
};


companySchema.statics.findByUser = function(userId: string) {
  return this.find({ userId });
};

companySchema.statics.findSoloBusinesses = function() {
  return this.find({ businessType: "solo", status: "active" });
};

const CompanyModel: Model<ICompany> = mongoose.model<ICompany>("Company", companySchema);

export default CompanyModel;