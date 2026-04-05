import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  createBranch,
  createCompany,
  createSupervisor,
  createVehicle,
  getBranch,
  getBranchSupervisor,
  getCompany,
  getCompanyVehicles,
  getMeManager,
  getMyBranches,
  getMyCompany,
  getMySupervisors,
  toggleBlockBranch,
  toggleBlockCompany,
  toggleBlockSupervisor,
  updateBranch,
  updateCompany,
  updateMeManager,
  updateSupervisor,
  updateVehicle,
} from "../controllers/manager.controller";
import {
  assignTransporter,
  createTransporter,
  getMyTransporters,
  getTransporter,
  toggleBlockTransporter,
  updateTransporter,
} from "../controllers/supervisor.controller";

const managerRouter = Router();

const managerOrAdmin = [isAuthenticated, authorizeRoles("manager", "admin")] as const;

managerRouter.get("/me", ...managerOrAdmin, getMeManager);
managerRouter.patch("/me", ...managerOrAdmin, updateMeManager);

managerRouter.post("/companies", ...managerOrAdmin, createCompany);
managerRouter.get("/companies/my", ...managerOrAdmin, getMyCompany);
managerRouter.get("/companies/:companyId", ...managerOrAdmin, getCompany);
managerRouter.patch("/companies/:companyId", ...managerOrAdmin, updateCompany);
managerRouter.patch("/companies/:companyId/toggle-block", ...managerOrAdmin, toggleBlockCompany);

managerRouter.post("/companies/:companyId/branches", ...managerOrAdmin, createBranch);
managerRouter.get("/companies/:companyId/branches", ...managerOrAdmin, getMyBranches);
managerRouter.get("/companies/:companyId/branches/:branchId", ...managerOrAdmin, getBranch);
managerRouter.patch("/companies/:companyId/branches/:branchId", ...managerOrAdmin, updateBranch);
managerRouter.patch(
  "/companies/:companyId/branches/:branchId/toggle-block",
  ...managerOrAdmin,
  toggleBlockBranch,
);
managerRouter.get(
  "/companies/:companyId/branches/:branchId/supervisor",
  ...managerOrAdmin,
  getBranchSupervisor,
);

managerRouter.post("/companies/:companyId/supervisors", ...managerOrAdmin, createSupervisor);
managerRouter.get("/companies/:companyId/supervisors", ...managerOrAdmin, getMySupervisors);
managerRouter.patch("/supervisors/:supervisorId", ...managerOrAdmin, updateSupervisor);
managerRouter.patch(
  "/companies/:companyId/supervisors/:supervisorId/toggle-block",
  ...managerOrAdmin,
  toggleBlockSupervisor,
);

managerRouter.post("/companies/:companyId/vehicles", ...managerOrAdmin, createVehicle);
managerRouter.get("/companies/:companyId/vehicles", ...managerOrAdmin, getCompanyVehicles);
managerRouter.patch("/companies/:companyId/vehicles/:vehicleId", ...managerOrAdmin, updateVehicle);

managerRouter.post("/companies/:companyId/transporters", ...managerOrAdmin, createTransporter);
managerRouter.post(
  "/companies/:companyId/transporters/assign",
  ...managerOrAdmin,
  assignTransporter,
);
managerRouter.get("/companies/:companyId/transporters", ...managerOrAdmin, getMyTransporters);
managerRouter.get(
  "/companies/:companyId/transporters/:transporterId",
  ...managerOrAdmin,
  getTransporter,
);
managerRouter.patch(
  "/companies/:companyId/transporters/:transporterId",
  ...managerOrAdmin,
  updateTransporter,
);
managerRouter.patch(
  "/companies/:companyId/transporters/:transporterId/toggle-block",
  ...managerOrAdmin,
  toggleBlockTransporter,
);

export default managerRouter;
