import mongoose from "mongoose";
import BranchModel from "../models/branch.model";

export async function findNearestBranch(
  coordinates: [number, number],
  companyId: mongoose.Types.ObjectId
): Promise<mongoose.Types.ObjectId | null> {
  const [lng, lat] = coordinates;
  
  const branches = await BranchModel.aggregate([
    {
      $geoNear: {
        near: {
          type: "Point",
          coordinates: [lng, lat]
        },
        distanceField: "distance",
        spherical: true,
        query: {
          companyId: companyId,
          status: "active",
          "location.coordinates": { $exists: true, $ne: [] }
        }
      }
    },
    { $limit: 1 },
    { $project: { _id: 1, distance: 1 } }
  ]);

  return branches[0]?._id || null;
}