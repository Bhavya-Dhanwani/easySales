// Importing modules
import Token from "../models/token.model.js";

// class for the Token Data Access Object (DAO)
class TokenDAO {

    tokenModel: typeof Token;

    constructor() {
        this.tokenModel = Token;
    }

    // method to create a new token
    async createToken(tokenData: Record<string, unknown>) {
        const token = await this.tokenModel.create(tokenData);
        return token;
    }

    // method to find a token by its value
    async findTokenByValue(value: string) {
        const token = await this.tokenModel.findOne({ value: value });
        return token;
    }

    // method to delete a token by its value
    async deleteTokenByValue(value: string) {
        const result = await this.tokenModel.deleteOne({ value: value });
        return result;
    }

    // method to delete a token by its email and type
    async deleteTokenByEmail(email: string, type: string) {
        const result = await this.tokenModel.deleteMany({ email: email, type: type });
        return result;
    }
}

export default TokenDAO;
