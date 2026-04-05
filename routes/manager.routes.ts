import express from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  createCompany,
  updateCompany,
  toggleBlockCompany,
  getCompany,
  getMyCompany,
  createBranch,
  updateBranch,
  toggleBlockBranch,
  getBranch,
  getMyBranches,
  createSupervisor,
  updateSupervisor,
  toggleBlockSupervisor,
  getBranchSupervisor,
  getMySupervisors,
} from "../controllers/manager.controller";

const managerRouter = express.Router();

// ── Company routes ──
managerRouter.post(
  "/company",
  isAuthenticated,
  authorizeRoles("manager"),
  createCompany
);

managerRouter.put(
  "/company/:companyId",
  isAuthenticated,
  authorizeRoles("manager"),
  updateCompany
);

managerRouter.patch(
  "/company/:companyId/toggle-block",
  isAuthenticated,
  authorizeRoles("manager", "admin"),
  toggleBlockCompany
);

managerRouter.get(
  "/company/:companyId",
  isAuthenticated,
  authorizeRoles("manager", "admin"),
  getCompany
);

managerRouter.get(
  "/my-company",
  isAuthenticated,
  authorizeRoles("manager"),
  getMyCompany
);

// ── Branch routes ──
managerRouter.post(
  "/company/:companyId/branch",
  isAuthenticated,
  authorizeRoles("manager"),
  createBranch
);

managerRouter.put(
  "/company/:companyId/branch/:branchId",
  isAuthenticated,
  authorizeRoles("manager"),
  updateBranch
);

managerRouter.patch(
  "/company/:companyId/branch/:branchId/toggle-block",
  isAuthenticated,
  authorizeRoles("manager", "admin"),
  toggleBlockBranch
);

managerRouter.get(
  "/company/:companyId/branch/:branchId",
  isAuthenticated,
  authorizeRoles("manager", "admin"),
  getBranch
);

managerRouter.get(
  "/company/:companyId/branches",
  isAuthenticated,
  authorizeRoles("manager"),
  getMyBranches
);

// ── Supervisor routes ──
managerRouter.post(
  "/company/:companyId/supervisor",
  isAuthenticated,
  authorizeRoles("manager"),
  createSupervisor
);

managerRouter.put(
  "/supervisor/:supervisorId",
  isAuthenticated,
  authorizeRoles("manager"),
  updateSupervisor
);

managerRouter.patch(
  "/company/:companyId/supervisor/:supervisorId/toggle-block",
  isAuthenticated,
  authorizeRoles("manager", "admin"),
  toggleBlockSupervisor
);

managerRouter.get(
  "/company/:companyId/branch/:branchId/supervisor",
  isAuthenticated,
  authorizeRoles("manager", "admin"),
  getBranchSupervisor
);

managerRouter.get(
  "/company/:companyId/supervisors",
  isAuthenticated,
  authorizeRoles("manager"),
  getMySupervisors
);

export default managerRouter;
