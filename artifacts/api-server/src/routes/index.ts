import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import videosRouter from "./videos";
import searchRouter from "./search";
import chatsRouter from "./chats";
import voiceRouter from "./voice";
import reviewRouter from "./review";
import peopleRouter from "./people";
import statsRouter from "./stats";
import sourcesRouter from "./sources";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);

// Everything below this line requires a real logged-in session (server-side
// check — not a frontend-only guard).
router.use(requireAuth);
router.use(videosRouter);
router.use(searchRouter);
router.use(chatsRouter);
router.use(voiceRouter);
router.use(reviewRouter);
router.use(peopleRouter);
router.use(statsRouter);
router.use(sourcesRouter);

export default router;
