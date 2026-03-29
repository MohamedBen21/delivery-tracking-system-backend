import twilio from 'twilio';
require("dotenv").config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

interface SMSOptions {
  to: string;
  message: string;
}

const sendSMS = async (options: SMSOptions): Promise<boolean> => {
  try {
    await client.messages.create({
      body: options.message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: options.to
    });
    return true;
  } catch (error: any) {
    console.error('SMS sending failed:', error);
    return false;
  }
};

export default sendSMS; 