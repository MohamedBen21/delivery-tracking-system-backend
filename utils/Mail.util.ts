import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

export const Mail = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  service: process.env.SMTP_SERVICE,
  auth: {
    user: process.env.SMTP_MAIL,
    pass: process.env.SMTP_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
});
