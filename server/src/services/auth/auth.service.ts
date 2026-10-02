import bcrypt from "bcrypt";
import type { LoginInput, RegisterInput } from "../../validators/auth/auth.validator.js";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { eq } from "drizzle-orm";
import { createSession } from "./session.service.js";

export const registerUserWithEmail = async (data: RegisterInput) => {
  const { name, email, password } = data;
  const [existingUser] = await db.select().from(users).where(eq(users.email,email));
  if(existingUser) throw new AppError("user with this email already exists",409);
  const hashedPassword = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(users)
    .values({
      name,
      email,
      passwordHash: hashedPassword,
    })
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
    });
    if (!user) throw new AppError("Failed to create user record", 500);
  return user;
};

export const loginUserWithEmail = async (data : LoginInput) => {
    const [user] = await db.select().from(users).where(eq(users.email,data.email));

    if(!user) throw new AppError("User with this email does not exist",401);
    const isValidPassword = await bcrypt.compare(data.password,user.passwordHash);
    if(!isValidPassword)  throw new AppError("Invalid email or password", 401);
    const sessionId = await createSession(user.id);
    return {
      sessionId,
     user : {
      id : user.id,
      email : user.email,
      name : user.name
     }
    }
}