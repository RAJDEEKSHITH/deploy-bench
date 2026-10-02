import {Router} from "express"
import * as authController from "../controllers/auth.controller.js"
import { authenticate } from "../middlewares/auth.middleware.js";

const router = Router();
// baseURL = api/v1/auth

router.post("/login",authController.login)
router.post("/register",authController.register)

router.get("/me",authenticate,authController.getCurrentUser)
router.post("/logout",authenticate,authController.logout)
router.post("/logout-all",authenticate,authController.logoutAll)
export default router;