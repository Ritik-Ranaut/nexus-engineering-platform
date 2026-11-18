import { Router } from "express";
import { health, playground } from "../controllers/ai.controller.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();
router.get("/health", requireAuth, health);
if (env.NODE_ENV !== "production") router.post("/playground", requireAuth, playground);

export default router;
