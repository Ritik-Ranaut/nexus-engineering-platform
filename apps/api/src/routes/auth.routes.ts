import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { getProfile, login, logout, register } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many authentication attempts" } }
});

router.post("/register", authRateLimit, register);
router.post("/login", authRateLimit, login);
router.get("/me", requireAuth, getProfile);
router.post("/logout", requireAuth, logout);

export default router;
