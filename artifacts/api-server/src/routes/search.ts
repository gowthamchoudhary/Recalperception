import { Router, type IRouter } from "express";
import {
  SearchMemoriesQueryParams,
  SearchMemoriesResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import {
  runSearchPipeline,
  SearchUnavailableError,
} from "../lib/searchPipeline";

const router: IRouter = Router();

router.get("/search", async (req, res): Promise<void> => {
  const parsed = SearchMemoriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const out = await runSearchPipeline({
      userId: currentUserId(req),
      query: parsed.data.q,
    });
    res.json(
      SearchMemoriesResponse.parse({
        results: out.results,
        personFilter: out.personFilter,
        intent: out.intent,
        answer: out.answer,
      }),
    );
  } catch (err) {
    if (err instanceof SearchUnavailableError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
