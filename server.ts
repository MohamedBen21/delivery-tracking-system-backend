import {app} from "./app";
import connectDB from "./utils/db";
require ("dotenv").config();
import {v2 as cloudinary} from "cloudinary";

// cloudinary.config({
//     cloud_name: process.env.CLOUD_NAME,
//     api_key: process.env.CLOUD_API_KEY,
//     api_secret: process.env.CLOUD_SECRET_KEY
// });

const port = process.env.PORT || 8080;
const server = app.listen(port,()=>{
    console.log(`app is running on port ${port}`);
    // connectDB();
});

process.on("SIGINT", () => {
    server.close(() => {
        console.log("Server closed correctly.");
        process.exit(0);
    });
});

process.on("SIGTERM", () => {
    server.close(() => {
        console.log("Server closed correctly.");
        process.exit(0);
    });
});