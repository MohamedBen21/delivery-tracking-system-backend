import express from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  createVehicle,
  updateVehicle,
  toggleVehicleStatus,
  getVehicle,
  getCompanyVehicles,
  assignVehicle,
  releaseVehicle,
  // getVehicleById,
} from "../controllers/vehicle.controller";

const vehicleRouter = express.Router();

// ── Vehicle CRUD ──

vehicleRouter.post(
  "/company/:companyId/vehicle",
  isAuthenticated,
  authorizeRoles("manager", "supervisor"),
  createVehicle
);

vehicleRouter.put(
  "/company/:companyId/vehicle/:vehicleId",
  isAuthenticated,
  authorizeRoles("manager", "supervisor"),
  updateVehicle
);

vehicleRouter.patch(
  "/company/:companyId/vehicle/:vehicleId/toggle-status",
  isAuthenticated,
  authorizeRoles("manager", "supervisor"),
  toggleVehicleStatus
);

vehicleRouter.get(
  "/company/:companyId/vehicle/:vehicleId",
  isAuthenticated,
  authorizeRoles("manager", "admin", "supervisor", "deliverer", "transporter"),
  getVehicle
);

vehicleRouter.get(
  "/company/:companyId/vehicles",
  isAuthenticated,
  authorizeRoles("manager", "supervisor"),
  getCompanyVehicles
);

// ── Vehicle assignment ──

vehicleRouter.patch(
  "/company/:companyId/vehicle/:vehicleId/assign",
  isAuthenticated,
  authorizeRoles("manager", "supervisor", "admin"),
  assignVehicle
);

vehicleRouter.patch(
  "/company/:companyId/vehicle/:vehicleId/release",
  isAuthenticated,
  authorizeRoles("manager", "supervisor", "admin"),
  releaseVehicle
);


// vehicleRouter.get(
//   "/vehicle/:id",
//   isAuthenticated,
//   authorizeRoles("manager", "admin", "supervisor", "transporter", "deliverer"),
//   getVehicleById
// );

export default vehicleRouter;