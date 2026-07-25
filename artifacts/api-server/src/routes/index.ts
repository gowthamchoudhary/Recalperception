import { Router, type IRouter } from "express";
import healthRouter from "./health";
import videosRouter from "./videos";
import searchRouter from "./search";
import reviewRouter from "./review";
import peopleRouter from "./people";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(videosRouter);
router.use(searchRouter);
router.use(reviewRouter);
router.use(peopleRouter);
router.use(statsRouter);

export default router;
