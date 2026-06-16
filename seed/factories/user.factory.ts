// src/seed/factories/user.factory.ts
import { faker } from "@faker-js/faker";
import bcrypt from "bcryptjs";

export function generateUser() {
    const password = bcrypt.hashSync("123456", 10);

    return {
        firstName: faker.person.firstName(),
        lastName: faker.person.lastName(),
        email: faker.internet.email().toLowerCase(),
        phone: faker.helpers.fromRegExp(/06[0-9]{8}/),
        password,
        role: "client",
    };
}