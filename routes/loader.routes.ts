import { Router } from "express";
import { isAuthenticated, authorizeRoles } from "../middleware/auth";
import {
  checkIn,
  checkOut,
  createManifest,
  scanPackageIn,
  removePackageFromManifest,
  sealManifest,
  loadManifestOnTruck,
  markManifestDeparted,
  markManifestArrived,
  scanPackageOut,
  remanifestPackage,
  closeManifest,
  flagDiscrepancy,
  getMyShift,
  getManifestDetail,
  getMyStats,
  getPackagesToManifest,
  getPackagesToManifestGroupedByDestination,
} from "../controllers/loader.controller";

const loaderRouter = Router();

// All loader routes require authentication and loader role
loaderRouter.use(isAuthenticated, authorizeRoles("loader"));

// Shift management
loaderRouter.post("/check-in", checkIn);
loaderRouter.post("/check-out", checkOut);
loaderRouter.get("/my-shift", getMyShift);
loaderRouter.get("/my-stats", getMyStats);

// Manifest CRUD operations
loaderRouter.post("/manifests", createManifest);
loaderRouter.get("/manifests/:manifestId", getManifestDetail);

// Manifest loading (origin branch) - add packages to manifest
loaderRouter.post("/manifests/:manifestId/scan-in", scanPackageIn);
loaderRouter.delete("/manifests/:manifestId/packages/:packageId", removePackageFromManifest);
loaderRouter.post("/manifests/:manifestId/seal", sealManifest);
loaderRouter.post("/manifests/:manifestId/load-on-truck", loadManifestOnTruck);
loaderRouter.post("/manifests/:manifestId/depart", markManifestDeparted);

// Manifest unloading (destination branch) - remove packages from manifest
loaderRouter.post("/manifests/:manifestId/arrive", markManifestArrived);
loaderRouter.post("/manifests/:manifestId/scan-out", scanPackageOut);
loaderRouter.post("/manifests/:manifestId/re-manifest", remanifestPackage);
loaderRouter.post("/manifests/:manifestId/close", closeManifest);
loaderRouter.post("/manifests/:manifestId/discrepancy", flagDiscrepancy);


loaderRouter.get("/packages/to-manifest", getPackagesToManifest);
loaderRouter.get("/packages/to-manifest/grouped", getPackagesToManifestGroupedByDestination);

export default loaderRouter;