import axios from "axios";

export const BASE_URL =
  (import.meta.env.VITE_BACKEND_BASE_URL as string | undefined) ??
  "http://localhost:4000/api/v1";

const axiosInstance = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
});

export default axiosInstance;