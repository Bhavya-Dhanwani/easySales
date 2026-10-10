// function to sanitize the user data
function sanitizeUser(user: Record<string, unknown> | null | undefined) {

    // if user is null or undefined, return null
    if (!user) {
        return null;
    }

    // return sanitized user object
    const u = (user as Record<string, unknown>);
    return {
        _id: u._id,
        name: u.name,
        email: u.email,
        isVerified: u.isVerified,
    };

}

export default sanitizeUser;
