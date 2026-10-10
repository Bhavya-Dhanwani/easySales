// Function to send API response
import { Response } from "express";

function ApiResponse<T = unknown>(res: Response, statusCode: number, message: string, data: T | null = null) {

    // sending the response
    return res.status(statusCode).json({
        success: true,
        status: statusCode,
        message: message,
        data: data
    });

}

export default ApiResponse;
