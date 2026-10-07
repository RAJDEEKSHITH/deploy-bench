import axios from "./axios";

import type {
  AuthResponse,
  LoginInput,
  RegisterInput,
  User,
} from "../types/auth";

export const register = async (
  data: RegisterInput,
): Promise<AuthResponse> => {
  const response = await axios.post<AuthResponse>(
    "/auth/register",
    data,
  );

  return response.data;
};

export const login = async (
  data: LoginInput,
): Promise<AuthResponse> => {
  const response = await axios.post<AuthResponse>(
    "/auth/login",
    data,
  );

  return response.data;
};

export const getCurrentUser = async (): Promise<User> => {
  const response = await axios.get<AuthResponse>(
    "/auth/me",
  );

  return response.data.data.user;
};

export const logout = async (): Promise<void> => {
  await axios.post("/auth/logout");
};