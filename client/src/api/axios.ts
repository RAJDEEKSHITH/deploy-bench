import axios from "axios";

const BASE_URL = import.meta.env.VITE_BACKEND_BASE_URL as string;

const axiosInstance = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
});

export default axiosInstance