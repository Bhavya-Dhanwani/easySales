// Importing modules
import Session from "../models/sessions.model.js";

// class to handle session data access operations
class SessionDao {

    SessionModel: typeof Session;

    constructor() {
        // initializing the session model
        this.SessionModel = Session;
    }

    // function to create a new session
    async createSession(sessionData: Record<string, unknown>) {
        const session = await this.SessionModel.create(sessionData);
        return session;
    }

    // function to find a session by refresh token
    async findSessionByRefreshTokenandSessionId(refreshToken: string, sessionId: string) {
        return await this.SessionModel.findOne({
            refreshToken: refreshToken,
            _id: sessionId
        }).populate("userId", "-password -__v");
    }

    // function to delete a session by refresh token
    async deleteSessionByRefreshTokenandSessionId(refreshToken: string, sessionId: string) {
        return await this.SessionModel.findOneAndDelete({
            refreshToken: refreshToken,
            _id: sessionId
        });
    }

    async deleteSessionByUserId(userId: unknown) {
        return await this.SessionModel.deleteMany({
            userId: userId
        });
    }

    async updateSessionByRefreshTokenandSessionId(refreshToken: string, sessionId: string, updateData: Record<string, unknown>) {
        return await this.SessionModel.findOneAndUpdate({
            refreshToken: refreshToken,
            _id: sessionId
        }, updateData, { returnDocument: "after" });
    }

    async findById(id: string) {
        return await this.SessionModel.findById(id).populate("userId");
    }
}

export default SessionDao;
