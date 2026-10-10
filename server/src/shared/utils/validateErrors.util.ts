// Importing modules
import { validationResult } from "express-validator";
import { Request, Response, NextFunction } from "express";
import BadRequest from "../errors/BadRequest.error.js";

// function to validate errors from the request
export const validateErrors = (req: Request, res: Response, next: NextFunction) => {

    // getting the errors from the request
    const errors = validationResult(req);

    // if there are errors, throw a bad request error with the first error message
    if (!errors.isEmpty()) {

        // getting the first error message
        const firstError = errors.array()[0];

        // throwing a bad request error with the first error message
        throw new BadRequest(firstError.msg);
    }

    // if there are no errors, call the next middleware
    next();
};

export default validateErrors;
