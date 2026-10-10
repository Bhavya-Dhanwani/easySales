// Importing modules
import express, { Request, Response } from "express";
import Ok from "../responses/Ok.response.js";

// Making the express router
const router = express.Router();

/*
    @route GET /api/health
    @desc checks server health
    @access Public
*/
router.get("/", (req: Request, res: Response) => {

    // sending Ok as response
    return Ok(res, "Server is healthy", {
        status: "UP",
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });

});

// exporting the router
export default router;
