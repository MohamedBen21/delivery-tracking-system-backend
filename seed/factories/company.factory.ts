
import { faker } from "@faker-js/faker";

export function generateCompany(userId: string) {
    const isCompany = faker.datatype.boolean();

    return {
        name: faker.company.name(),
        businessType: isCompany ? "company" : "solo",
        registrationNumber: isCompany ? faker.string.alphanumeric(10) : undefined,
        email: faker.internet.email(),
        phone: faker.helpers.fromRegExp(/05[0-9]{8}/),
        userId,
        status: "active",
    };
}