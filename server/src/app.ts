import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth.routes.js"
import projectRouter from "./routes/project.routes.js";
import githubIntegrationsRouter from "./routes/github-integration.routes.js"
import { env } from "./config/env.js";
import { errorHandler } from "./middlewares/error.middleware.js";
const app = express();

const PORT = Number(env.PORT ?? 4000);

app.use(cors({
    origin: "*",
    credentials: true,
  }),
);
app.use("/api/v1/webhooks", express.raw({ type: "application/json" }));
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
app.use("/api/v1/projects", projectRouter);
app.use("/api/v1/projects",githubIntegrationsRouter);
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`DeployBench API running on http://localhost:${PORT}`);
});