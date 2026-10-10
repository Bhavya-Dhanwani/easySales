// Importing modules
import ApiError from "../utils/ApiError.util.js";
import HTTP_STATUS from "../constants/StatusCodes.constants.js";

// class for Unauthorized error
class Unauthorized extends ApiError {

    // constructor to initialize the error class
    constructor(message: string = "Unauthorized Access") {

        // calling the parent class constructor
        super(HTTP_STATUS.UNAUTHORIZED, message);

        // setting the message for the error
        this.message = message;

    }

}

export default Unauthorized;
