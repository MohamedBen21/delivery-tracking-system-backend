import { faker } from "@faker-js/faker";
import mongoose from "mongoose";
import { SAFE_CITIES, DEFAULT_PASSWORD } from "./constants";


export function generateCode(prefix: string, index: number): string {
    const cleanPrefix = prefix
        .replace(/[^a-zA-Z]/g, "")
        .toUpperCase()
        .substring(0, 3)
        .padEnd(3, "X");

    const number = String((index * 37 + faker.number.int({ min: 0, max: 998 })) % 999 + 1).padStart(3, "0");

    return `${cleanPrefix}-${number}`;
}

export function getMaxWeight(type: string): number {
    switch (type) {
        case "motorcycle": return faker.number.float({ min: 5, max: 30, fractionDigits: 1 });
        case "car": return faker.number.float({ min: 50, max: 200, fractionDigits: 1 });
        case "van": return faker.number.float({ min: 200, max: 800, fractionDigits: 1 });
        case "small_truck": return faker.number.float({ min: 800, max: 3500, fractionDigits: 1 });
        case "large_truck": return faker.number.float({ min: 3500, max: 20000, fractionDigits: 1 });
        default: return faker.number.float({ min: 50, max: 1000, fractionDigits: 1 });
    }
}

/** Picks a random city from the safe, known-good city list. */
export function getSafeCity(): string {
    return faker.helpers.arrayElement(SAFE_CITIES as readonly string[]);
}

/** Builds a random GeoJSON Point. */
export function randomPoint() {
    return {
        type: "Point" as const,
        coordinates: [faker.location.longitude(), faker.location.latitude()] as [
            number,
            number,
        ],
    };
}

function fakeNameAtLeast(minLength: number, generator: () => string): string {
    let name = generator();
    let attempts = 0;
    while (name.length < minLength && attempts < 20) {
        name = generator();
        attempts++;
    }
    return name.length >= minLength ? name : name.padEnd(minLength, "x");
}

export function fakeEmail(tag: string): string {
    return `${tag}_${faker.string.uuid()}@test.com`;
}

export function fakePhone(prefix: "05" | "06" | "07" = "06"): string {
    return `${prefix}${faker.string.numeric(8)}`;
}

/** Normalizes a local "0xxxxxxxxx" phone into the API's "+213xxxxxxxxx" format (mirrors createPackage's normalizePhone). */
export function normalizeAlgerianPhone(phone: string): string {
    const digitsAndPlus = phone.trim().replace(/[^\d+]/g, "");
    return digitsAndPlus.startsWith("0") ? `+213${digitsAndPlus.substring(1)}` : digitsAndPlus;
}

export function buildUserPayload(role: string, tag: string) {
    return {
        firstName: fakeNameAtLeast(3, () => faker.person.firstName()),
        lastName: fakeNameAtLeast(3, () => faker.person.lastName()),
        email: fakeEmail(tag),
        phone: fakePhone(),
        passwordHash: DEFAULT_PASSWORD,
        role,
        status: "active" as const,
    };
}

export async function createOne<T>(
    Model: mongoose.Model<T>,
    payload: Record<string, any>,
    session: mongoose.ClientSession,
): Promise<mongoose.HydratedDocument<T>> {
    const [doc] = await Model.create([payload], { session });
    return doc;
}

export function logStep(message: string) {
    console.log(message);
}