import * as z from "zod";

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "Name must be atleast 3 characters")
    .max(50, "Name must not exceed 50 characters"),
  email: z.email("Please enter a valid email address").toLowerCase(),
  password: z
    .string()
    .min(5, "Password must be atleast 5 characters")
    .max(100, "Password is too long"),
});

const loginSchema = z.object({
  email: z.email("Please enter a valid email address").toLowerCase(),
  password: z
    .string()
    .min(5, "Password must be atleast 5 characters")
    .max(100, "Password is too long"),
});

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>