import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth.routes.js"
import { env } from "./config/env.js";
const app = express();

const PORT = Number(env.PORT ?? 4000);

app.use(cors({
    origin: "http://localhost:5173",
    credentials: true,
  }),
);

app.use(express.json());
app.use(cookieParser(env.COOKIE_SECRET));


app.get("/api/v1/health", (_req, res) => {
  res.status(200).json({
    success: true,
    service: "deploybench-api",
    status: "healthy",
  });
});

app.use("/api/v1/auth", authRouter)


app.listen(PORT, () => {
  console.log(`DeployBench API running on http://localhost:${PORT}`);
});