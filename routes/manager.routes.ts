import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  assignTransporterBranches,
  assignTransporterHubLine,
  createBranch,
  createCompany,
  createSupervisor,
  getManagerAnalytics,
  getManagerDashboardOverview,
  getManagerPerformance,
  getBranch,
  getBranchSupervisor,
  getCompany,
  getMeManager,
  getMyBranches,
  getAllCompanies,
  getAllRoutes,
  getMyCompany,
  getMySupervisors,
  switchBranchHub,
  toggleBlockBranch,
  toggleBlockCompany,
  toggleBlockSupervisor,
  updateBranch,
  updateCompany,
  updateMeManager,
  updateSupervisor,
  getWilayaList,
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

managerRouter.get("/dashboard/overview", ...managerOrAdmin, getManagerDashboardOverview);
managerRouter.get("/dashboard/analytics", ...managerOrAdmin, getManagerAnalytics);
managerRouter.get("/dashboard/performance", ...managerOrAdmin, getManagerPerformance);

managerRouter.get("/me", ...managerOrAdmin, getMeManager);
managerRouter.patch("/me", ...managerOrAdmin, updateMeManager);

managerRouter.get("/wilayas", ...managerOrAdmin, getWilayaList);

managerRouter.post("/companies", isAuthenticated, authorizeRoles("client"), createCompany);
managerRouter.get("/routes", ...managerOrAdmin, getAllRoutes);
managerRouter.get("/companies/my", ...managerOrAdmin, getMyCompany);
managerRouter.get("/companies", isAuthenticated, authorizeRoles("admin"), getAllCompanies);
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


managerRouter.post("/companies/:companyId/transporters", isAuthenticated, authorizeRoles("admin", "manager", "supervisor"), createTransporter);
managerRouter.post(
  "/companies/:companyId/transporters/assign",
  ...managerOrAdmin,
  assignTransporter,
);

managerRouter.get("/companies/:companyId/transporters", isAuthenticated, authorizeRoles("admin", "manager", "supervisor"), getMyTransporters);
managerRouter.get(
  "/companies/:companyId/transporters/:transporterId",
  isAuthenticated,
  authorizeRoles("admin", "manager", "supervisor"),
  getTransporter,
);
managerRouter.patch(
  "/companies/:companyId/transporters/:transporterId",
  isAuthenticated,
  authorizeRoles("admin", "manager", "supervisor"),
  updateTransporter,
);
managerRouter.patch(
  "/companies/:companyId/transporters/:transporterId/toggle-block",
  isAuthenticated,
  authorizeRoles("admin", "manager", "supervisor"),
  toggleBlockTransporter,
);


managerRouter.post(
  "/companies/:companyId/branch/:branchId/promoted-branch/:promotedBranchId"
  , ...managerOrAdmin,
  switchBranchHub);

managerRouter.post(
  "/transporters/:id/assign-hub-line",
  ...managerOrAdmin,
  assignTransporterHubLine,
);

managerRouter.post(
  "/transporters/:id/assign-branches",
  ...managerOrAdmin,
  assignTransporterBranches,
);


// Taffif routes 

managerRouter.get("/taffifs", ...managerOrAdmin,)

export default managerRouter;


