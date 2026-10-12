// Importing modules
import mongoose from "mongoose";

// read position of the platform reply inbox (one document; not tenant data: it holds no mail)
const platformInboxSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    uidValidity: String,
    lastUid: { type: Number, default: 0 },
    lastPolledAt: Date,
    lastError: String,
}, { timestamps: true });

const PlatformInbox = mongoose.model("PlatformInbox", platformInboxSchema);

export default PlatformInbox;
