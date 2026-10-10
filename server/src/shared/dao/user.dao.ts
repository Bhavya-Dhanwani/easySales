// Importing modules 
import User from "../../shared/models/user.model.js";

// class to handle user data access operations
class UserDao {

    UserModel: typeof User;

    constructor() {
        // initializing the user model
        this.UserModel = User;
    }

    // function to create a new user
    async createUser(userData: Record<string, unknown>) {
        const user = await this.UserModel.create(userData);
        return user;
    }

    // function to find a user by email
    async findUserByEmail(email: string) {
        return await this.UserModel.findOne({ email });
    }

    // function to find a user by id
    async findUserById(id: string) {
        return await this.UserModel.findById(id);
    }

    // function to update a user by id
    async updateUserById(id: string, updateData: Record<string, unknown>) {
        return await this.UserModel.findByIdAndUpdate(id, updateData, { returnDocument: "after" });
    }

    // function to delete a user by id
    async deleteUserById(id: string) {
        return await this.UserModel.findByIdAndDelete(id);
    }
}

export default UserDao;
