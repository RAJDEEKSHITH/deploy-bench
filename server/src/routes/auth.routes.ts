import {Router} from "express"
import * as authController from "../controllers/auth.controller.js"
import { authenticate } from "../middlewares/auth.middleware.js";
import { validateBody } from "../middlewares/validate.middleware.js";
import { loginSchema, registerSchema } from "../validators/auth.validator.js";

const router = Router();
// baseURL = api/v1/auth

router.post("/login",validateBody(loginSchema),authController.login)
router.post("/register",validateBody(registerSchema),authController.register)

router.get("/me",authenticate,authController.getCurrentUser)
router.post("/logout",authenticate,authController.logout)
router.post("/logout-all",authenticate,authController.logoutAll)
export default router;