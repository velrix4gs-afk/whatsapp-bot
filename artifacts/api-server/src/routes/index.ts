import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botRouter from "./bot";
import settingsRouter from "./settings";
import sessionsRouter from "./sessions";
import mediaRouter from "./media";

const router: IRouter = Router();

router.use(healthRouter);
router.use(botRouter);
router.use(settingsRouter);
router.use(sessionsRouter);
router.use(mediaRouter);

export default router;
