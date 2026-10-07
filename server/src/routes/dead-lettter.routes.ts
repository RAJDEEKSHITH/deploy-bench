import { Router } from "express";

import {
  getDeadLetterRecord,
  listDeadLetterRecords,
  replayDeadLetterRecord,
  resolveDeadLetterRecord,
} from "../controllers/dead-letter.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";

// Base path: /api/v1/dead-letters

const router = Router();

router.use(authenticate);

/*
|--------------------------------------------------------------------------
| List dead letters
|--------------------------------------------------------------------------
*/

router.get(
  "/",
  listDeadLetterRecords,
);

/*
|--------------------------------------------------------------------------
| Get one dead letter
|--------------------------------------------------------------------------
*/

router.get(
  "/:deadLetterId",
  getDeadLetterRecord,
);

/*
|--------------------------------------------------------------------------
| Replay
|--------------------------------------------------------------------------
*/

router.post(
  "/:deadLetterId/replay",
  replayDeadLetterRecord,
);

/*
|--------------------------------------------------------------------------
| Resolve a successful replay
|--------------------------------------------------------------------------
*/

router.post(
  "/:deadLetterId/resolve",
  resolveDeadLetterRecord,
);

export default router;
