// Importing modules
import ApiError from "../utils/ApiError.util.js";
import HTTP_STATUS from "../constants/StatusCodes.constants.js";

// class for BadRequest error
class BadRequest extends ApiError {

    // constructor to initialize the error class
    constructor(message: string = "Bad Request") {

        // calling the parent class constructor
        super(HTTP_STATUS.BAD_REQUEST, message);

        // setting the message for the error
        this.message = message;

    }

}

export default BadRequest;
