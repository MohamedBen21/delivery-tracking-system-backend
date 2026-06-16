export const VEHICLE_TYPES = [
    "motorcycle",
    "car",
    "van",
    "small_truck",
    "large_truck",
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_STATUSES = [
    "available",
    "in_use",
    "maintenance",
    "out_of_service",
    "retired",
] as const;

export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const PACKAGE_TYPES = [
    "document",
    "parcel",
    "fragile",
    "heavy",
    "perishable",
    "electronic",
    "clothing",
] as const;

export type PackageType = (typeof PACKAGE_TYPES)[number];

export const DELIVERY_TYPES = ["home", "branch_pickup"] as const;

export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export const DELIVERY_PRIORITIES = ["standard", "express", "same_day"] as const;

export type DeliveryPriority = (typeof DELIVERY_PRIORITIES)[number];

export const SAFE_CITIES = [
    "Algiers",
    "Oran",
    "Constantine",
    "Annaba",
    "Blida",
    "Setif",
    "Batna",
    "Tlemcen",
] as const;

export const DEFAULT_PASSWORD = "123456";

export const SEED_CONFIG = {
    TOTAL_COMPANIES: 5,
    LOCAL_BRANCHES_PER_COMPANY: 2,
    FREELANCERS_PER_BRANCH: 3,
    CASHIERS_PER_BRANCH: 2,
    LOADERS_PER_BRANCH: 2,
    DELIVERERS_PER_BRANCH: 3,
    TRANSPORTERS_PER_COMPANY: 2,
    VEHICLES_PER_COMPANY: 4,
    WILAYA_COUNT: 58,
    TARIFF_ROUTES_PER_COMPANY: 10,
    PACKAGES_PER_FREELANCER: 5,
    CASHIER_CREATED_PACKAGE_RATE: 0.2,
};