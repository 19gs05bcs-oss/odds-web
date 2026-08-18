import "server-only";
import { sql } from "@/lib/db";

export type QuotaResult = {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
};

/**
 * Kullanıcının bugünkü (UTC) arama sayacını atomik olarak okuyup, limit
 * altındaysa +1 artırır. Row-level lock (FOR UPDATE) ile aynı kullanıcının
 * eşzamanlı istekleri güvenli — limit üstü tekrar denemeler sayaç şişirmez.
 */
export async function consumeSearchQuota(
  userId: string,
  limit: number,
): Promise<QuotaResult> {
  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO search_usage (user_id, usage_date, count)
      VALUES (${userId}, CURRENT_DATE, 0)
      ON CONFLICT (user_id, usage_date) DO NOTHING
    `;

    const [row] = await tx<{ count: number }[]>`
      SELECT count FROM search_usage
      WHERE user_id = ${userId} AND usage_date = CURRENT_DATE
      FOR UPDATE
    `;
    const used = row?.count ?? 0;

    if (used >= limit) {
      return { allowed: false, used, limit, remaining: 0 };
    }

    const [updated] = await tx<{ count: number }[]>`
      UPDATE search_usage
      SET count = count + 1
      WHERE user_id = ${userId} AND usage_date = CURRENT_DATE
      RETURNING count
    `;
    const nextUsed = updated?.count ?? used + 1;
    return {
      allowed: true,
      used: nextUsed,
      limit,
      remaining: Math.max(0, limit - nextUsed),
    };
  });
}
