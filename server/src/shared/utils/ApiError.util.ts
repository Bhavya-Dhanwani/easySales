// Extending the Error class to create a custom error class for API errors
class ApiError extends Error {

    statusCode: number;
    data: unknown;

    constructor(statusCode: number, message: string, data: unknown = null) {

        // calling the parent constructor
        super(message);

        // setting the status code and other properties
        this.statusCode = statusCode;
        this.message = message;
        this.data = data;

    }

}

export default ApiError;
