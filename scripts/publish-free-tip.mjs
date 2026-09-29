// FREE_TIPS_SECRET=xxx SITE=https://oddsvig.com node scripts/publish-free-tip.mjs tips.json
import { readFileSync } from "node:fs";
const file = process.argv[2];
if (!file) { console.error("tips.json ver"); process.exit(1); }
const res = await fetch(`${process.env.SITE || "http://localhost:3001"}/api/free-tips/publish`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-publish-secret": process.env.FREE_TIPS_SECRET || "" },
  body: readFileSync(file, "utf8"),
});
console.log(res.status, await res.text());
