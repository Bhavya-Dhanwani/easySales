// Importing modules
import mongoose from "mongoose";

// Defining the schema for the Token model
const tokenSchema = new mongoose.Schema({

    email: {
        type: String,
        required: false,
    },

    type: {
        type: String,
        required: true,
        enum: ['otp', 'reset', 'invitation']
    },

    value: {
        type: String,
        required: true,
        unique: true
    },

    expiresAt: {
        type: Date,
        required: true,
        index: {
            expires: 0
        }
    }

});

// Making the model for the Token schema
const Token = mongoose.model("Token", tokenSchema);

export default Token;
