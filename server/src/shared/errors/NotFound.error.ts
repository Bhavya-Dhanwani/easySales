// Importing modules
import ApiError from "../utils/ApiError.util.js";
import HTTP_STATUS from "../constants/StatusCodes.constants.js";

// class for NotFound error
class NotFound extends ApiError {

    // constructor to initialize the error class
    constructor(message: string = "Resource Not Found") {

        // calling the parent class constructor
        super(HTTP_STATUS.NOT_FOUND, message);

        // setting the message for the error
        this.message = message;

    }

}

export default NotFound;
