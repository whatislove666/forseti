// POST /api/create {question, rules, sources}: seals the market on NEAR through the demo relay
// account, with trading closing in 2 minutes. Returns {id, tx}.
import { create, endpoint, readDraft } from './_lib/engine.mjs';

export default endpoint((input) => create(readDraft(input)), { perMinute: 3 });
