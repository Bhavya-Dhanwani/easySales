// Importing modules
import ApiError from "../utils/ApiError.util.js";
import HTTP_STATUS from "../constants/StatusCodes.constants.js";

// class for Forbidden error
class Forbidden extends ApiError {

    // constructor to initialize the error class
    constructor(message: string = "Access Forbidden") {

        // calling the parent class constructor
        super(HTTP_STATUS.FORBIDDEN, message);

        // setting the message for the error
        this.message = message;

    }

}

export default Forbidden;
