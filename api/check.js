// POST /api/check {question, rules, sources}: the judge reviews the wording, and three sealed
// models answer the draft as if trading closed now (only with a source). Every answer comes back TEE-signed.
import { check, endpoint, readDraft } from './_lib/engine.mjs';

export default endpoint((input) => check(readDraft(input, { needSource: false })), { perMinute: 4 });
