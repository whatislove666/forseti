// POST /api/advance {id}: does the step the market is waiting for (judge, finalize, relay), if due.
// GET /api/advance?all=1: the same for every unfinished market of ours (the scheduled job).
import { advance, advanceAll, endpoint, UserError } from './_lib/engine.mjs';

export default endpoint((input) => {
  if (input.all) return advanceAll();
  const id = Number(input.id);
  if (!Number.isInteger(id) || id < 0) throw new UserError('Give a market id.');
  return advance(id);
}, { perMinute: 30 });
