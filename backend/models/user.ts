import jwt from "jsonwebtoken";
import { Database } from "../database";
import { generatePasswordHash, shake256, SHAKE256_LENGTH } from "../password-hash";

interface UserRow {
    id: number;
    username: string;
    password: string;
    active: number;
    timezone?: string | null;
    twofa_secret?: string | null;
    twofa_status: number;
    twofa_last_token?: string | null;
}

export class User {
    id!: number;
    username!: string;
    password!: string;
    active!: number;
    timezone?: string | null;
    twofa_secret?: string | null;
    twofa_status!: number;
    twofa_last_token?: string | null;

    constructor(row?: Partial<UserRow>) {
        if (row) {
            Object.assign(this, row);
        }
    }

    private static fromRow(row?: UserRow | null) : User | null {
        return row ? new User(row) : null;
    }

    static async findFirst() : Promise<User | null> {
        const row = await Database.getKnex()("user").first();
        return User.fromRow(row);
    }

    static async findByUsername(username: string, activeOnly = true) : Promise<User | null> {
        const query = Database.getKnex()("user").where("username", username);
        if (activeOnly) {
            query.where("active", 1);
        }
        return User.fromRow(await query.first());
    }

    static async findById(id: number, activeOnly = true) : Promise<User | null> {
        const query = Database.getKnex()("user").where("id", id);
        if (activeOnly) {
            query.where("active", 1);
        }
        return User.fromRow(await query.first());
    }

    /**
     * Reset user password
     * Fix #1510, as in the context reset-password.js, there is no auto model mapping. Call this static function instead.
     * @param {number} userID ID of user to update
     * @param {string} newPassword Users new password
     * @returns {Promise<void>}
     */
    static async resetPassword(userID : number, newPassword : string) {
        await User.updatePassword(userID, newPassword);
    }

    static async updatePassword(userID : number, password : string) {
        await Database.getKnex()("user")
            .where("id", userID)
            .update({
                password: generatePasswordHash(password),
            });
    }

    /**
     * Reset this users password
     * @param {string} newPassword
     * @returns {Promise<void>}
     */
    async resetPassword(newPassword : string) {
        await User.resetPassword(this.id, newPassword);
        this.password = generatePasswordHash(newPassword);
    }

    /**
     * Create a new JWT for a user
     * @param {User} user The User to create a JsonWebToken for
     * @param {string} jwtSecret The key used to sign the JsonWebToken
     * @returns {string} the JsonWebToken as a string
     */
    static createJWT(user : User, jwtSecret : string) {
        return jwt.sign({
            username: user.username,
            h: shake256(user.password, SHAKE256_LENGTH),
        }, jwtSecret);
    }

}

export default User;
