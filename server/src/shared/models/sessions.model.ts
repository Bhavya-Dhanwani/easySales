// Importing modules
import mongoose from "mongoose";

// creating the schema for the session
const sessionSchema = new mongoose.Schema({

    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },

    refreshToken: {
        type: String,
        required: true,
    },

    expiresAt: {
        type: Date,
        required: true,
        index: {
            expires: 0,
        }
    }

});

// making the model for the session schema
const Session = mongoose.model("Session", sessionSchema);

// exporting the session model
export default Session;
