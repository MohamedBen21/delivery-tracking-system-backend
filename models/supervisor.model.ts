import mongoose, { Document, Model, Schema } from "mongoose";

export type SupervisorPermission = 
  | 'can_manage_deliverers'
  | 'can_manage_packages'
  | 'can_manage_vehicles'
  | 'can_view_reports'
  | 'can_approve_deliverers'
  | 'can_modify_branch_settings'
  | 'can_view_analytics'
  | 'can_manage_schedules'
  | 'can_assign_tasks'
  | 'can_handle_complaints';

export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';


const SUPERVISOR_PERMISSIONS: SupervisorPermission[] = [
  'can_manage_deliverers',
  'can_manage_packages',
  'can_manage_vehicles',
  'can_view_reports',
  'can_approve_deliverers',
  'can_modify_branch_settings',
  'can_view_analytics',
  'can_manage_schedules',
  'can_assign_tasks',
  'can_handle_complaints',
];

const defaultWorkSchedule: Record<WeekDay, IWorkScheduleDay> = {
  monday: { start: "08:00", end: "17:00", dayOff: false },
  tuesday: { start: "08:00", end: "17:00", dayOff: false },
  wednesday: { start: "08:00", end: "17:00", dayOff: false },
  thursday: { start: "08:00", end: "17:00", dayOff: false },
  friday: { start: "08:00", end: "17:00", dayOff: false },
  saturday: { start: "10:00", end: "14:00", dayOff: false },
  sunday: { start: "00:00", end: "00:00", dayOff: true },
};

const defaultPermissions: SupervisorPermission[] = [
  'can_manage_deliverers',
  'can_manage_packages',
  'can_manage_vehicles',
  'can_view_reports',
  'can_assign_tasks',
  'can_handle_complaints',
];

export interface IWorkScheduleDay {
  start: string;
  end: string;   
  dayOff: boolean;
}

export interface IPerformance {
  packagesManaged: number;
  deliverersSupervised: number;
  issuesResolved: number;
  averageResponseTime: number; 
  rating?: number; 
}


export interface ISupervisor extends Document {
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;

  permissions: SupervisorPermission[];
  workSchedule: Record<WeekDay, IWorkScheduleDay>;
   
   performance: IPerformance;

  isActive: boolean;

  createdAt: Date;
  updatedAt: Date;
  
  isCurrentlyWorking: boolean;
  hasPermission: (permission: SupervisorPermission) => boolean;
  isDayOff: (day?: WeekDay) => boolean;
  currentWorkHours?: { start: string; end: string } | null;
  formattedSchedule: Record<WeekDay, string>;
}


const workScheduleDaySchema = new Schema<IWorkScheduleDay>({
  start: {
    type: String,
    required: true,
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Start time must be in HH:MM format'],
    default: "08:00",
  },

  end: {
    type: String,
    required: true,

    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'End time must be in HH:MM format'],
    default: "17:00",
  },

  dayOff: {
    type: Boolean,

    default: false,
  },
}, { _id: false });


const performanceSchema = new Schema<IPerformance>({
  packagesManaged: {
    type: Number,
    default: 0,
    min: 0,
  },
  
  deliverersSupervised: {
    type: Number,
    default: 0,
    min: 0,
  },

  issuesResolved: {
    type: Number,
    default: 0,
    min: 0,
  },
  averageResponseTime: {
    type: Number,
    default: 0,
    min: 0,
  },
  rating: {
    type: Number,
    min: 1,
    max: 5,
  },
}, { _id: false });


const supervisorSchema = new Schema<ISupervisor>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User reference is required'],
    unique: true,
  },

  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Company reference is required'],
  },

  branchId: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'Branch reference is required'],
  },
  
  permissions: {
    type: [String],
    enum: {
      values: SUPERVISOR_PERMISSIONS,
      message: 'Invalid permission value: {VALUE}',
    },
    default: defaultPermissions,
    validate: {
      validator: function(permissions: string[]) {
        const uniquePermissions = [...new Set(permissions)];
        return uniquePermissions.length === permissions.length;
      },
      message: 'Duplicate permissions are not allowed',
    },
  },
  
  workSchedule: {
    type: {
      monday: workScheduleDaySchema,
      tuesday: workScheduleDaySchema,
      wednesday: workScheduleDaySchema,
      thursday: workScheduleDaySchema,
      friday: workScheduleDaySchema,
      saturday: workScheduleDaySchema,
      sunday: workScheduleDaySchema,
    },
    default: defaultWorkSchedule,
    required: true,
  },
  
  performance: {
    type: performanceSchema,
    default: () => ({
      packagesManaged: 0,
      deliverersSupervised: 0,
      issuesResolved: 0,
      averageResponseTime: 0,
    }),
  },
  
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});


supervisorSchema.virtual('isCurrentlyWorking').get(function() {
  if (!this.isActive) return false;
  
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() as WeekDay;
  const time = now.toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit',
  });
  
  const schedule = this.workSchedule[day];
  
  if (schedule.dayOff) return false;
  
  return time >= schedule.start && time <= schedule.end;
});

supervisorSchema.virtual('currentWorkHours').get(function() {
  if (!this.isActive) return null;
  
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() as WeekDay;
  const schedule = this.workSchedule[day];
  
  if (schedule.dayOff) return null;
  
  return {
    start: schedule.start,

    end: schedule.end,
  };
});

supervisorSchema.virtual('formattedSchedule').get(function() {
  const formatted: Record<WeekDay, string> = {} as Record<WeekDay, string>;
  
  Object.entries(this.workSchedule).forEach(([day, schedule]: [string, IWorkScheduleDay]) => {
    const typedDay = day as WeekDay;
    if (schedule.dayOff) {
      formatted[typedDay] = 'Day Off';
    } else {
      formatted[typedDay] = `${schedule.start} - ${schedule.end}`;
    }
  });
  
  return formatted;
});

supervisorSchema.methods.hasPermission = function(permission: SupervisorPermission): boolean {
  return this.permissions.includes(permission);
};

supervisorSchema.methods.hasPermissions = function(permissions: SupervisorPermission[]): boolean {
  return permissions.every(permission => this.permissions.includes(permission));
};

supervisorSchema.methods.isDayOff = function(day?: WeekDay): boolean {

  const targetDay = day || new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() as WeekDay;
  return this.workSchedule[targetDay].dayOff;
};

supervisorSchema.methods.addPermission = function(permission: SupervisorPermission) {
  if (!this.permissions.includes(permission)) {
    this.permissions.push(permission);
  }
  return this.save();
};

supervisorSchema.methods.removePermission = function(permission: SupervisorPermission) {
  this.permissions = this.permissions.filter((p:SupervisorPermission) => p !== permission);
  return this.save();
};

supervisorSchema.methods.updateDaySchedule = function(
  day: WeekDay, 
  schedule: Partial<IWorkScheduleDay>
) {
  this.workSchedule[day] = { ...this.workSchedule[day], ...schedule };
  return this.save();
};


supervisorSchema.methods.updatePerformance = function(updates: Partial<IPerformance>) {
  this.performance = { ...this.performance, ...updates };
  return this.save();
};


supervisorSchema.pre('save', function(next) {
  Object.entries(this.workSchedule).forEach(([day, schedule]: [string, IWorkScheduleDay]) => {
    if (!schedule.dayOff) {
      if (schedule.start >= schedule.end) {
        return next(new Error(`${day}: Start time must be before end time`));
      }
    }
  });
  
  this.permissions = [...new Set(this.permissions)];
  
  next();
});

supervisorSchema.index({ userId: 1 });
supervisorSchema.index({ branchId: 1 });
supervisorSchema.index({ companyId: 1 });
supervisorSchema.index({ isActive: 1 });
supervisorSchema.index({ companyId: 1, branchId: 1 });
supervisorSchema.index({ 'performance.rating': -1 });


const SupervisorModel: Model<ISupervisor> = mongoose.model<ISupervisor>('Supervisor', supervisorSchema);

export default SupervisorModel;