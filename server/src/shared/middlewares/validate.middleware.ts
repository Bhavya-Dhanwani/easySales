// Importing modules
import { Request, Response, NextFunction } from "express";
import { ZodTypeAny } from "zod";
import BadRequest from "../errors/BadRequest.error.js";

// validates and replaces req.body with the parsed (stripped, coerced) value
function validate(schema: ZodTypeAny) {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body ?? {});
        if (!result.success) {
            const issue = result.error.issues[0];
            throw new BadRequest(`${issue.path.join(".") || "body"}: ${issue.message}`);
        }
        req.body = result.data;
        next();
    };
}

export default validate;
