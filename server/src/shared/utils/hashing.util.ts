// Importing modules
import bcrypt from "bcryptjs";

// salt rounds
const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? "10", 10);

// function to hash the password
async function hashPassword(password: string) {

    // hashing the password using bcrypt
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // returning the hashed password
    return hashedPassword;

}

// function to compare the password
async function comparePassword(password: string, hashedPassword: string) {

    // comparing the password using bcrypt
    const isMatch = await bcrypt.compare(password, hashedPassword);

    // returning the result
    return isMatch;

}

export { hashPassword, comparePassword };
