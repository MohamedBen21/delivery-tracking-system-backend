require("dotenv").config();
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
export const app = express();
import cookieParser from "cookie-parser";
import { ErrorMiddleware } from "./middleware/errors";
import authRouter from "./routes/auth.routes";
import freelancerRouter from "./routes/freelancer.routes";
import managerRouter from "./routes/manager.routes";
import supervisorRouter from "./routes/supervisor.routes";
import transporterRouter from "./routes/transporter.routes";
import delivererRouter from "./routes/deliverer.routes";
import vehicleRouter from "./routes/vehicle.routes";
import cashierRouter from "./routes/cashier.routes";
import loaderRouter from "./routes/loader.routes";

app.use(express.json({ limit: "50mb" }));

app.use(cookieParser());

app.use(
  cors({
    // origin: process.env.ORIGIN,
    origin: process.env.ORIGIN || "http://localhost:3000",
    credentials: true,
  }),
);

app.get("/", (req: Request, res: Response, next: NextFunction) => {
  res.status(200).json({
    success: true,
    message: "TEST.",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/freelancer", freelancerRouter);
app.use("/api/manager", managerRouter);
app.use("/api/supervisor", supervisorRouter);
app.use("/api/transporter", transporterRouter);
app.use("/api/deliverer", delivererRouter);
app.use("/api/vehicle", vehicleRouter);
app.use("/api/cashier", cashierRouter);
app.use("/api/loader", loaderRouter);


app.all("*", (req: Request, res: Response, next: NextFunction) => {
  const err = new Error(`route ${req.originalUrl} not found :(`) as any;

  err.statusCode = 404;

  next(err);
});

app.use(ErrorMiddleware);
