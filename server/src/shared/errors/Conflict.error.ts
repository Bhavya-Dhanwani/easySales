// Importing modules
import ApiError from "../utils/ApiError.util.js";
import HTTP_STATUS from "../constants/StatusCodes.constants.js";

// class for Conflict error
class Conflict extends ApiError {

    // constructor to initialize the error class
    constructor(message: string = "Resource Conflict") {

        // calling the parent class constructor
        super(HTTP_STATUS.CONFLICT, message);

        // setting the message for the error
        this.message = message;

    }

}

export default Conflict;
