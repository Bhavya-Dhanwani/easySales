// Importing modules
import { Response } from "express";
import ApiResponse from "../utils/ApiResponse.util.js";
import HTTP_STATUS from "../constants/StatusCodes.constants.js";

// function to send the API response
function Created<T = unknown>(res: Response, message: string = "Resource Created Successfully", data: T | null = null) {

    // sending the response with status code, message and data
    return ApiResponse(res, HTTP_STATUS.CREATED, message, data);

}

export default Created;
